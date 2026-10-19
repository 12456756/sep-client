import '../electron/common/undici-polyfill'
import { app, BrowserWindow, session } from 'electron'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MediaStore } from '../electron/data/media-store'
import { SepRealMediaGateway } from '../electron/data/sep-real-media-gateway'
import { MediaService } from '../electron/service/media-service'
import { mediaRoutes } from '../electron/controller/routes/media'
import { registerRoutes } from '../electron/controller/router'
import type { RequestContext } from '../electron/controller/request-context'
import { INVOKE_CHANNELS } from '../electron/controller/channels'
import { AppError } from '../electron/errors/app-error'
import { installShutdownHandler } from '../electron/bootstrap/shutdown'
import { setLogSink } from '../electron/common/logger'
import { isReceiptGetAllowed, readRealReceiptFixture, type RealReceiptFixture } from './real-receipt-fixture'

const profile = process.env.SEP_REAL_RECEIPT_PROFILE
const fixturePath = process.env.SEP_REAL_RECEIPT_FIXTURE
const phase = process.env.SEP_REAL_RECEIPT_PHASE
const memoryTest = process.env.SEP_REAL_RECEIPT_MEMORY_TEST === '1'
if (app.isPackaged || process.env.SEP_REAL_RECEIPT_HARNESS !== '1' || !profile || !isAbsolute(profile)
  || !basename(profile).startsWith('sep-electron-real-receipt-') || !fixturePath
  || !['blocked', 'recover'].includes(phase ?? '') || process.env.ELECTRON_RENDERER_URL
  || process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP !== '0') {
  throw new Error('EXPLICIT_ISOLATED_REAL_RECEIPT_HARNESS_REQUIRED')
}
app.setPath('userData', profile)
// This harness keeps all diagnostics structured and independent of fixture contents.
setLogSink(() => undefined)
const nativeFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('NETWORK_NOT_INITIALIZED') }) as typeof fetch

