import { randomUUID } from 'node:crypto'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import { Type, type TSchema } from 'typebox'
import { z } from 'zod'
import { redactText } from '../../common/redact'
import { withTimeout } from '../../common/with-timeout'
import { type BrowserAssetStore, browserAssetFolder } from '../../data/browser-asset-store'
import type { McpRuntime, McpToolResult } from './pi-mcp-client'

export const BROWSER_SCROLL = 'mcp__playwright__browser_scroll'
export const BROWSER_EXTRACT = 'mcp__playwright__browser_extract'
export const BROWSER_SAVE_ASSETS = 'mcp__playwright__browser_save_assets'

const selector = z.string().trim().min(1).max(300)
const modes = ['text', 'link', 'media'] as const
const scrollInput = z.object({ container: selector, direction: z.enum(['down', 'up']).optional() }).strict()
const extractInput = z.object({ container: selector, item: selector.optional(), limit: z.number().int().min(1).max(30).optional(),
  offset: z.number().int().min(0).max(20_000).optional(),
  fields: z.array(z.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), selector: selector.optional(), kind: z.enum(modes) }).strict()).min(1).max(8),
}).strict().refine(input => new Set(input.fields.map(field => field.key)).size === input.fields.length)
export const browserSaveAssetsInput = z.object({ folder: z.string().regex(browserAssetFolder),
  refs: z.array(z.string().uuid()).min(1).max(12),
}).strict().refine(input => new Set(input.refs).size === input.refs.length)

const types = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/gif', 'gif'], ['image/webp', 'webp'], ['video/mp4', 'mp4']])
const imageLimit = 12 * 1024 * 1024
const videoLimit = 64 * 1024 * 1024
const batchLimit = 96 * 1024 * 1024

interface ObservedAsset { cdp: CDPSession; requestId: string; extension: string; size: number }
interface DocumentAssets { responses: Map<string, ObservedAsset>; refs: Map<string, ObservedAsset> }

// The callbacks below run in the browser, while this file is compiled for Node.
interface BrowserElement {
  readonly tagName: string
  readonly innerText?: string
  readonly href?: string
  readonly currentSrc?: string
  readonly complete?: boolean
  readonly naturalWidth?: number
  readonly naturalHeight?: number
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  checkVisibility(options: { visibilityProperty: boolean; opacityProperty: boolean }): boolean
  getClientRects(): { length: number }
  querySelector(selector: string): BrowserElement | null
  querySelectorAll(selector: string): Iterable<BrowserElement>
  closest(selector: string): BrowserElement | null
  scrollBy(options: { top: number; behavior: 'instant' }): void
}
declare const document: { body: BrowserElement; documentElement: BrowserElement; scrollingElement: BrowserElement | null }

function networkUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    url.hash = ''
    return url
  } catch { return undefined }
}

function matchesFile(bytes: Buffer, extension: string): boolean {
  const head = bytes.toString('latin1', 0, 16)
  switch (extension) {
    case 'jpg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'png': return head.startsWith('\x89PNG\r\n\x1a\n')
    case 'gif': return /^GIF8[79]a/.test(head)
    case 'webp': return head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP'
    case 'mp4': return bytes.length >= 16 && head.slice(4, 8) === 'ftyp'
    default: return false
  }
}

/** Media handles refer only to responses actually loaded by the top-level page. Never fetch a URL supplied by the model or page. */
export class BrowserPageAssets {
  private readonly documents = new WeakMap<Page, DocumentAssets>()
  private readonly ready = new WeakMap<Page, Promise<void>>()

