import '../electron/common/undici-polyfill'
import { app, session } from 'electron'
import { isAbsolute, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createPiMediaModelMock, type PiMediaModelMock } from './pi-media-model-mock'
import { MediaFaultInjector } from './electron-media-faults'
import { isMediaMockRendererRequestAllowed } from './electron-media-mock-policy.mjs'

// This entry is bundled only by the opt-in Electron integration runner, not the app build.
const profile = process.env.SEP_ELECTRON_MOCK_PROFILE
const mediaRoot = process.env.SEP_ELECTRON_MOCK_MEDIA_URL
function localRoot(value: string | undefined): string {
  if (!value) throw new Error('Explicit local mock URL is required')
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/api') {
    throw new Error('Electron integration accepts only loopback /api endpoints')
  }
  return value
}
if (app.isPackaged || process.env.SEP_ELECTRON_MEDIA_MOCK !== 'true'
  || !profile || !isAbsolute(profile) || !profile.includes('sep-electron-media-mock-')) {
  throw new Error('Explicit isolated development Electron mock profile is required')
}
const apiRoot = localRoot(process.env.SEP_BASE_URL)
const mockRoot = localRoot(mediaRoot)
const faults = new MediaFaultInjector(mockRoot)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

const requests: Record<string, number> = {}
const responses: Record<string, Record<string, number>> = {}
const mediaErrors: unknown[] = []
let blockedRequests = 0
let disconnected = false
const piMockEnabled = process.env.SEP_ELECTRON_PI_MEDIA_MOCK === 'true'
const shutdownId = process.env.SEP_ELECTRON_MOCK_SHUTDOWN_ID
if (process.env.SEP_MCP_CONFIG || process.env.ELECTRON_RENDERER_URL || process.env.SEP_PLAYWRIGHT_MCP !== '0'
  || (piMockEnabled && !/^[a-f0-9-]{36}$/.test(shutdownId ?? ''))) {
  throw new Error('Isolated mock environment and shutdown identity required')
}
let rendererBlockedRequests = 0
const mockCompletion = 'http://127.0.0.1:1/pi-media-model-mock/chat/completions'
let piModel: PiMediaModelMock | undefined
const piErrors: string[] = []
const nativeFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (piMockEnabled && url.href === mockCompletion) {
    if (!piModel || (init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'POST') {
      throw new Error('Approved Skill preparation required before Pi mock execution')
    }
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined)
    if (typeof body !== 'string') throw new Error('Pi mock requires a JSON request')
    try {
      return piModel.respond(JSON.parse(body) as unknown)
    } catch (error) {
      const code = error instanceof Error && /^Pi media model mock: [A-Z_]+$/.test(error.message)
        ? error.message : 'Pi media model mock: INVALID_REQUEST'
      piErrors.push(code)
      throw new Error(code)
    }
  }
  const allowed = [apiRoot, mockRoot].some(root => url.origin === new URL(root).origin)
    && url.pathname.startsWith('/api/') && !/chat\/completions|responses|images\/generations|embeddings/.test(url.pathname)
  if (!allowed) { blockedRequests++; throw new Error('External/model HTTP disabled in Electron mock integration') }
  requests[url.pathname] = (requests[url.pathname] ?? 0) + 1
  if (disconnected && url.origin === new URL(mockRoot).origin) throw new Error('Injected local media disconnect')
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const response = faults.before(url, method)
    ?? await faults.after(url, method, await nativeFetch(input, { ...init, redirect: 'error' }))
  const statuses = responses[url.pathname] ??= {}
  statuses[response.status] = (statuses[response.status] ?? 0) + 1
  return response
}) as typeof fetch

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isMediaMockRendererRequestAllowed(details.url)
    if (!allowed) rendererBlockedRequests++
    callback({ cancel: !allowed })
  })
  const [{ safeStorage }, { createBackend }, { createMainWindow }, { RendererBridge },
    { createRequestContext }, { registerRoutes }, { routes, listeners },
    { SepMediaGateway }, { getRefreshToken }, { EmploymentTokenManager }, { setLogSink }, { installShutdownHandler }] = await Promise.all([
    import('electron'), import('../electron/bootstrap/build-backend'), import('../electron/bootstrap/main-window'),
    import('../electron/bootstrap/renderer-bridge'), import('../electron/controller/request-context'),
    import('../electron/controller/router'), import('../electron/controller/routes'),
    import('../electron/data/sep-media-gateway'), import('../electron/common/platform/credential-vault'),
    import('../electron/common/platform/employment-token-manager'),
    import('../electron/common/logger'),
    import('../electron/bootstrap/shutdown'),
  ])
  setLogSink(record => {
    if (typeof record.fields.operation === 'string' && record.fields.operation.startsWith('media:')) {
      mediaErrors.push({ level: record.level, fields: record.fields })
    }
  })
  const bridge = new RendererBridge()
  const caps = new Map<string, unknown>()
  const tokenManagers = new Map<string, { manager: InstanceType<typeof EmploymentTokenManager>; ready: Promise<void> }>()
  app.on('before-quit', () => {
    for (const { manager } of tokenManagers.values()) manager.stop()
  })
  const gateway = new SepMediaGateway({ baseUrl: mockRoot, token: async subscriptionId => {
    try {
      let cached = tokenManagers.get(subscriptionId)
      if (!cached) {
        const manager = new EmploymentTokenManager({ getRefreshToken: () => getRefreshToken() ?? '' })
        cached = { manager, ready: manager.initialize(subscriptionId) }
        tokenManagers.set(subscriptionId, cached)
        void cached.ready.catch(() => {
          if (tokenManagers.get(subscriptionId) === cached) {
            manager.stop()
            tokenManagers.delete(subscriptionId)
          }
        })
      }
      await cached.ready
      return await cached.manager.getValidToken()
    } catch (error) {
      mediaErrors.push({ operation: 'employment-token', name: error instanceof Error ? error.name : 'Unknown' })
      throw error
    }
  } })
  const backend = await createBackend({ userDataDir: profile, renderer: bridge,
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(), mediaGateway: gateway,
    mediaCapabilities: employee => caps.get(employee.subscriptionId) })
  installShutdownHandler({ stop: async () => {
    await backend.stopAll()
    if (shutdownId) await writeFile(join(profile, `media-mock-shutdown-${shutdownId}.json`),
      JSON.stringify({ shutdownId, completed: true }), { flag: 'wx', mode: 0o600 })
  } })
  registerRoutes(createRequestContext(backend, () => bridge.currentWindow()), { routes, listeners })
  bridge.attach(createMainWindow({ onClosed: () => bridge.attach(null) }))

  // Main-process-only test controls; never exposed through preload or production IPC.
  Object.assign(globalThis, { __sepMediaTest: {
    async prepare(subscriptionId: string) {
      const profiles = await gateway.profiles(subscriptionId, AbortSignal.timeout(15_000))
      caps.set(subscriptionId, profiles.capabilities)
      const employee = await backend.employees.authorize(subscriptionId)
      if (!employee) throw new Error('Actual subscribed employee unavailable')
      const imageSkill = employee.runtimeSnapshot?.skills.find(skill => skill.name === 'ecommerce-image-mock')
      if (piMockEnabled && !piModel) {
        if (!imageSkill) throw new Error('Approved ecommerce image Skill required')
        piModel = createPiMediaModelMock({ approvedSkillPath: join(imageSkill.path, 'SKILL.md') })
      }
      const productionMedia = employee.media as { executionAvailable?: boolean } | undefined
      return { subscriptionId, productionExecutionAvailable: productionMedia?.executionAvailable ?? false,
        skills: employee.runtimeSnapshot?.skills.map(skill => ({ name: skill.name, versionId: skill.versionId, path: join(skill.path, 'SKILL.md'), sha256: skill.sha256 })) ?? [],
        referenceFixtureBase64: profiles.referenceFixtureBase64, referenceFixtureSha256: profiles.referenceFixtureSha256 }
    },
    async inspect(taskId: string) { return backend.media.getTaskMedia(taskId) },
    fault(kind: Parameters<MediaFaultInjector['configure']>[0]) { faults.configure(kind); return faults.audit },
    async scanPending() { await backend.media.resumePending() },
    disconnect(value: boolean) { disconnected = value },
    evidence() { return { requests: { ...requests }, responses, blockedRequests, rendererBlockedRequests,
      rendererNetworkRestricted: true, mcpConfigured: !!process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP !== '0',
      mediaErrors, piModel: piModel?.audit, piErrors: [...piErrors], faults: faults.audit, userData: profile, runtimeLoaded: backend.peekTaskRuntime() !== null } },
    async shutdown() { app.quit() },
    exportPath: join(profile, 'export.png'),
  } })
}).catch(() => { app.exit(1) })
app.on('window-all-closed', () => app.quit())
