import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createConnection } from '@playwright/mcp'
import type { Browser, BrowserContext, BrowserServer } from 'playwright-core'
import { Type } from 'typebox'
import { z } from 'zod'
import type { McpServerConfig } from './pi-agent-runtime'
import { createMcpRuntime, type McpRuntime, type McpToolResult } from './pi-mcp-client'
import { createBrowserWindowController, type BrowserWindowController } from './pi-browser-window'
import type { SharedBrowserOwner } from './pi-browser-owner'

export const BROWSER_MODE_TOOL = 'mcp__playwright__browser_set_mode'
const modeSchema = z.object({ mode: z.enum(['background', 'visible']), purpose: z.enum(['handoff', 'observe']).optional() }).strict()
type BrowserMode = z.infer<typeof modeSchema>['mode']
const require = createRequire(import.meta.url)
// Use the MCP package's pinned browser engine, including after asar unpacking.
const playwright = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright-core') as typeof import('playwright-core')

export class BrowserModeSession {
  private browser?: Browser
  private server?: BrowserServer
  private window?: BrowserWindowController
  private context?: BrowserContext
  private mode: BrowserMode = 'background'
  private visibilityApplied = false
  private lost = false
  private disposed = false
  private opening?: Promise<BrowserContext>
  private changing?: Promise<boolean>
  private readonly lifetime = new AbortController()
  private closingResources: Promise<void> = Promise.resolve()

  constructor(private readonly createWindow = createBrowserWindowController) {}