  async observe(context: BrowserContext): Promise<void> {
    const attach = async (page: Page) => {
      this.documents.set(page, { responses: new Map(), refs: new Map() })
      const requests = new Set<string>()
      const pending = new Map<string, { url: string; asset: ObservedAsset; state: DocumentAssets }>()
      page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return
        this.documents.set(page, { responses: new Map(), refs: new Map() })
        requests.clear()
        pending.clear()
      })
      const cdp = await context.newCDPSession(page)
      const main = (await cdp.send('Page.getFrameTree')).frameTree.frame.id
      cdp.on('Network.requestWillBeSent', event => {
        if (event.redirectResponse) requests.delete(event.requestId)
        else if (event.frameId === main && event.request.method === 'GET' && ['Image', 'Media'].includes(event.type ?? '')) {
          if (requests.size >= 400) requests.delete(requests.values().next().value!)
          requests.add(event.requestId)
        }
      })
      cdp.on('Network.responseReceived', event => {
        if (!requests.delete(event.requestId)) return
        const state = this.documents.get(page)
        const response = event.response
        if (!state || event.frameId !== main || ![200, 206].includes(response.status)) return
        const url = networkUrl(response.url)
        if (!url || url.href.length > 4096) return
        const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), String(value)]))
        const extension = types.get(headers['content-type']?.split(';')[0].trim().toLowerCase() ?? '')
        const size = Number(headers['content-length'])
        if (!extension || (headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
          !Number.isSafeInteger(size) || size <= 0 || size > (extension === 'mp4' ? videoLimit : imageLimit)) return
        if (response.status === 206 && headers['content-range'] !== `bytes 0-${size - 1}/${size}`) return
        if (pending.size >= 400) pending.delete(pending.keys().next().value!)
        pending.set(event.requestId, { url: url.href, asset: { cdp, requestId: event.requestId, extension, size }, state })
      })
      cdp.on('Network.loadingFailed', event => { requests.delete(event.requestId); pending.delete(event.requestId) })
      cdp.on('Network.loadingFinished', event => {
        const found = pending.get(event.requestId)
        pending.delete(event.requestId)
        if (!found || found.state !== this.documents.get(page)) return
        const { state, url, asset } = found
        state.responses.delete(url)
        if (state.responses.size >= 400) state.responses.delete(state.responses.keys().next().value!)
        state.responses.set(url, asset)
      })
      await cdp.send('Network.enable', { maxResourceBufferSize: videoLimit, maxTotalBufferSize: batchLimit })
    }
    const observePage = (page: Page) => {
      const pending = this.ready.get(page) ?? attach(page)
      this.ready.set(page, pending)
      return pending
    }
    context.on('page', page => { void observePage(page).catch(() => undefined) })
    await Promise.all(context.pages().map(observePage))
  }

  document(page: Page): DocumentAssets | undefined { return this.documents.get(page) }

  register(state: DocumentAssets, raw: string): string | null {
    const url = networkUrl(raw)
    const asset = url ? state.responses.get(url.href) : undefined
    if (!asset) return null
    for (const [ref, saved] of state.refs) if (saved === asset) return ref
    if (state.refs.size >= 400) state.refs.delete(state.refs.keys().next().value!)
    const ref = randomUUID()
    state.refs.set(ref, asset)
    return ref
  }
}

type BrowserTool = McpRuntime['tools'][number]
type Options = {
  currentPage: () => Promise<Page>
  assets: BrowserPageAssets
  store?: BrowserAssetStore
  lifetime: AbortSignal
  serial: <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => Promise<T>
  checkAccess?: (signal: AbortSignal) => Promise<string | undefined>
}

