import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createConnection } from '@playwright/mcp'
import type { Browser, BrowserContext, BrowserServer, Page } from 'playwright-core'
import { Type } from 'typebox'
import { z } from 'zod'
import { BrowserAssetStore } from '../../data/browser-asset-store'
import { prepareBrowserProfile } from '../../data/browser-profile'
import { withTimeout } from '../../common/with-timeout'
import type { McpServerConfig } from './pi-agent-runtime'
import { createMcpRuntime, type McpRuntime, type McpToolResult } from './pi-mcp-client'
import { createBrowserWindowController, type BrowserWindowController } from './pi-browser-window'
import type { BrowserHandoff, SharedBrowserOwner } from './pi-browser-owner'
import { BROWSER_SAVE_ASSETS, BrowserPageAssets, createBrowserPageTools } from './pi-browser-page-tools'
import { handoffCompletionSchema, prepareHandoffDetection } from './pi-browser-handoff'
import { BrowserAccessGuard, browserRateLimitMessage } from './pi-browser-access-guard'
import { isOrdinaryBrowserOrigin, isRoutineBrowserCall } from './pi-playwright-mcp'

export const BROWSER_MODE_TOOL = 'mcp__playwright__browser_set_mode'
const BROWSER_SNAPSHOT_TOOL = 'mcp__playwright__browser_snapshot'
const BROWSER_NAVIGATE_TOOL = 'mcp__playwright__browser_navigate'
const BROWSER_CLICK_TOOL = 'mcp__playwright__browser_click'
const inlineSnapshotSchema = z.object({ depth: z.number().optional(), boxes: z.boolean().optional() }).strict()
const simpleClick = z.object({ target: z.string().regex(/^(?:f[1-9]\d{0,8})?e[1-9]\d{0,8}$/), element: z.string().max(500).optional(),
  button: z.literal('left').optional(), doubleClick: z.literal(false).optional(), modifiers: z.tuple([]).optional() }).strict()

function ordinaryPage(url: string): boolean {
  try { return isOrdinaryBrowserOrigin(new URL(url)) } catch { return false }
}

async function ordinaryLinkDestination(page: Page, target: string): Promise<string | undefined> {
  // Resolve a native link and navigate to its href, never dispatch its click handlers.
  const link = page.locator(`aria-ref=${target}`).and(page.locator('a[href]:visible:not([download],[ping],[onclick],[onmousedown],[onpointerdown],[data-method],[role])'))
  const href = await link.evaluate(node => {
    const element = node as unknown as { href: string; getAttribute(name: string): string | null; closest(selector: string): unknown;
      ownerDocument: { defaultView: { top: unknown } | null } }
    const view = element.ownerDocument.defaultView
    const target = element.getAttribute('target')
    return view && view.top === view && (!target || target === '_self') && !element.closest('form, [contenteditable=true]') ? element.href : undefined
  }, undefined, { timeout: 500 }).catch(() => undefined)
  if (!href || !isRoutineBrowserCall(BROWSER_NAVIGATE_TOOL, { url: href })) return undefined
  return new URL(href).origin === pageOrigin(page) ? href : undefined
}

