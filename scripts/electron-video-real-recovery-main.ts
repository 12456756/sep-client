import '../electron/common/undici-polyfill'
import { app, BrowserWindow, session, shell } from 'electron'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { VideoStore } from '../electron/data/video-store'
import { exportVideoBytes } from '../electron/data/native-video-export'
import { MockVideoHostService } from '../electron/service/mock-video-host-service'
import type { MockVideoHostGateway } from '../electron/service/mock-video-host-service'
import { AppError } from '../electron/errors/app-error'
import { registerRoutes } from '../electron/controller/router'
import { videoRoutes } from '../electron/controller/routes/video'
import { INVOKE_CHANNELS } from '../electron/controller/channels'
import type { RequestContext } from '../electron/controller/request-context'
import { setLogSink } from '../electron/common/logger'
import { installShutdownHandler } from '../electron/bootstrap/shutdown'
import { recoveryFixtureSchema, recoveryIdentity } from './electron-video-real-recovery-policy'

const profile = process.env.SEP_VIDEO_REAL_RECOVERY_PROFILE
const fixturePath = process.env.SEP_VIDEO_REAL_RECOVERY_FIXTURE
const phase = process.env.SEP_VIDEO_REAL_RECOVERY_PHASE
if (app.isPackaged || process.env.SEP_VIDEO_REAL_RECOVERY_HARNESS !== '1' || !profile || !isAbsolute(profile) ||
  !profile.startsWith('/private/tmp/sep-electron-video-real-recovery-') || !fixturePath || !isAbsolute(fixturePath) ||
  !['initial', 'restart'].includes(phase ?? '') || process.env.SEP_MCP_CONFIG || process.env.ELECTRON_RENDERER_URL ||
  process.env.SEP_PLAYWRIGHT_MCP !== '0') throw new Error('EXPLICIT_ISOLATED_VIDEO_RECOVERY_REQUIRED')
app.setPath('userData', profile)
setLogSink(() => undefined)
// No network transport is captured, so neither an allowed GET nor a POST can leave this process.
const audit = { networkRequestsSent: 0, forbiddenFetchAttempts: 0, rendererDenied: 0,
  approvals: 0, nativePreview: [] as { jobId: string; outputId: string; sha256: string; mode: string; dispatched: boolean }[] }
globalThis.fetch = (async () => { audit.forbiddenFetchAttempts++; throw new Error('OFFLINE_VIDEO_RECOVERY') }) as typeof fetch

