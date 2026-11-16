import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createParser } from 'eventsource-parser'
import { z } from 'zod'
import { isSensitiveModelTraceKey, redactModelTraceText } from '../common/redact'
import { logger } from '../common/logger'
import type { KdocsRequest } from './kdocs-command'

// Protocol verified against the official kdocs-app/kdocs-skill CLI 2.9.0.
const exchange = 'https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange'
const endpoint = 'https://mcp-center.wps.cn/skill_hub/api/v1/tool'
const log = logger.child('kdocs-api')
export const kdocsIdentitySchema = z.object({ token: z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/) })
export type KdocsIdentity = z.infer<typeof kdocsIdentitySchema>
const envelope = z.object({ code: z.number().int(), data: z.unknown().optional() })
export class KdocsApiError extends Error {
  constructor(readonly code: number, readonly status: number) {
    super(code === 400006 || code === 401 || status === 401 ? '金山文档授权已失效，请重新连接。' : status === 403 || code === 403 || code === 403001 ? '当前账号无权执行该操作，请确认文档权限；企业账号请使用 WPS 365。' : code === 409 ? '金山文档授权已取消，请重新连接。' : code === 429001 || code === 429002 || status === 429 ? '金山文档请求受限，请稍后再试，勿连续重试。' : '金山文档请求未完成，请核对文档权限与连接状态。')
  }
}
export class KdocsApi {
  constructor(private readonly request: typeof fetch = fetch, private readonly wait: (signal: AbortSignal) => Promise<void> = signal => delay(1500, undefined, { signal })) {}
  private async json(url: string, body: unknown, signal: AbortSignal, token?: string): Promise<{ value: z.infer<typeof envelope>; status: number }> {
    const response = await this.request(url, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'CSEP/kdocs-adapter', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    if (!response.body) throw new Error('Missing Kdocs response')
    const chunks: Uint8Array[] = []
    const reader = response.body.getReader()
    let size = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 2 * 1024 * 1024) throw new Error('Kdocs response too large')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    let raw: unknown
    const bytes = Buffer.concat(chunks)
    const text = bytes.toString('utf8')
    try {
      if (url === endpoint && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream') {
        // WPS ends a result with a successful finish envelope that has no data.
        const parser = createParser({ maxBufferSize: 2 * 1024 * 1024, onEvent: event => {
          if (event.data === '[DONE]') return
          const value: unknown = JSON.parse(event.data)
          const parsed = envelope.safeParse(value)
          if (parsed.success && (parsed.data.code !== 0 || parsed.data.data !== undefined)) raw = parsed.data
        } })
        parser.feed(text)
        if (raw === undefined) throw new Error('Missing Kdocs stream result')
      } else raw = JSON.parse(text)
    }
    catch {
      log.warn('invalid response format', { stage: url === exchange ? 'exchange' : 'tool', status: response.status, bytes: bytes.length, contentType: response.headers.get('content-type')?.split(';')[0]?.slice(0, 64) })
      if (!response.ok) throw new KdocsApiError(0, response.status)
      throw new Error('Invalid Kdocs response')
    }
    const parsed = envelope.safeParse(raw)
    if (!parsed.success) { if (!response.ok) throw new KdocsApiError(0, response.status); throw new Error('Invalid Kdocs response') }
    const value = parsed.data
    if (!response.ok) throw new KdocsApiError(value.code, response.status)
    return { value, status: response.status }
  }
  async login(open: (url: string) => Promise<void>, source: AbortSignal): Promise<KdocsIdentity> {
    const signal = AbortSignal.any([source, AbortSignal.timeout(300000)])
    const code = randomUUID()
    await open(`https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${code}`)
    for (;;) {
      signal.throwIfAborted()
      const { value, status } = await this.json(exchange, { code }, signal)
      if (value.code === 200) return kdocsIdentitySchema.parse(value.data)
      if (value.code !== 202) throw new KdocsApiError(value.code, status)
      await this.wait(signal)
    }
  }
  async execute(identity: KdocsIdentity, command: KdocsRequest, signal: AbortSignal): Promise<unknown> {
    const { value, status } = await this.json(endpoint, { tool: command.tool, args: command.data }, signal, kdocsIdentitySchema.parse(identity).token)
    if (value.code !== 0) throw new KdocsApiError(value.code, status)
    if (value.data === undefined) throw new Error('Missing Kdocs tool data')
    return value.data
  }
}
export function kdocsPublicResult(value: unknown, identity: KdocsIdentity): string {
  const clean = (item: unknown, depth = 0): unknown => {
    if (depth > 64) return '[max-depth]'
    if (typeof item === 'string') return redactModelTraceText(item.split(identity.token).join('[redacted]'))
    if (Array.isArray(item)) return item.map(entry => clean(entry, depth + 1))
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, isSensitiveModelTraceKey(name) ? '[redacted]' : clean(entry, depth + 1)]))
    return item
  }
  const text = JSON.stringify(clean(value))
  return text.length > 120000 ? JSON.stringify({ truncated: true, text: text.slice(0, 120000), notice: 'Narrow the query or range; this output is incomplete.' }) : text
}