function pageOrigin(page: Page): string | undefined {
  try {
    const url = new URL(page.url())
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch { /* Unusable page. */ }
}
const modeSchema = z.object({ mode: z.enum(['background', 'visible']), purpose: z.enum(['handoff', 'observe']).optional(),
  profile: z.literal('persistent').optional(), completion: handoffCompletionSchema.optional() }).strict()
type BrowserMode = z.infer<typeof modeSchema>['mode']
const require = createRequire(import.meta.url)
// Use the MCP package's pinned browser engine, including after asar unpacking.
const playwright = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright-core') as typeof import('playwright-core')

export class BrowserModeSession {
  readonly pageAssets = new BrowserPageAssets()
  private readonly accessGuard = new BrowserAccessGuard()
  private browser?: Browser
  private server?: BrowserServer
  private window?: BrowserWindowController
  private context?: BrowserContext
  private mode: BrowserMode = 'background'
  private visibilityApplied = false
  private lost = false
  private persistent = false
  private disposed = false
  private opening?: Promise<BrowserContext>
  private changing?: Promise<boolean>
  private readonly lifetime = new AbortController()
  private closingResources: Promise<void> = Promise.resolve()

  constructor(private readonly createWindow = createBrowserWindowController, private readonly taskStateDir?: string) {}

  enablePersistent(): void {
    if (!this.taskStateDir || this.disposed || this.lost || (!this.persistent && (this.context || this.opening))) {
      throw new Error('Persistent profile must be selected before opening a page, in a supported conversation.')
    }
    this.persistent = true
  }

  get backgroundHidden(): boolean { return this.mode === 'background' && this.visibilityApplied }
  get unavailable(): boolean { return this.disposed || this.lost }

  isRateLimited(): Promise<boolean> { return this.accessGuard.isLimited(this.context) }

  singleBackgroundPage(url: string): Page | undefined {
    const pages = this.context?.pages()
    if (!this.backgroundHidden || pages?.length !== 1) return undefined
    try { if (pages[0].url() === new URL(url).href) return pages[0] }
    catch { return undefined }
  }

  routinePage(): Page | undefined {
    const pages = this.context?.pages()
    return this.backgroundHidden && pages?.length === 1 && ordinaryPage(pages[0].url()) ? pages[0] : undefined
  }

  canReadCurrentPage(): boolean {
    return !this.unavailable && this.mode === 'background' && (this.context?.pages().every(page => page.url() === 'about:blank' || ordinaryPage(page.url())) ?? true)
  }

  hasNavigatedPage(): boolean {
    return !!this.context?.pages().some(page => /^https?:\/\//i.test(page.url()))
  }

  async getContext(): Promise<BrowserContext> {
    if (this.disposed) throw new Error('Browser session is closed.')
    if (this.lost) throw new Error('Browser window was closed. Login and page state were lost; start a new browser session explicitly.')
    if (this.context && this.browser?.isConnected()) return this.context
    if (this.opening) return this.opening
    this.opening = this.openContext()
    try { return await this.opening }
    finally { this.opening = undefined }
  }

  private async openContext(): Promise<BrowserContext> {
    await this.closingResources
    if (this.disposed) throw new Error('Browser session is closed.')
    const channel = process.platform === 'win32' ? 'msedge' : 'chrome'
    let server: BrowserServer | undefined
    let context: BrowserContext | undefined
    let window: BrowserWindowController | undefined
    try {
      let browser: Browser | null
      let pid: number | undefined
      if (this.persistent) {
        const profile = await prepareBrowserProfile(this.taskStateDir!)
        context = await playwright.chromium.launchPersistentContext(profile, { channel, headless: false, timeout: 20_000 })
        browser = context.browser()
        if (!browser) throw new Error('Persistent browser is unavailable.')
        const cdp = await browser.newBrowserCDPSession()
        try {
          const { processInfo } = await withTimeout(cdp.send('SystemInfo.getProcessInfo'), 5_000, 'Resolve dedicated browser process')
          pid = processInfo.find(process => process.type === 'browser')?.id
        } finally { await cdp.detach().catch(() => undefined) }
      } else {
        server = await playwright.chromium.launchServer({ channel, headless: false, host: '127.0.0.1', timeout: 20_000 })
        pid = server.process().pid
        browser = await playwright.chromium.connect(server.wsEndpoint())
        context = await browser.newContext()
      }
      if (!pid) throw new Error('Dedicated browser process is unavailable.')
      window = this.createWindow(pid)
      this.accessGuard.observe(context)
      await withTimeout(this.pageAssets.observe(context), 5_000, 'Observe browser media')
      if (this.disposed) throw new Error('Browser session is closed.')
      this.server = server
      this.window = window
      this.browser = browser
      this.context = context
      this.visibilityApplied = await window.setVisible(this.mode === 'visible')
      const openedContext = context
      openedContext.on('page', page => {
        page.once('close', () => {
          if (this.context === openedContext && !openedContext.pages().length) {
            this.lost = true
            void this.closeResources().catch(() => undefined)
          }
        })
        if (this.mode !== 'background') return
        // New popup windows use the same process; do not recreate their pages.
        void window!.setVisible(false).then(ok => { this.visibilityApplied = ok }).catch(() => { this.visibilityApplied = false })
        page.once('domcontentloaded', () => {
          if (this.mode === 'background') void window!.setVisible(false).catch(() => undefined)
        })
      })
      openedContext.once('close', () => {
        if (this.context !== openedContext) return
        this.lost = true
        void this.closeResources().catch(() => undefined)
      })
      return context
    } catch (error) {
      if (server) await server.close().catch(() => undefined)
      else await context?.close().catch(() => undefined)
      await window?.dispose()
      throw error
    }
  }

  async setMode(mode: BrowserMode, signal?: AbortSignal): Promise<boolean> {
    if (this.changing) throw new Error('Browser mode is already changing.')
    this.changing = this.changeMode(mode, signal)
    try { return await this.changing }
    finally { this.changing = undefined }
  }

  private async changeMode(mode: BrowserMode, signal?: AbortSignal): Promise<boolean> {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('Browser session is closed.')
    await this.getContext()
    signal.throwIfAborted()
    if (mode === this.mode && this.visibilityApplied) return false
    this.mode = mode
    const applied = await this.window!.setVisible(mode === 'visible')
    signal.throwIfAborted()
    if (mode === 'visible' && !applied) throw new Error('Browser window could not be shown.')
    this.visibilityApplied = applied
    return true
  }

  async close(): Promise<void> {
    await this.closeResources()
    this.lost = false
  }

  private closeResources(): Promise<void> {
    const server = this.server
    const context = this.context
    const window = this.window
    this.server = undefined
    this.window = undefined
    this.browser = undefined
    this.context = undefined
    this.closingResources = this.closingResources.catch(() => undefined).then(async () => {
      try { if (server) await server.close(); else await context?.close() } finally { await window?.dispose() }
    })
    return this.closingResources
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort()
    await this.opening?.catch(() => undefined)
    await this.changing?.catch(() => undefined)
    await this.close()
  }
}

/** Only the built-in preset gets mode switching; explicit host MCP configurations keep their transport. */
export async function createHostMcpRuntime(
  servers: readonly McpServerConfig[], workspaceDir: string, builtinBrowser: boolean,
  fetches?: ReadonlyMap<string, typeof fetch>,
  waitForHuman?: BrowserHandoff,
  owner?: SharedBrowserOwner,
  browserArtifactTaskId?: string,
  browserTaskStateDir?: string,
): Promise<McpRuntime> {
  if (!builtinBrowser) return createMcpRuntime(servers, workspaceDir, fetches)
  if (owner) {
    const browserServers = servers.filter(server => server.name === 'playwright')
    const otherServers = servers.filter(server => server.name !== 'playwright')
    const browser = await owner.acquire(JSON.stringify([workspaceDir, browserArtifactTaskId, browserTaskStateDir]),
      handoff => createHostMcpRuntime(browserServers, workspaceDir, true, undefined, handoff, undefined, browserArtifactTaskId, browserTaskStateDir), waitForHuman)
    try {
      const other = await createMcpRuntime(otherServers, workspaceDir, fetches)
      return { builtinBrowser: true, browserRoutineAccess: browser.browserRoutineAccess, browserSnapshotApproval: browser.browserSnapshotApproval, tools: [...browser.tools, ...other.tools],
        permissions: new Map([...browser.permissions, ...other.permissions]),
        dispose: async () => { try { await other.dispose() } finally { await browser.dispose() } } }
    } catch (error) { await browser.dispose(); throw error }
  }
  const browser = new BrowserModeSession(undefined, browserTaskStateDir)
  const server = await createConnection({ browser: { isolated: false }, imageResponses: 'omit',
    snapshot: { mode: 'full' }, codegen: 'none', webmcp: false,
    timeouts: { navigation: 20_000, action: 5_000 },
  }, () => browser.getContext() as ReturnType<NonNullable<Parameters<typeof createConnection>[1]>>)
  const client = new Client({ name: 'sep-client', version: '0.1.0' }, { capabilities: { roots: {} } })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspaceDir).href }] }))
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
  let runtime: McpRuntime | undefined
  let closing: Promise<void> | undefined
  const lifetime = new AbortController()
  const dispose = (): Promise<void> => closing ??= (async () => {
    lifetime.abort()
    try { await runtime?.dispose() }
    finally { try { await server.close() } finally { await browser.dispose() } }
  })()
  try {
    await server.connect(serverTransport)
    runtime = await createMcpRuntime(servers, workspaceDir, fetches, new Map([['playwright', { client, transport }]]))
    const active = runtime
    let tail = Promise.resolve()
    let lastNavigation: { url: string; page: Page; at: number } | undefined
    type SnapshotGrant = { page: Page; origin: string }
    let snapshotGrant: SnapshotGrant | undefined
    let approvalEpoch = 0
    let detachSnapshotGrant: (() => void) | undefined
    const snapshotClaims = new Map<string, SnapshotGrant>()
    const currentSnapshotGrant = () => {
      const grant = snapshotGrant
      if (!grant || lifetime.signal.aborted) return undefined
      if (pageOrigin(grant.page) !== grant.origin || browser.singleBackgroundPage(grant.page.url()) !== grant.page) {
        browserSnapshotApproval.reset()
        return undefined
      }
      return grant
    }
    const browserSnapshotApproval: NonNullable<McpRuntime['browserSnapshotApproval']> = {
      claim(id, input) {
        const grant = currentSnapshotGrant()
        if (!grant || !inlineSnapshotSchema.safeParse(input).success || snapshotClaims.has(id) || snapshotClaims.size >= 64) return false
        snapshotClaims.set(id, grant)
        return true
      },
      reset() {
        approvalEpoch++
        snapshotGrant = undefined
        detachSnapshotGrant?.()
        detachSnapshotGrant = undefined
      },
    }
    const checkRateLimit = async (signal: AbortSignal): Promise<boolean> => {
      signal.throwIfAborted()
      const limited = await browser.isRateLimited()
      signal.throwIfAborted()
      return limited
    }
    const rateLimited = (toolName: string): McpToolResult => ({ content: [{ type: 'text', text: browserRateLimitMessage }],
      details: { serverName: 'playwright', toolName, isError: true } })
    const serial = <T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
      const result = tail.then(() => { signal?.throwIfAborted(); return run() })
      tail = result.then(() => undefined, () => undefined)
      return result
    }
    const navigate = active.tools.find(tool => tool.name === BROWSER_NAVIGATE_TOOL)
    const linkClaims = new Map<string, { page: Page; source: string; target: string; href: string }>()
    const browserRoutineAccess: NonNullable<McpRuntime['browserRoutineAccess']> = {
      canReadCurrentPage: () => !lifetime.signal.aborted && browser.canReadCurrentPage(),
      claimLink: (id, input, signal) => serial(signal, async () => {
        const parsed = simpleClick.safeParse(input)
        const page = browser.routinePage()
        if (!navigate || !page || !parsed.success || linkClaims.size >= 64 || linkClaims.has(id)) return false
        const source = page.url(), { target } = parsed.data
        const href = await ordinaryLinkDestination(page, target)
        if (!href || lifetime.signal.aborted || signal?.aborted || browser.routinePage() !== page || page.url() !== source) return false
        linkClaims.set(id, { page, source, target, href })
        return true
      }),
      reset: () => linkClaims.clear(),
    }
    const listTabs = active.tools.find(tool => tool.name === 'mcp__playwright__browser_tabs')
    const currentPage = async (id: string, signal: AbortSignal) => {
      const tabs = await listTabs?.execute(id, { action: 'list' }, signal)
      const matches = tabs?.content.flatMap(item => [...item.text.matchAll(/^- (\d+): \(current\) (.*)$/gm)])
      if (tabs?.details.isError || matches?.length !== 1) throw new Error('No unique active page.')
      const page = (await browser.getContext()).pages()[Number(matches[0][1])]
      if (!page || !/^https?:\/\//i.test(page.url()) || !matches[0][2].endsWith(`](${page.url()})`)) throw new Error('Active page changed.')
      return page
    }
    const modeTool: McpRuntime['tools'][number] = {
      name: BROWSER_MODE_TOOL, label: '切换浏览器显示',
      description: 'Navigate to the target site first. Use visible with purpose handoff (default) for login, QR scan or CAPTCHA. Shows the same tab and pauses until a clear completion signal or the user clicks the fallback, for up to 3 minutes. The host uses a known site login signal when available; otherwise it looks for a new sign-out control on the same site. For sites without a known signal, if the expected result is known, pass completion with the exact destination URL (no query or fragment) and exact visible success text absent before handoff. Never guess either value or include account details, tokens or form values. Denial, timeout or cancellation closes the browser. Use purpose observe only when the user asks to watch automation. Read a fresh snapshot only if the handed-off page remains available. Handoff never grants business authorization.',
      promptSnippet: 'Switch between background browsing, human handoff and watching automated actions.',
      parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object', properties: { mode: { type: 'string', enum: ['background', 'visible'] }, purpose: { type: 'string', enum: ['handoff', 'observe'] },
        completion: { type: 'object', properties: { url: { type: 'string', maxLength: 2048 }, text: { type: 'string', minLength: 3, maxLength: 100 } }, required: ['url', 'text'], additionalProperties: false },
        ...(browserTaskStateDir ? { profile: { type: 'string', enum: ['persistent'], description: 'Opt in before opening any page. Use with mode background, then verify site login.' } } : {}),
      }, required: ['mode'], additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, input, signal): Promise<McpToolResult> => serial(signal, async () => {
        const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
        const parsed = modeSchema.safeParse(input)
        const result = (text: string, isError = false, closed = false): McpToolResult => ({ content: [{ type: 'text', text }],
          details: { serverName: 'playwright', toolName: 'browser_set_mode', isError, ...(closed ? { browserSessionClosed: true as const } : {}) } })
        if (!parsed.success) return result('Invalid browser mode: choose background or visible.', true)
        const handoff = parsed.data.mode === 'visible' && parsed.data.purpose !== 'observe'
        if (parsed.data.completion && !handoff) return result('Completion can only be used for a visible handoff.', true)
        if (handoff && !waitForHuman) return result('Manual browser handoff is unavailable in this host.', true)
        let page: Page | undefined
        let detection: Awaited<ReturnType<typeof prepareHandoffDetection>> | undefined
        const completionMessage = () => detection?.evidence === 'site-login' ? 'Login was confirmed.'
          : detection?.evidence === 'page-marker' ? 'The page showed the expected completion marker. Login status was not independently verified.'
            : 'Login status could not be confirmed.'
        try {
          if (await checkRateLimit(operationSignal)) return rateLimited('browser_set_mode')
          lastNavigation = undefined
          if (parsed.data.mode === 'visible') browserSnapshotApproval.reset()
          const epoch = approvalEpoch
          if (parsed.data.profile) {
            if (parsed.data.mode !== 'background' || parsed.data.purpose) return result('Select the profile with mode background and no purpose.', true)
            try { browser.enablePersistent() }
            catch { return result('Persistent profile is unavailable or a temporary page is open. Close that session before opting in.', true) }
          }
          if (handoff && !browser.hasNavigatedPage()) return result('No target website is open. Navigate to the intended login page before requesting handoff; do not show a blank window.', true)
          page = handoff ? await currentPage(_id, operationSignal).catch(() => undefined) : undefined
          if (handoff && !page) return result('Select the target website tab before requesting login; the current tab is blank or unavailable.', true)
          detection = page && await prepareHandoffDetection(page, parsed.data.completion)
          const switchMode = (mode: BrowserMode) => browser.setMode(mode, operationSignal)
          await switchMode(parsed.data.mode)
          if (page && detection) {
            const closed = new AbortController()
            const onClose = () => closed.abort()
            const handoffSignal = AbortSignal.any([operationSignal, closed.signal])
            let onAbort: (() => void) | undefined
            page.once('close', onClose)
            if (page.isClosed()) onClose()
            let origin: string | undefined
            try {
              const cancelled = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(new Error('Manual handoff cancelled.'))
                handoffSignal.addEventListener('abort', onAbort, { once: true })
              })
              handoffSignal.throwIfAborted()
              const completed = await Promise.race([waitForHuman!({ signal: handoffSignal, waitForCompletion: detection.waitForCompletion }), cancelled])
              handoffSignal.throwIfAborted()
              if (!completed) {
                detection.dispose()
                await browser.dispose()
                return result(`The handoff was denied or expired. ${completionMessage()} Browser session closed. Do not reopen or retry automatically.`, true, true)
              }
              origin = pageOrigin(page)
            } finally {
              detection.dispose()
              if (onAbort) handoffSignal.removeEventListener('abort', onAbort)
              page.removeListener('close', onClose)
            }
            if (page.isClosed()) throw new Error('Handed-off page closed.')
            await switchMode('background')
            const limited = await checkRateLimit(operationSignal)
            if (page.isClosed() || browser.unavailable) throw new Error('Handed-off page closed.')
            if (limited) return rateLimited('browser_set_mode')
            if (epoch === approvalEpoch && origin && pageOrigin(page) === origin && browser.singleBackgroundPage(page.url()) === page) {
              const grantedPage = page
              snapshotGrant = { page: grantedPage, origin }
              const revoke = () => browserSnapshotApproval.reset()
              const onNavigation = () => { if (pageOrigin(grantedPage) !== origin) revoke() }
              grantedPage.on('framenavigated', onNavigation)
              grantedPage.once('close', revoke)
              detachSnapshotGrant = () => { grantedPage.off('framenavigated', onNavigation); grantedPage.off('close', revoke) }
            }
          }
          if (parsed.data.mode === 'visible' && !handoff) return result('Browser window remains visible for the user to watch automated actions. Read a fresh snapshot. Use a manual handoff before the user edits the page; use background when observation ends. Window visibility does not authorize business submissions.')
          const nextStep = detection?.evidence === 'site-login' ? 'Login was confirmed. Read a fresh snapshot before continuing.'
            : 'Read a fresh snapshot and verify login if needed.'
          return result(`${browser.backgroundHidden ? 'Background browser ready.' : 'Native hiding unavailable; the original browser window remains visible.'}${parsed.data.profile ? ' Conversation persistent profile enabled.' : ''} The same pages are retained without reload. ${nextStep} Human completion does not authorize business submissions. Do not replay any submission.`)
        } catch {
          detection?.dispose()
          const pageClosed = handoff && !operationSignal.aborted && !!page && (page.isClosed() || browser.unavailable)
          await browser.dispose().catch(() => undefined)
          if (pageClosed) return result(`${completionMessage()} The handed-off browser page was closed and cannot be used to continue. Do not reopen or retry automatically.`, !detection?.evidence, true)
          const completion = handoff ? ` ${completionMessage()}` : ''
          return result(`Browser handoff or mode switch did not complete; browser session closed.${completion} Do not replay any business submission.`, true, true)
        } finally { detection?.dispose() }
      }),
    }
    const tools = active.tools.map(tool => ({ ...tool, execute: (...args: Parameters<typeof tool.execute>) => tool.name.startsWith('mcp__playwright__') ? serial(args[2], async () => {
      const name = tool.name.slice('mcp__playwright__'.length)
      const link = tool.name === BROWSER_CLICK_TOOL ? linkClaims.get(args[0]) : undefined
      if (link) linkClaims.delete(args[0])
      const claim = tool.name === BROWSER_SNAPSHOT_TOOL ? snapshotClaims.get(args[0]) : undefined
      if (claim) snapshotClaims.delete(args[0])
      const snapshotScopeChanged = (): McpToolResult => ({ content: [{ type: 'text', text: 'The handed-off page changed. No snapshot is returned. Recheck the target and request fresh approval if needed.' }],
        details: { serverName: 'playwright', toolName: name, isError: true } })
      if (lifetime.signal.aborted) return {
        content: [{ type: 'text' as const, text: 'Browser session is closed.' }],
        details: { serverName: 'playwright', toolName: name, isError: true, browserSessionClosed: true as const },
      }
      const signal = args[2] ? AbortSignal.any([args[2], lifetime.signal]) : lifetime.signal
      if (name !== 'browser_close' && await checkRateLimit(signal)) return rateLimited(name)
      signal.throwIfAborted()
      if (claim && (claim !== currentSnapshotGrant() || !inlineSnapshotSchema.safeParse(args[1]).success)) return snapshotScopeChanged()
      const url = name === 'browser_navigate' && typeof args[1].url === 'string' ? args[1].url : undefined
      if (url && lastNavigation?.url === url && performance.now() - lastNavigation.at < 10_000
        && lastNavigation.page === browser.singleBackgroundPage(url)) {
        return { content: [{ type: 'text' as const, text: 'The same URL was just opened. No new network request was sent. Reuse the previous navigation result; read the current page only if its state may have changed.' }],
          details: { serverName: 'playwright', toolName: name, isError: false } }
      }
      if (name !== 'browser_snapshot') lastNavigation = undefined
      // A stale claim cannot become a genuine click. Recheck the exact link under the same browser lock.
      if (link && (!navigate || simpleClick.safeParse(args[1]).data?.target !== link.target || browser.routinePage() !== link.page ||
        link.page.url() !== link.source || await ordinaryLinkDestination(link.page, link.target) !== link.href || link.page.url() !== link.source)) {
        return { content: [{ type: 'text' as const, text: 'The ordinary link changed. No click was performed. Read the current page and locate the link again.' }],
          details: { serverName: 'playwright', toolName: name, isError: true } }
      }
      signal.throwIfAborted()
      const result = link && navigate ? await navigate.execute(args[0], { url: link.href }, signal) : await tool.execute(...args)
      // A cancelled upstream action may still run. Close this isolated browser before another call.
      if (result.details.executionUncertain) await browser.dispose()
      else if (tool.name === 'mcp__playwright__browser_close' && !result.details.isError) await browser.close()
      if (browser.unavailable) result.details.browserSessionClosed = true
      if (name !== 'browser_close' && !result.details.browserSessionClosed && await checkRateLimit(signal)) return rateLimited(name)
      if (claim && !result.details.browserSessionClosed && currentSnapshotGrant() !== claim) return snapshotScopeChanged()
      if (name === 'browser_close' || name === 'browser_tabs') browserSnapshotApproval.reset()
      const page = url && !result.details.isError ? browser.singleBackgroundPage(url) : undefined
      if (url && page) lastNavigation = { url, page, at: performance.now() }
      if (!result.details.isError && tool.name !== 'mcp__playwright__browser_close' && !browser.backgroundHidden) {
        result.content.push({ type: 'text', text: 'Browser visibility is not confirmed hidden. Do not claim the window is hidden; use browser_set_mode when visibility matters.' })
      }
      return result
    }) : tool.execute(...args) }))
    const pageTools = listTabs ? createBrowserPageTools({
      currentPage: () => currentPage('current-tab', lifetime.signal),
      assets: browser.pageAssets,
      store: browserArtifactTaskId ? new BrowserAssetStore(workspaceDir, browserArtifactTaskId) : undefined,
      lifetime: lifetime.signal, serial,
      checkAccess: async signal => {
        lastNavigation = undefined
        return await checkRateLimit(signal) ? browserRateLimitMessage : undefined
      },
    }) : []
    return { builtinBrowser: true, browserRoutineAccess, browserSnapshotApproval, tools: [...tools, modeTool, ...pageTools], permissions: new Map([...active.permissions,
      [BROWSER_MODE_TOOL, 'confirm-each' as const], ...pageTools.map(tool => [tool.name, tool.name === BROWSER_SAVE_ASSETS ? 'confirm-each' : 'auto-approve'] as const)]), dispose }
  } catch (error) { await dispose(); throw error }
}
