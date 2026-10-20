import '../electron/common/undici-polyfill'
import { app, BrowserWindow, session } from 'electron'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { MediaStore } from '../electron/data/media-store'
import { VideoStore } from '../electron/data/video-store'
import { SepMockVideoGateway } from '../electron/data/sep-video-media-gateway'
import { exportVideoBytes } from '../electron/data/native-video-export'
import { MockVideoHostService } from '../electron/service/mock-video-host-service'
import { ToolApprovals } from '../electron/runtime/run-approvals'
import { RendererBridge } from '../electron/bootstrap/renderer-bridge'
import { registerRoutes } from '../electron/controller/router'
import { videoRoutes } from '../electron/controller/routes/video'
import { systemListeners } from '../electron/controller/routes/system'
import type { RequestContext } from '../electron/controller/request-context'
import type { MediaAssetView } from '../src/shared/media'
import type { LocalMediaAsset } from '../electron/domain/media'
import type { VideoScope } from '../electron/domain/video-media'
import { AppError } from '../electron/errors/app-error'
import { isMediaMockRendererRequestAllowed } from './electron-media-mock-policy.mjs'
import * as fixture from '../src/shared/fixtures/media-video-v1.json'
import { videoGenerationInputSchema } from '../src/shared/video-host'
import type { PiAgentSession } from '../electron/pi/sdk/pi-agent-runtime'
import { createPiVideoModelMock, PI_VIDEO_MODEL_MOCK_PROMPT, type PiVideoModelMock } from './pi-video-model-mock'

// This file is only bundled by the explicit mock test config, never electron/main.ts.
const profile = process.env.SEP_ELECTRON_VIDEO_PROFILE
const url = new URL(process.env.SEP_ELECTRON_VIDEO_URL ?? 'invalid:')
if (app.isPackaged || process.env.SEP_ELECTRON_VIDEO_MOCK !== 'true' || !profile || !isAbsolute(profile)
  || !profile.includes('sep-electron-video-mock-') || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
  || url.pathname !== '/api' || url.username || url.password || url.search || url.hash
  || process.env.SEP_MCP_CONFIG || process.env.ELECTRON_RENDERER_URL) throw new Error('Isolated explicit video mock configuration required.')
app.setPath('userData', profile)
const nativeFetch = globalThis.fetch
let blocked = 0, rendererBlocked = 0, revision = 1, granted = true
let disconnected = false
const requests: Record<string, number> = {}
const mockCompletion = 'http://127.0.0.1:1/video-pi-mock/chat/completions'
let piModel: PiVideoModelMock | undefined
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const requestUrl = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (requestUrl.href === mockCompletion && piModel && init?.method === 'POST' && typeof init.body === 'string') {
    return piModel.respond(JSON.parse(init.body) as unknown)
  }
  if (requestUrl.origin !== url.origin || !requestUrl.pathname.startsWith('/api/gateway/v1/media/video/')) {
    blocked++; throw new Error('External requests disabled in video mock.')
  }
  if (disconnected) throw new AppError('NETWORK_ERROR')
  requests[requestUrl.pathname] = (requests[requestUrl.pathname] ?? 0) + 1
  return nativeFetch(input, { ...init, redirect: 'error' })
}) as typeof fetch

function assetView(asset: LocalMediaAsset): MediaAssetView {
  return { localAssetId: asset.localAssetId, taskId: asset.taskId, jobId: null, outputId: null, source: 'reference',
    mime: asset.mime, size: asset.size, width: asset.width, height: asset.height, status: asset.status }
}
const referenceOwner = (scope: VideoScope) => ({ enterpriseId: scope.enterpriseId, memberId: scope.memberId })