  get backgroundHidden(): boolean { return this.mode === 'background' && this.visibilityApplied }
  get unavailable(): boolean { return this.disposed || this.lost }

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
    const server = await playwright.chromium.launchServer({ channel: process.platform === 'win32' ? 'msedge' : 'chrome',
      headless: false, host: '127.0.0.1', timeout: 20_000 })
    let window: BrowserWindowController | undefined
    try {
      const pid = server.process().pid
      if (!pid) throw new Error('Dedicated browser process is unavailable.')
      window = this.createWindow(pid)
      const browser = await playwright.chromium.connect(server.wsEndpoint())
      const context = await browser.newContext()
      if (this.disposed) throw new Error('Browser session is closed.')
      this.server = server
      this.window = window
      this.browser = browser
      this.context = context
      this.visibilityApplied = await window.setVisible(this.mode === 'visible')
      context.on('page', page => {
        page.once('close', () => {
          if (this.context === context && !context.pages().length) {
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
      context.once('close', () => {
        if (this.context !== context) return
        this.lost = true
        this.context = undefined
        void this.closeResources().catch(() => undefined)
      })
      return context
    } catch (error) {
      await server.close().catch(() => undefined)
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
    const window = this.window
    this.server = undefined
    this.window = undefined
    this.browser = undefined
    this.context = undefined
    this.closingResources = this.closingResources.catch(() => undefined).then(async () => {
      try { await server?.close() } finally { await window?.dispose() }
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
  waitForHuman?: () => Promise<boolean>,
  owner?: SharedBrowserOwner,
): Promise<McpRuntime> {
  if (!builtinBrowser) return createMcpRuntime(servers, workspaceDir, fetches)
  if (owner) {
    const browserServers = servers.filter(server => server.name === 'playwright')
    const otherServers = servers.filter(server => server.name !== 'playwright')
    const browser = await owner.acquire(workspaceDir,
      handoff => createHostMcpRuntime(browserServers, workspaceDir, true, undefined, handoff), waitForHuman)
    try {
      const other = await createMcpRuntime(otherServers, workspaceDir, fetches)
      return { builtinBrowser: true, tools: [...browser.tools, ...other.tools],
        permissions: new Map([...browser.permissions, ...other.permissions]),
        dispose: async () => { try { await other.dispose() } finally { await browser.dispose() } } }
    } catch (error) { await browser.dispose(); throw error }
  }
  const browser = new BrowserModeSession()
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
    const serial = <T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
      const result = tail.then(() => { signal?.throwIfAborted(); return run() })
      tail = result.then(() => undefined, () => undefined)
      return result
    }
    const modeTool: McpRuntime['tools'][number] = {
      name: BROWSER_MODE_TOOL, label: '切换浏览器显示',
      description: 'The same conversation shares one browser across turns and employees. Always inspect the current snapshot first. Navigate to the target site before requesting login. Use visible for login, QR scan or CAPTCHA (purpose: handoff, default). Shows the SAME window and blocks actions until the host completion prompt is accepted (3 minutes), then hides it without closing or reloading pages. Denial, timeout or cancellation closes the browser. Use purpose: observe only when the user asks to watch automation. Native hiding may be unavailable; if reported, the same window remains visible. Read a fresh snapshot and verify login after handoff. Never ask for another completion message after the user already completed the host prompt. Window visibility never authorizes business submissions.',
      promptSnippet: 'Switch between background browsing, human handoff and watching automated actions.',
      parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object', properties: { mode: { type: 'string', enum: ['background', 'visible'] }, purpose: { type: 'string', enum: ['handoff', 'observe'] } }, required: ['mode'], additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, input, signal): Promise<McpToolResult> => serial(signal, async () => {
        const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
        const parsed = modeSchema.safeParse(input)
        const result = (text: string, isError = false, closed = false): McpToolResult => ({ content: [{ type: 'text', text }],
          details: { serverName: 'playwright', toolName: 'browser_set_mode', isError, ...(closed ? { browserSessionClosed: true as const } : {}) } })
        if (!parsed.success) return result('Invalid browser mode: choose background or visible.', true)
        const handoff = parsed.data.mode === 'visible' && parsed.data.purpose !== 'observe'
        if (handoff && !waitForHuman) return result('Manual browser handoff is unavailable in this host.', true)
        try {
          operationSignal.throwIfAborted()
          if (handoff && !browser.hasNavigatedPage()) return result('No target website is open. Navigate to the intended login page before requesting handoff; do not show a blank window.', true)
          if (handoff) {
            const tabs = await active.tools.find(tool => tool.name.endsWith('__browser_tabs'))!.execute(_id, { action: 'list' }, operationSignal)
            if (tabs.details.isError || !/^- \d+: \(current\).*https?:\/\//m.test(tabs.content.map(item => item.text).join('\n'))) {
              return result('Select the target website tab before requesting login; the current tab is blank or unavailable.', true)
            }
          }
          const switchMode = (mode: BrowserMode) => browser.setMode(mode, operationSignal)
          await switchMode(parsed.data.mode)
          if (handoff) {
            let onAbort: (() => void) | undefined
            try {
              const cancelled = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(new Error('Manual handoff cancelled.'))
                operationSignal.addEventListener('abort', onAbort, { once: true })
              })
              operationSignal.throwIfAborted()
              const completed = await Promise.race([waitForHuman!(), cancelled])
              operationSignal.throwIfAborted()
              if (!completed) {
                await browser.dispose()
                return result('Human handoff was denied or expired. Browser session closed. Do not assume login succeeded; ask the user before retrying in a new session.', true, true)
              }
            } finally { if (onAbort) operationSignal.removeEventListener('abort', onAbort) }
            await switchMode('background')
          }
          if (parsed.data.mode === 'visible' && !handoff) return result('Browser window remains visible for the user to watch automated actions. Read a fresh snapshot. Use a manual handoff before the user edits the page; use background when observation ends. Window visibility does not authorize business submissions.')
          return result(`${browser.backgroundHidden ? 'Background browser ready.' : 'Native hiding unavailable; the original browser window remains visible.'} The same pages are retained without reload. Read a fresh snapshot and verify login now. Human completion does not authorize business submissions. Do not replay any submission.`)
        } catch {
          await browser.dispose()
          return result('Browser handoff or mode switch did not complete; browser session closed. Login is unverified. Do not replay any business submission.', true, true)
        }
      }),
    }
    const tools = active.tools.map(tool => ({ ...tool, execute: (...args: Parameters<typeof tool.execute>) => tool.name.startsWith('mcp__playwright__') ? serial(args[2], async () => {
      const result = await tool.execute(...args)
      // A cancelled upstream action may still run. Close this isolated browser before another call.
      if (result.details.executionUncertain) await browser.dispose()
      else if (tool.name === 'mcp__playwright__browser_close' && !result.details.isError) await browser.close()
      if (browser.unavailable) result.details.browserSessionClosed = true
      if (!result.details.isError && tool.name !== 'mcp__playwright__browser_close' && !browser.backgroundHidden) {
        result.content.push({ type: 'text', text: 'Browser visibility is not confirmed hidden. Do not claim the window is hidden; use browser_set_mode when visibility matters.' })
      }
      return result
    }) : tool.execute(...args) }))
    return { builtinBrowser: true, tools: [...tools, modeTool], permissions: new Map([...active.permissions, [BROWSER_MODE_TOOL, 'confirm-each' as const]]), dispose }
  } catch (error) { await dispose(); throw error }
}
