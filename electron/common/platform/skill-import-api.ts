import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { z } from 'zod'

const SMALL_RESPONSE_BYTES = 1024 * 1024
const httpErrorSchema = z.object({ code: z.string().max(96).optional(), retryable: z.boolean().optional() }).passthrough()

export class SkillImportApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryable = false, readonly retryAfterMs = 0) {
    super(code)
    this.name = 'SkillImportApiError'
  }
}

export interface ImportHttpOptions {
  token?: string
  body?: unknown
  signal: AbortSignal
  contentResponse?: boolean
}

/** This transport deliberately has no access to the consumer authentication session. */
export class SkillImportApi {
  private readonly base: string
  constructor(baseUrl: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new SkillImportApiError('UNTRUSTED_INSTANCE')
    this.base = url.href.replace(/\/+$/, '') + '/skill-import/connector/'
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', route: string, schema: z.ZodType<T>, options: ImportHttpOptions): Promise<T> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (body && !options.contentResponse && Buffer.byteLength(body) > SMALL_RESPONSE_BYTES) throw new SkillImportApiError('REQUEST_BODY_TOO_LARGE')
    return this.send(method, route, schema, { ...options, body }, options.contentResponse ? undefined : 20_000)
  }

  async upload<T>(sessionId: string, operationId: string, token: string,
    pkg: { bytes: number; open(): AsyncIterable<Uint8Array> }, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !/^[A-Za-z0-9_-]{1,160}$/.test(operationId)) throw new SkillImportApiError('INVALID_ARGUMENT')
    const boundary = `sep-${randomUUID()}`
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`)
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const source = pkg.open()
    async function* multipart(): AsyncGenerator<Uint8Array> {
      yield head
      let bytes = 0
      for await (const chunk of source) {
        signal.throwIfAborted()
        bytes += chunk.byteLength
        if (bytes > pkg.bytes) throw new SkillImportApiError('PACKAGE_CHANGED')
        yield chunk
      }
      if (bytes !== pkg.bytes) throw new SkillImportApiError('PACKAGE_CHANGED')
      yield tail
    }
    const stream = Readable.from(multipart())
    try {
      return await this.send('POST', `sessions/${sessionId}/package?operationId=${operationId}`, schema, {
        token, signal, body: stream as unknown as RequestInit['body'], contentResponse: true,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(head.length + pkg.bytes + tail.length) },
      })
    } finally { stream.destroy() }
  }

  private async send<T>(method: string, route: string, schema: z.ZodType<T>,
    options: Omit<ImportHttpOptions, 'body'> & { body?: RequestInit['body']; headers?: Record<string, string> }, timeoutMs?: number): Promise<T> {
    if (!/^[A-Za-z0-9_/?=&-]+$/.test(route) || route.startsWith('/') || route.includes('..')) throw new SkillImportApiError('INVALID_ARGUMENT')
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal.reason)
    options.signal.addEventListener('abort', abort, { once: true })
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new SkillImportApiError('NETWORK_TIMEOUT', 0, true)), timeoutMs)
    timer?.unref?.()
    try {
      options.signal.throwIfAborted()
      const init: RequestInit & { duplex?: 'half' } = {
        method, signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...options.headers },
        body: options.body,
        ...(options.body instanceof Readable ? { duplex: 'half' as const } : {}),
      }
      const response = await this.fetcher(this.base + route, init)
      const limit = response.ok && options.contentResponse ? Infinity : SMALL_RESPONSE_BYTES
      const declaredBytes = Number(response.headers.get('content-length') ?? 0)
      if (declaredBytes > limit) { await response.body?.cancel(); throw new SkillImportApiError('RESPONSE_TOO_LARGE') }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > limit) { await reader.cancel(); throw new SkillImportApiError('RESPONSE_TOO_LARGE') }
            chunks.push(part.value)
          }
        } finally { reader.releaseLock() }
      }
      const retryAfter = response.headers.get('retry-after')
      const retryAfterMs = retryAfter ? Math.max(0, /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0
      const boundedRetryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : 0
      const retryableStatus = response.status === 429 || response.status >= 500
      let value: unknown
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new SkillImportApiError('INVALID_RESPONSE', response.status, !response.ok && retryableStatus, response.ok ? 0 : boundedRetryAfterMs) }
      if (!response.ok) {
        const error = httpErrorSchema.safeParse(value)
        throw new SkillImportApiError(error.success ? error.data.code ?? 'IMPORT_UNAVAILABLE' : 'IMPORT_UNAVAILABLE', response.status,
          retryableStatus || (error.success && error.data.retryable === true), boundedRetryAfterMs)
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new SkillImportApiError('INVALID_RESPONSE', response.status)
      return parsed.data
    } catch (error) {
      if (error instanceof SkillImportApiError || options.signal.aborted) throw error
      throw new SkillImportApiError('NETWORK_UNAVAILABLE', 0, true)
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
    }
  }
}