app.whenReady().then(async () => {
  await mkdir(profile, { recursive: true })
  if (await realpath(profile) !== resolve(profile)) throw new Error('Mock profile must not contain symlinks.')
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isMediaMockRendererRequestAllowed(details.url)
    if (!allowed) rendererBlocked++
    callback({ cancel: !allowed })
  })
  const bridge = new RendererBridge()
  const approvals = new ToolApprovals({ onRequest: request => bridge.approvalRequest(request) })
  const scope: VideoScope = { enterpriseId: 'video-mock-enterprise', memberId: 'video-mock-member', subscriptionId: 'video-mock-subscription' }
  const media = new MediaStore(profile), store = new VideoStore(profile)
  const gateway = new SepMockVideoGateway({ mock: true, baseUrl: url.href, subscriptionId: scope.subscriptionId, token: async () => 'synthetic-video-employment-token' })
  const host = new MockVideoHostService({ mock: true,
    scope: { currentScope: () => ({ enterpriseId: scope.enterpriseId, memberId: scope.memberId }) }, store,
    getTask: async id => id === 'video-task-a' ? { subscriptionId: scope.subscriptionId } : null,
    authorize: async (_subscriptionId, signal) => {
      if (!granted) throw new AppError('PERMISSION_DENIED')
      // Fetch current runtime profile through the same mock HTTP adapter used by SEP.
      const profiles = await gateway.profiles(signal)
      return { ...fixture.runtime, profiles: profiles.profiles }
    }, authorizationRevision: () => revision,
    localAuthorizationRevision: () => 1,
    recoveryAuthorizationRevision: () => revision,
    authorizeRecovery: async () => {
      if (!granted) throw new AppError('PERMISSION_DENIED')
      if (disconnected) throw new AppError('NETWORK_ERROR')
    },
    gateway: () => gateway,
    readReference: async (owner, taskId, id) => {
      const bytes = await media.readAsset(referenceOwner(owner), taskId, id)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
    references: {
      list: async (owner, taskId) => (await media.listAssets(referenceOwner(owner), taskId)).filter(a => a.source === 'reference').map(assetView),
      import: async (owner, taskId, paths, signal, validate) => {
        const result: MediaAssetView[] = []
        for (const path of paths) { signal.throwIfAborted(); validate(); result.push(assetView(await media.importReference(referenceOwner(owner), taskId, path, signal, validate))) }
        validate(); return result
      },
    },
    exportOutput: async (owner, taskId, jobId, outputId, path, signal, validate) => {
      const bytes = await store.readAsset(owner, taskId, jobId, outputId)
      await exportVideoBytes(profile, path, bytes, signal, validate)
    },
    requestApproval: input => approvals.request(input), tracker: { floorMs: 300, maxAttempts: 12, budgetMs: 30_000 },
  })
  let piSession: PiAgentSession | undefined
  let piRun: Promise<void> | undefined
  let shuttingDown = false
  let piStatus: 'idle' | 'running' | 'complete' | 'failed' = 'idle'
  let piEvents = 0
  const runPi = async (value: unknown) => {
    if (piStatus === 'running') throw new AppError('CONFLICT')
    const input = videoGenerationInputSchema.parse(value)
    piStatus = 'running'
    try {
      piModel = createPiVideoModelMock({ generationInput: input })
      const workspace = join(profile, 'mock-workspace'), skill = join(workspace, 'skills', 'video-mock', 'SKILL.md')
      await mkdir(join(workspace, 'skills', 'video-mock'), { recursive: true })
      // A local fixture exercises Pi loading. It is not a published/approved employee Skill.
      await writeFile(skill, '---\nname: video-mock\ndescription: Isolated video mock workflow fixture\n---\nUse video_from_image once, then video_get_job. Never resubmit on uncertainty.\n')
      const { PiCodingAgentAdapter } = await import('../electron/pi/sdk/pi-coding-agent-adapter')
      piSession = await new PiCodingAgentAdapter().createSession({
        runId: `video-mock-${Date.now()}`, modelId: 'video-mock-planner', gatewayUrl: 'http://127.0.0.1:1/video-pi-mock',
        workspaceDir: workspace, agentDir: join(profile, 'pi-agent'), sessionDir: join(profile, 'pi-sessions'), additionalSkillPaths: [skill],
        systemPrompt: 'Isolated video mock fixture. Use the task-scoped video tools. Do not access external services.',
        getAccessToken: async () => 'synthetic-pi-video-token', authorizeTool: async () => false, mcpServers: [],
        toolPolicy: { preset: 'workspace-edit', allowedTools: ['video_from_image', 'video_get_job'], workspaceDir: workspace,
          allowedPaths: [workspace], deniedPaths: [], commandPolicy: 'disabled', approvalMode: 'confirm-each' },
        videoTools: { names: ['video_from_image', 'video_get_job'], execute: async (name, args, signal) => {
          if (name === 'video_get_job') {
            const id = (args as { jobId: string }).jobId
            const view = await host.getTaskVideo('video-task-a')
            const job = view.jobs.find(job => job.jobId === id)
            if (!job) throw new AppError('NOT_FOUND')
            return job
          }
          const job = await host.generate('video-task-a', videoGenerationInputSchema.parse(args), signal)
          void host.track('video-task-a').catch(() => undefined)
          return job
        } },
      })
      if (shuttingDown) { await piSession.abort(); return }
      const unsubscribe = piSession.subscribe(() => { piEvents++ })
      try { await piSession.prompt(PI_VIDEO_MODEL_MOCK_PROMPT); piStatus = 'complete' } finally { unsubscribe() }
    } catch { piStatus = 'failed' }
    finally { await piSession?.dispose(); piSession = undefined }
  }
  const window = new BrowserWindow({ width: 1180, height: 900, show: false, title: '电商视频显式 mock 验收',
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  })
  bridge.attach(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const context = { video: host, window: () => bridge.currentWindow(),
    backend: { peekTaskRuntime: () => ({ respondToApproval: (response: Parameters<ToolApprovals['respond']>[0]) => approvals.respond(response) }) },
  } as unknown as RequestContext
  registerRoutes(context, { routes: videoRoutes, listeners: systemListeners })
  app.on('before-quit', event => {
    if (shuttingDown) return
    event.preventDefault(); shuttingDown = true; approvals.denyAll()
    void (async () => {
      await piSession?.abort().catch(() => undefined)
      await host.stopAll()
      await piRun?.catch(() => undefined)
      await piSession?.dispose().catch(() => undefined)
      app.quit()
    })()
  })
  Object.assign(globalThis, { __sepVideoTest: {
    setGranted(value: boolean) { if (value !== granted) { granted = value; revision++ } },
    setDisconnected(value: boolean) { disconnected = value },
    async track() { await host.track('video-task-a') },
    async jobs() { return store.listJobs(scope) },
    async taskView() { return host.getTaskVideo('video-task-a') },
    async assets() { return store.listAssets(scope, 'video-task-a') },
    async stop() { approvals.denyAll(); await host.stopAll() },
    startPi(input: unknown) {
      if (piRun) return
      piRun = runPi(input).catch(() => { piStatus = 'failed' }).finally(() => { piRun = undefined })
    },
    evidence() { return { mock: true, syntheticScope: true, billing: 'MOCK_NOT_CHARGED', blocked, rendererBlocked, requests, revision, pendingApprovals: approvals.size,
      piStatus, piEvents, piModel: piModel?.audit } },
  } })
  await host.authorizeExecution('video-task-a')
  await window.loadFile(join(__dirname, '../renderer/index.html'))
  window.show()
  void host.track('video-task-a').catch(() => undefined)
}).catch(() => { app.exit(1) })