export function createBrowserPageTools(options: Options): BrowserTool[] {
  const tool = (name: string, label: string, description: string, parameters: TSchema,
    run: (input: unknown, signal: AbortSignal) => Promise<unknown>): BrowserTool => ({
    name, label, description, promptSnippet: label, parameters: Type.Unsafe<Record<string, unknown>>(parameters), executionMode: 'sequential',
    execute: async (_id, input, signal) => options.serial(signal, async () => {
      const combined = signal ? AbortSignal.any([signal, options.lifetime]) : options.lifetime
      const reply = (value: unknown, isError = false): McpToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }],
        details: { serverName: 'playwright', toolName: name.slice('mcp__playwright__'.length), isError } })
      try {
        combined.throwIfAborted()
        const blocked = await options.checkAccess?.(combined)
        combined.throwIfAborted()
        if (blocked) return reply({ error: blocked }, true)
        const result = await run(input, combined)
        const limited = await options.checkAccess?.(combined)
        combined.throwIfAborted()
        if (limited) return reply({ error: limited }, true)
        return reply(result)
      } catch (error) {
        combined.throwIfAborted()
        return reply({ error: error instanceof z.ZodError ? 'Invalid tool input.' : 'Page, target container or artifact directory unavailable. Recheck the active tab and target.' }, true)
      }
    }),
  })
  const tools = [tool(BROWSER_SCROLL, '滚动网页容器', 'Scroll the uniquely matched visible CSS container (body for document scrolling) by one viewport step. Returns moved, atStart and atEnd.',
    Type.Object({ container: Type.String({ maxLength: 300 }), direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')])) }, { additionalProperties: false }),
    async input => {
      const { container, direction = 'down' } = scrollInput.parse(input)
      const page = await options.currentPage()
      return page.locator(`css=${container}`).evaluate((target, direction) => {
        const element = target as unknown as BrowserElement
        if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) throw new Error()
        const box = element === document.body || element === document.documentElement ? document.scrollingElement : element
        if (!box || !box.clientHeight) throw new Error()
        const before = box.scrollTop
        box.scrollBy({ top: (direction === 'down' ? 1 : -1) * Math.max(1, Math.floor(box.clientHeight * 0.8)), behavior: 'instant' })
        return { moved: box.scrollTop !== before, atStart: box.scrollTop <= 1, atEnd: box.scrollHeight - box.clientHeight - box.scrollTop <= 1 }
      }, direction, { timeout: 4_000 })
    }), tool(BROWSER_EXTRACT, '提取网页条目', 'Extract rendered text, links (without URL query or fragment), and already-loaded media references from the active tab. Use CSS selectors, not script. Paginate with nextOffset. Unloaded or unsupported media returns null.',
    Type.Object({ container: Type.String({ maxLength: 300 }), item: Type.Optional(Type.String({ maxLength: 300 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_000 })), fields: Type.Array(Type.Object({ key: Type.String(),
        selector: Type.Optional(Type.String({ maxLength: 300 })), kind: Type.Union(modes.map(kind => Type.Literal(kind))) }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }) }, { additionalProperties: false }),
    async input => {
      const parsed = extractInput.parse(input)
      const page = await options.currentPage()
      const state = options.assets.document(page)
      const extracted = await page.locator(`css=${parsed.container}`).evaluate((target, { item, fields, offset = 0, limit = 30 }) => {
        const root = target as unknown as BrowserElement
        if (!root.getClientRects().length || !root.checkVisibility({ visibilityProperty: true, opacityProperty: true })) throw new Error()
        const items = item ? root.querySelectorAll(item) : [root]
        const rows: Array<Array<string | null>> = []
        let index = 0
        for (const row of items) {
          if (!row.getClientRects().length || !row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || index++ < offset) continue
          if (rows.length === limit) return { rows, truncated: true }
          rows.push(fields.map(field => {
            const node = field.selector ? row.querySelector(field.selector) : row
            if (!node || !node.getClientRects().length || !node.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ||
              node.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return null
            if (field.kind === 'text') return node.innerText?.trim().slice(0, 900) ?? null
            if (field.kind === 'link') return node.tagName === 'A' ? node.href?.slice(0, 4096) ?? null : null
            if (node.tagName === 'VIDEO' || node.tagName === 'IMG' && node.complete && (node.naturalWidth ?? 0) > 1 && (node.naturalHeight ?? 0) > 1) {
              return node.currentSrc?.slice(0, 4096) ?? null
            }
            return null
          }))
        }
        return { rows, truncated: false }
      }, parsed, { timeout: 4_000 })
      if (state !== options.assets.document(page)) throw new Error('Page changed during extraction.')
      const rows = extracted.rows.map(row => Object.fromEntries(parsed.fields.map((field, index) => {
        const value = row[index]
        if (typeof value !== 'string') return [field.key, null]
        if (field.kind === 'media') return [field.key, state ? options.assets.register(state, value) : null]
        const url = field.kind === 'link' ? networkUrl(value) : undefined
        return [field.key, field.kind === 'text' ? redactText(value.slice(0, 900)) : url ? redactText(url.origin + url.pathname) : null]
      })))
      const nextOffset = (parsed.offset ?? 0) + rows.length
      return { rows, truncated: extracted.truncated, nextOffset: extracted.truncated && nextOffset <= 20_000 ? nextOffset : null }
    })]

  if (options.store) tools.push(tool(BROWSER_SAVE_ASSETS, '保存网页素材', 'Save up to 12 media references from browser_extract on the same active document into a named conversation artifact subfolder. Requires approval; never accepts URLs or paths. Returns per-reference results.',
    Type.Object({ folder: Type.String({ maxLength: 40 }), refs: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 12, uniqueItems: true }) }, { additionalProperties: false }),
    async (input, signal) => {
      const { folder, refs } = browserSaveAssetsInput.parse(input)
      const page = await options.currentPage()
      const state = options.assets.document(page)
      const results = []
      let total = 0
      for (const ref of refs) {
        signal.throwIfAborted()
        const asset = state === options.assets.document(page) && !page.isClosed() ? state?.refs.get(ref) : undefined
        if (!asset) { results.push({ ref, status: 'stale_or_unknown_reference' }); continue }
        if (total + asset.size > batchLimit) { results.push({ ref, status: 'batch_size_limit' }); continue }
        total += asset.size
        try {
          // Playwright Response.body() may fall back to a credentialed refetch; this command only reads the browser cache.
          const cached = await withTimeout(asset.cdp.send('Network.getResponseBody', { requestId: asset.requestId }), 10_000, 'Read loaded browser media')
          signal.throwIfAborted()
          const bytes = Buffer.from(cached.body, cached.base64Encoded ? 'base64' : 'utf8')
          if (page.isClosed() || options.assets.document(page) !== state || bytes.length !== asset.size || !matchesFile(bytes, asset.extension)) {
            results.push({ ref, status: 'unsupported_or_changed' }); continue
          }
          results.push({ ref, ...await options.store!.save(folder, bytes, asset.extension, signal) })
        } catch {
          signal.throwIfAborted()
          results.push({ ref, status: 'read_or_save_failed' })
        }
      }
      return { results }
    }))
  return tools
}
