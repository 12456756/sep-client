import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createConnection } from '@playwright/mcp'
import type { Browser, BrowserContext } from 'playwright-core'
import { Type } from 'typebox'
import { z } from 'zod'
import type { McpServerConfig } from './pi-agent-runtime'
import { createMcpRuntime, type McpRuntime, type McpToolResult } from './pi-mcp-client'

export const BROWSER_MODE_TOOL = 'mcp__playwright__browser_set_mode'
const modeSchema = z.object({ mode: z.enum(['background', 'visible']), purpose: z.enum(['handoff', 'observe']).optional() }).strict()
type BrowserMode = z.infer<typeof modeSchema>['mode']
const require = createRequire(import.meta.url)
// Use the MCP package's pinned browser engine, including after asar unpacking.
const playwright = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright-core') as typeof import('playwright-core')

export class BrowserModeSession {
  private browser?: Browser
  private context?: BrowserContext
  private mode: BrowserMode = 'background'
  private disposed = false
  private opening?: Promise<BrowserContext>
  private changing?: Promise<boolean>
  private readonly lifetime = new AbortController()

  async getContext(): Promise<BrowserContext> {
    if (this.disposed) throw new Error('Browser session is closed.')
    if (this.context && this.browser?.isConnected()) return this.context
    if (this.opening) return this.opening
    this.opening = this.openContext()
    try { return await this.opening }
    finally { this.opening = undefined }
  }

  private async openContext(): Promise<BrowserContext> {
    const opened = await this.launch(this.mode)
    if (this.disposed) { await opened.browser.close(); throw new Error('Browser session is closed.') }
    this.browser = opened.browser
    this.context = opened.context
    this.context.once('close', () => {
      if (this.context === opened.context) {
        this.context = undefined
        this.browser = undefined
        void opened.browser.close().catch(() => undefined)
      }
    })
    return opened.context
  }

