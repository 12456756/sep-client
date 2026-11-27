import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { parseRetryAfter, readApiDiagnostic, transportApiDiagnostic } from './api-diagnostic'
import type { ApiDiagnostic } from '../../../src/shared/api-diagnostic'
import { rateLimitRetryDelay } from '../rate-limit-retry'

const SMALL_RESPONSE_BYTES = 1024 * 1024

export class SkillImportApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryable = false, readonly retryAfterMs = 0, readonly diagnostic?: ApiDiagnostic) {
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
    const signature = z.object({ signature: z.string().optional() }).safeParse(options.body)
    return this.send(method, route, schema, { ...options, body,
      secrets: signature.success && signature.data.signature ? [signature.data.signature] : [],
    }, options.contentResponse ? undefined : 20_000)
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
    options: Omit<ImportHttpOptions, 'body'> & { body?: RequestInit['body']; headers?: Record<string, string>; secrets?: readonly string[] }, timeoutMs?: number): Promise<T> {
    if (!/^[A-Za-z0-9_/?=&-]+$/.test(route) || route.startsWith('/') || route.includes('..')) throw new SkillImportApiError('INVALID_ARGUMENT')
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal.reason)
    options.signal.addEventListener('abort', abort, { once: true })
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new SkillImportApiError('NETWORK_TIMEOUT', 0, true)), timeoutMs)
    timer?.unref?.()
    const secrets = [...(options.secrets ?? []), ...(options.token ? [options.token] : [])]
    const operation = 'skill-import.connector'
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
      if (!response.ok) {
        const diagnostic = await readApiDiagnostic(response, operation, { signal: controller.signal, secrets })
        const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
        const top = record(diagnostic.body), nested = record(top.error), wrapped = record(top.body)
        const seconds = nested.retryAfterSeconds ?? top.retryAfterSeconds ?? record(wrapped.error).retryAfterSeconds ?? wrapped.retryAfterSeconds
        const retryAfterMs = rateLimitRetryDelay(diagnostic) ?? parseRetryAfter(response.headers.get('retry-after'))
          ?? (typeof seconds === 'number' && Number.isFinite(seconds * 1000) && seconds >= 0 ? Math.ceil(seconds * 1000) : 0)
        const code = typeof diagnostic.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(diagnostic.code) ? diagnostic.code : 'IMPORT_UNAVAILABLE'
        throw new SkillImportApiError(code, response.status,
          ![409, 410].includes(response.status) && (response.status === 429 || response.status >= 500 || diagnostic.retryable === true), retryAfterMs, diagnostic)
      }
      const limit = response.ok && options.contentResponse ? Infinity : SMALL_RESPONSE_BYTES
      const declaredBytes = Number(response.headers.get('content-length') ?? 0)
      if (declaredBytes > limit) { void response.body?.cancel().catch(() => {}); throw new SkillImportApiError('RESPONSE_TOO_LARGE', response.status) }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) {
        let onAbort: (() => void) | undefined
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          controller.signal.throwIfAborted()
          for (;;) {
            const part = await Promise.race([reader.read(), aborted])
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > limit) throw new SkillImportApiError('RESPONSE_TOO_LARGE', response.status)
            chunks.push(part.value)
          }
        } catch (error) {
          options.signal.throwIfAborted()
          const diagnostic = await readApiDiagnostic(new Response(Buffer.concat(chunks), { headers: response.headers }), operation, { secrets })
          const code = error instanceof SkillImportApiError ? error.code : 'NETWORK_UNAVAILABLE'
          throw new SkillImportApiError(code, response.status, code !== 'RESPONSE_TOO_LARGE', 0, {
            ...diagnostic, ...transportApiDiagnostic(error, operation, secrets), httpStatus: response.status,
            readError: 'Connector response body could not be read completely', ...(code === 'RESPONSE_TOO_LARGE' ? { truncated: true } : {}),
          })
        } finally {
          if (onAbort) controller.signal.removeEventListener('abort', onAbort)
          void reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
      const buffer = Buffer.concat(chunks)
      const invalidResponse = async () => new SkillImportApiError('INVALID_RESPONSE', response.status, false, 0,
        { ...await readApiDiagnostic(new Response(buffer, { headers: response.headers }), operation, { secrets }), httpStatus: response.status })
      let value: unknown
      try { value = JSON.parse(buffer.toString('utf8')) }
      catch { throw await invalidResponse() }
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw await invalidResponse()
      return parsed.data
    } catch (error) {
      if (error instanceof SkillImportApiError || options.signal.aborted) throw error
      if (controller.signal.reason instanceof SkillImportApiError) throw controller.signal.reason
      throw new SkillImportApiError('NETWORK_UNAVAILABLE', 0, true, 0, transportApiDiagnostic(error, operation, secrets))
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
    }
  }
}