async function start() {
  const stat = await lstat(profile!)
  const fixtureStat = await lstat(fixturePath!)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 || await realpath(profile!) !== resolve(profile!) ||
    !fixtureStat.isFile() || fixtureStat.isSymbolicLink() || fixtureStat.nlink !== 1 || fixtureStat.size > 1024 * 1024 ||
    (fixtureStat.mode & 0o077) !== 0 || fixtureStat.uid !== process.getuid?.()) throw new Error('INVALID_PRIVATE_FIXTURE')
  const fixture = recoveryFixtureSchema.parse(JSON.parse(await readFile(fixturePath!, 'utf8')))
  const store = new VideoStore(profile!)
  const hosts = new Map<string, MockVideoHostService>()
  for (const item of fixture.tasks) {
    const persisted = await store.listJobs(item.scope)
    if (persisted.length !== 1 || !isDeepStrictEqual(recoveryIdentity(persisted[0]), recoveryIdentity(item.job))) throw new Error('ORIGINAL_IDENTITY_MISMATCH')
    for (const output of item.job.receipt!.outputs) await store.readAsset(item.scope, item.taskId, item.job.jobId, output.outputId)
    const offlineGateway = new Proxy({}, { get: () => async () => { audit.forbiddenFetchAttempts++; throw new Error('GATEWAY_DISABLED') } })
    const host = new MockVideoHostService({ mock: false, scope: { currentScope: () => item.scope }, store,
      getTask: async id => id === item.taskId ? { subscriptionId: item.scope.subscriptionId } : null,
      // Captured real runtime snapshot is an explicit local test seam, not fresh production authorization.
      authorize: async subscriptionId => {
        if (subscriptionId !== item.scope.subscriptionId) throw new AppError('PERMISSION_DENIED')
        return structuredClone(item.runtime)
      }, authorizationRevision: () => 0,
      gateway: () => offlineGateway as MockVideoHostGateway,
      readReference: async () => { throw new AppError('PERMISSION_DENIED') },
      requestApproval: async () => { audit.approvals++; throw new AppError('PERMISSION_DENIED') },
      openOutput: async (scope, taskId, jobId, outputId, signal, validate) => {
        signal.throwIfAborted(); validate()
        const path = await store.verifiedAssetPath(scope, taskId, jobId, outputId)
        const bytes = await store.readAsset(scope, taskId, jobId, outputId)
        signal.throwIfAborted(); validate()
        const actual = process.env.SEP_VIDEO_REAL_RECOVERY_OPEN_NATIVE === '1'
        const result = actual ? await shell.openPath(path) : ''
        audit.nativePreview.push({ jobId, outputId, sha256: createHash('sha256').update(bytes).digest('hex'),
          mode: actual ? 'shell.openPath' : 'recorded-native-dispatch-only', dispatched: actual && result === '' })
        if (result) throw new AppError('INTERNAL_ERROR')
      },
      exportOutput: async (scope, taskId, jobId, outputId, path, signal, validate) => {
        const bytes = await store.readAsset(scope, taskId, jobId, outputId)
        await exportVideoBytes(profile!, path, bytes, signal, validate)
      },
    })
    hosts.set(item.taskId, host)
  }
  const multiplexed = new Proxy({}, { get: (_target, method) => (taskId: string, ...args: unknown[]) => {
    const host = hosts.get(taskId)
    if (!host) throw new AppError('PERMISSION_DENIED')
    const fn = Reflect.get(host, method)
    if (typeof fn !== 'function') throw new AppError('PERMISSION_DENIED')
    return Reflect.apply(fn, host, [taskId, ...args])
  } }) as MockVideoHostService
  await app.whenReady()
  const rendererFile = join(__dirname, '../renderer/index.html')
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    const path = decodeURIComponent(url.pathname)
    const allowed = details.method === 'GET' && url.protocol === 'file:' && !url.host &&
      (path === rendererFile || path.startsWith(join(__dirname, '../renderer/assets/')))
    if (!allowed) audit.rendererDenied++
    callback({ cancel: !allowed })
  })
  const window = new BrowserWindow({ width: 1180, height: 1050, show: true, title: '真实视频原任务离线恢复验收',
    webPreferences: { preload: join(__dirname, '../preload/preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  const allowed = new Set<string>([INVOKE_CHANNELS.VIDEO_GET_TASK, INVOKE_CHANNELS.VIDEO_GET_REFERENCES,
    INVOKE_CHANNELS.VIDEO_PREVIEW, INVOKE_CHANNELS.VIDEO_EXPORT])
  const context = { video: multiplexed, window: () => window } as unknown as RequestContext
  registerRoutes(context, { routes: videoRoutes.map(entry => allowed.has(entry.channel) ? entry : {
    ...entry, handle: async () => { throw new AppError('PERMISSION_DENIED') },
  }), listeners: [] })
  const identities = async () => Promise.all(fixture.tasks.map(async item => recoveryIdentity((await store.listJobs(item.scope))[0])))
  installShutdownHandler({ stop: async () => {
    await Promise.all([...hosts.values()].map(host => host.stopAll()))
    await writeFile(join(profile!, `shutdown-${phase}.json`), JSON.stringify({ completed: true, identities: await identities() }), { flag: 'wx', mode: 0o600 })
  } })
  Object.assign(globalThis, { __sepVideoRealRecovery: {
    summary: async () => ({ phase, identities: await identities(), audit: structuredClone(audit),
      authorization: 'captured-real-runtime-offline-test-seam', provesPiFlow: false, provesProductionAuthorization: false,
      nativePlaybackObserved: false, previewVerification: 'OS-openPath-success-not-player-frame-observation' }),
    shutdown: () => { setImmediate(() => app.quit()); return true },
  } })
  const search = new URLSearchParams()
  fixture.tasks.forEach(item => search.append('taskId', item.taskId))
  await window.loadFile(rendererFile, { search: search.toString() })
}
void start().catch(() => { process.stderr.write('ISOLATED_VIDEO_RECOVERY_START_FAILED\n'); app.exit(1) })
app.on('window-all-closed', () => app.quit())