  private async launch(mode: BrowserMode, storageState?: Awaited<ReturnType<BrowserContext['storageState']>>): Promise<{ browser: Browser; context: BrowserContext }> {
    const browser = await playwright.chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome',
      headless: mode === 'background', timeout: 20_000 })
    try { return { browser, context: await browser.newContext({ storageState }) } }
    catch (error) { await browser.close(); throw error }
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
    if (mode === this.mode && this.browser?.isConnected()) return false
    if (!this.context || !this.browser?.isConnected()) {
      this.mode = mode
      await this.getContext()
      signal?.throwIfAborted()
      return true
    }
    const oldBrowser = this.browser
    const oldContext = this.context
    // Authentication stays in memory and is scoped to this task session.
    const state = await oldContext.storageState({ indexedDB: true })
    const tabs = await Promise.all(oldContext.pages().map(async page => ({ url: page.url(),
      session: await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))).catch(() => ({})),
    })))
    signal?.throwIfAborted()
    const opened = await this.launch(mode, state)
    const cancel = () => { void opened.browser.close().catch(() => undefined) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      for (const tab of tabs) {
        signal?.throwIfAborted()
        const page = await opened.context.newPage()
        if (!/^https?:\/\//i.test(tab.url)) continue
        const origin = new URL(tab.url).origin
        const cdp = await opened.context.newCDPSession(page)
        await cdp.send('Page.enable')
        const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(() => { const state = ${JSON.stringify({ origin, session: tab.session })}; if (location.origin === state.origin) for (const [key, value] of Object.entries(state.session)) sessionStorage.setItem(key, value); })()`,
        })
        try {
          // A GET reload only: never replay clicks, POST requests or form submissions.
          await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        } finally {
          await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
          await cdp.detach()
        }
      }
      signal?.throwIfAborted()
      if (this.disposed) throw new Error('Browser session is closed.')
      this.context = opened.context
      this.browser = opened.browser
      this.mode = mode
      opened.context.once('close', () => {
        if (this.context === opened.context) {
          this.context = undefined
          this.browser = undefined
          void opened.browser.close().catch(() => undefined)
        }
      })
      await oldBrowser.close().catch(() => undefined)
      return true
    } catch (error) { await opened.browser.close(); throw error }
    finally { signal?.removeEventListener('abort', cancel) }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    this.context = undefined
    await browser?.close()
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
): Promise<McpRuntime> {
  if (!builtinBrowser) return createMcpRuntime(servers, workspaceDir, fetches)
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
      description: 'Browser queries start in background mode. Use visible for user login, QR scan, CAPTCHA or manual takeover (purpose: handoff, default). Opens a window and blocks browser actions until the user clicks the host completion prompt (3 minutes), then automatically returns to background. Denial, timeout or cancellation closes this browser session. Only when the user asks to watch automated actions, use visible with purpose: observe; it returns immediately and remains visible until mode: background. Switching reloads tabs and retains cookies/site storage; unsaved forms/history/CAPTCHA are not retained. Never replay a submission. Read a fresh snapshot after switching.',
      promptSnippet: 'Switch between background browsing, human handoff and watching automated actions.',
      parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object', properties: { mode: { type: 'string', enum: ['background', 'visible'] }, purpose: { type: 'string', enum: ['handoff', 'observe'] } }, required: ['mode'], additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, input, signal): Promise<McpToolResult> => serial(signal, async () => {
        const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
        const parsed = modeSchema.safeParse(input)
        const result = (text: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text }],
          details: { serverName: 'playwright', toolName: 'browser_set_mode', isError } })
        if (!parsed.success) return result('Invalid browser mode: choose background or visible.', true)
        const handoff = parsed.data.mode === 'visible' && parsed.data.purpose !== 'observe'
        if (handoff && !waitForHuman) return result('Manual browser handoff is unavailable in this host.', true)
        try {
          operationSignal.throwIfAborted()
          const listTool = active.tools.find(tool => tool.name === 'mcp__playwright__browser_tabs')!
          const switchMode = async (mode: BrowserMode) => {
            const tabs = await listTool.execute(_id, { action: 'list' }, operationSignal)
            if (tabs.details.isError) throw new Error('Browser tabs unavailable.')
            const selected = /^- (\d+): \(current\)/m.exec(tabs.content.map(item => item.text).join('\n'))
            const changed = await browser.setMode(mode, operationSignal)
            if (!changed) return
            // Reconnecting initializes MCP's tab wrappers lazily, before selection.
            const initialized = await listTool.execute(_id, { action: 'list' }, operationSignal)
            if (initialized.details.isError) throw new Error('Browser tabs unavailable.')
            if (selected) {
              const selection = await listTool.execute(_id, { action: 'select', index: Number(selected[1]) }, operationSignal)
              if (selection.details.isError) throw new Error('Browser tab selection failed.')
            }
          }
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
                return result('Human handoff was denied or expired. Browser session closed. Do not assume login succeeded; ask the user before retrying in a new session.', true)
              }
            } finally { if (onAbort) operationSignal.removeEventListener('abort', onAbort) }
            await switchMode('background')
          }
          if (parsed.data.mode === 'visible' && !handoff) return result('Browser window remains visible for the user to watch automated actions. Read a fresh snapshot. Use a manual handoff before the user edits the page; use background when observation ends. Window visibility does not authorize business submissions.')
          return result('Background browser ready. Human completion does not authorize business submissions. Tabs may have reloaded; read a fresh snapshot and verify login. Do not replay any submission.')
        } catch {
          await browser.dispose()
          return result('Browser handoff or mode switch did not complete; browser session closed. Login is unverified. Do not replay any business submission.', true)
        }
      }),
    }
    const tools = active.tools.map(tool => ({ ...tool, execute: (...args: Parameters<typeof tool.execute>) => tool.name.startsWith('mcp__playwright__') ? serial(args[2], async () => {
      const result = await tool.execute(...args)
      // A cancelled upstream action may still run. Close this isolated browser before another call.
      if (result.details.executionUncertain) await browser.dispose()
      else if (tool.name === 'mcp__playwright__browser_close' && !result.details.isError) await browser.close()
      return result
    }) : tool.execute(...args) }))
    return { builtinBrowser: true, tools: [...tools, modeTool], permissions: new Map([...active.permissions, [BROWSER_MODE_TOOL, 'confirm-each' as const]]), dispose }
  } catch (error) { await dispose(); throw error }
}