async function start() {
  const stat = await lstat(profile!)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o700 || await realpath(profile!) !== profile) throw new Error('INVALID_PROFILE')
  const fixture = await readRealReceiptFixture(fixturePath!, memoryTest)
  const store = new MediaStore(profile!)
  const fingerprint = createHash('sha256').update(JSON.stringify({ owner: fixture.owner, task: fixture.task,
    jobs: fixture.jobs, provenance: fixture.provenance })).digest('hex')
  const adoptionPath = join(profile!, 'real-receipt-adoption.json')
  if (phase === 'blocked') {
    if ((await store.listJobs(fixture.owner)).length) throw new Error('PROFILE_ALREADY_HAS_JOBS')
    for (const job of fixture.jobs) await store.saveJob(fixture.owner, job)
    await writeFile(adoptionPath, JSON.stringify({ fingerprint }), { mode: 0o600, flag: 'wx' })
  } else if (JSON.parse(await readFile(adoptionPath, 'utf8')).fingerprint !== fingerprint) {
    throw new Error('FIXTURE_CHANGED_ACROSS_RESTART')
  }
  const audit = { source: memoryTest ? 'memory-protocol-test' : 'supplied-real-receipts',
    phase, allowed: [] as { method: string; path: string }[], deniedRequests: 0,
    blockedDownloads: 0, rendererDenied: 0, actualNetworkRequests: 0, postRequestsSent: 0,
    downloadGate: phase === 'blocked', provesPiFlow: false, approvalRequested: 0 }
  let lastHttpStatus: number | null = null
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!isReceiptGetAllowed(fixture, url, method)) {
      audit.deniedRequests++
      throw new Error('RECEIPT_GET_ALLOWLIST_DENIED')
    }
    audit.allowed.push({ method, path: url.pathname })
    if (audit.allowed.length > 100) throw new Error('RECEIPT_GET_BUDGET_EXCEEDED')
    if (audit.downloadGate && url.pathname.endsWith('/content')) {
      audit.blockedDownloads++
      const signal = init?.signal
      if (!signal) throw new Error('DOWNLOAD_SIGNAL_REQUIRED')
      await new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('INJECTED_DOWNLOAD_ABORT'))
        else signal.addEventListener('abort', () => reject(new Error('INJECTED_DOWNLOAD_ABORT')), { once: true })
      })
    }
    if (memoryTest) return memoryResponse(fixture, url)
    audit.actualNetworkRequests++
    const response = await nativeFetch(input, { ...init, redirect: 'manual' })
    lastHttpStatus = response.status
    return response
  }) as typeof fetch
  globalThis.fetch = fetcher
  const gateway = new SepRealMediaGateway({ baseUrl: fixture.baseUrl, fetch: fetcher,
    token: async subscriptionId => {
      if (subscriptionId !== fixture.task.subscriptionId) throw new Error('SUBSCRIPTION_MISMATCH')
      return fixture.employmentToken
    } })
  const media = new MediaService({ store, gateway,
    scope: { currentScope: () => fixture.owner },
    getTask: async taskId => taskId === fixture.task.taskId ? { subscriptionId: fixture.task.subscriptionId } : null,
    // Historical recovery is supported without granting any generation capability or Pi runtime.
    authorize: async () => null,
    requestApproval: async () => { audit.approvalRequested++; throw new Error('APPROVAL_DISABLED') },
    pollFloorMs: 100, maxAttempts: 2,
  })
  await app.whenReady()
  const rendererFile = join(__dirname, '../renderer/index.html')
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    const allowed = details.method === 'GET' && (url.protocol === 'blob:' || (url.protocol === 'file:'
      && (url.pathname === rendererFile || url.pathname.startsWith(join(__dirname, '../renderer/assets/')))))
    if (!allowed) audit.rendererDenied++
    callback({ cancel: !allowed })
  })
  const window = new BrowserWindow({ width: 1100, height: 950,
    show: process.env.SEP_REAL_RECEIPT_SHOW === '1',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  const allowedChannels = new Set<string>([INVOKE_CHANNELS.MEDIA_GET_TASK, INVOKE_CHANNELS.MEDIA_PREVIEW,
    INVOKE_CHANNELS.MEDIA_EXPORT, INVOKE_CHANNELS.MEDIA_RETRY_SAVE, INVOKE_CHANNELS.MEDIA_RESUME])
  // Deliberately narrow fixture adapter: only media + window are available to these route handlers.
  const context = new Proxy({ media, window: () => window } as Pick<RequestContext, 'media' | 'window'>, {
    get(target, key) { if (key in target) return Reflect.get(target, key); throw new Error('HARNESS_CONTEXT_DENIED') },
  }) as RequestContext
  registerRoutes(context, { routes: mediaRoutes.map(entry => allowedChannels.has(entry.channel) ? entry : {
    ...entry, errorShape: 'ipc' as const, handle: async () => { throw new AppError('PERMISSION_DENIED') },
  }), listeners: [] })
  const identities = async () => {
    const jobs = await store.listJobs(fixture.owner, fixture.task.taskId)
    return jobs.map(job => ({ jobId: job.jobId, taskId: job.taskId, runId: job.runId,
      subscriptionId: job.subscriptionId, clientRequestId: job.clientRequestId, receiptId: job.receiptId,
      profileId: job.profile.profileId, configVersion: job.profile.configVersion, requestHash: job.requestHash,
      immutableHash: createHash('sha256').update(JSON.stringify({ input: job.input, request: job.request,
        quote: job.quote, profile: job.profile, approval: job.approval, owner: job.owner })).digest('hex'),
      trackingStatus: job.trackingStatus, saveStatus: job.saveStatus,
    })).sort((a, b) => a.jobId.localeCompare(b.jobId))
  }
  installShutdownHandler({ stop: async () => {
    await media.stopAll()
    await writeFile(join(profile!, `real-receipt-shutdown-${phase}.json`),
      JSON.stringify({ completed: true, phase, identities: await identities() }), { mode: 0o600, flag: 'wx' })
  } })
  // Main-process controls only. Never exposed through preload or registered as fixture IPC.
  Object.assign(globalThis, { __sepRealReceiptTest: {
    summary: async () => ({ taskId: fixture.task.taskId, source: audit.source,
      identities: await identities(), audit: structuredClone(audit),
      expected: fixture.jobs.map(job => ({ jobId: job.jobId, operation: job.input.operation,
        outputs: job.outputs.map(output => ({ ...output })) })),
    }),
    verifyReceipts: async () => {
      for (const job of fixture.jobs) {
        lastHttpStatus = null
        let receipt: Awaited<ReturnType<SepRealMediaGateway['getReceipt']>>
        try { receipt = await gateway.getReceipt(job.subscriptionId, job.receiptId!, AbortSignal.timeout(15_000)) }
        catch (error) {
          return { verified: 0, failure: { category: error instanceof AppError ? error.code : 'UNCLASSIFIED',
            operation: job.input.operation, httpStatus: lastHttpStatus } }
        }
        const expected = { receiptId: job.receiptId, clientRequestId: job.clientRequestId,
          profileId: job.profile.profileId, configVersion: job.profile.configVersion, status: 'SUCCEEDED', outputs: job.outputs }
        const actual = { receiptId: receipt.receiptId, clientRequestId: receipt.clientRequestId,
          profileId: receipt.profileId, configVersion: receipt.configVersion, status: receipt.status, outputs: receipt.outputs }
        const fields = (Object.keys(expected) as (keyof typeof expected)[])
          .filter(key => !isDeepStrictEqual(actual[key], expected[key]))
        if (fields.length || receipt.recovery?.canDownload === false) {
          return { verified: 0, failure: { category: 'RECEIPT_IDENTITY_MISMATCH', operation: job.input.operation,
            fields, canDownload: receipt.recovery?.canDownload !== false } }
        }
      }
      return { verified: 2 }
    },
    shutdown: () => { setImmediate(() => app.quit()); return { scheduled: true } },
  } })
  await window.loadFile(rendererFile, { query: { taskId: fixture.task.taskId } })
}

function memoryResponse(fixture: RealReceiptFixture, url: URL): Response {
  const job = fixture.jobs.find(job => url.pathname.includes(`/${job.receiptId}`)
    || url.pathname.endsWith(`/by-client-id/${job.clientRequestId}`))!
  if (url.pathname.endsWith('/content')) {
    const bytes = Buffer.from(fixture.memoryProtocol!.pngBase64, 'base64')
    return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length),
      'X-SHA256': createHash('sha256').update(bytes).digest('hex'), 'X-SEP-Media-Mock': 'false' } })
  }
  const body = JSON.stringify({ mock: false, receiptId: job.receiptId, clientRequestId: job.clientRequestId,
    profileId: job.profile.profileId, configVersion: job.profile.configVersion, executionMode: 'sync-response',
    status: 'SUCCEEDED', pollAfterMs: null, billingStatus: 'SETTLED', errorCode: null, outputErrors: [],
    recovery: { canQuery: true, canCancel: false, canDownload: true },
    outputs: job.outputs.map(output => ({ outputId: output.outputId, kind: 'image', mimeType: output.mime,
      byteLength: output.size, width: output.width, height: output.height, sha256: output.sha256,
      expiresAt: output.expiresAt === null ? null : new Date(output.expiresAt).toISOString() })),
  })
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } })
}

void start().catch(() => {
  // Never print a thrown object: parsers/network errors can carry private fixture data.
  process.stderr.write('REAL_RECEIPT_HARNESS_START_FAILED\n')
  app.exit(1)
})
app.on('window-all-closed', () => app.quit())
