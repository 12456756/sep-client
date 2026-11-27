import { apiDiagnosticSchema, type ApiDiagnostic } from '../../../src/shared/api-diagnostic'
import { redactText, redactValue } from '../redact'

const MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 5000
// Diagnostic envelopes add layers around the provider's own nested body.
const MAX_DIAGNOSTIC_DEPTH = 16
const HEADERS = new Set([
  'content-type', 'content-length', 'retry-after', 'retry-after-auth', 'retry-after-chat', 'retry-after-ms', 'x-request-id', 'x-sep-error-source',
  'x-compute-status', 'x-compute-request-id', 'x-client-request-id', 'x-upstream-request-id',
  'x-sep-receipt-id', 'x-sep-client-request-id',
  'x-video-dispatch', 'x-data-degraded', 'x-sep-execution-id', 'x-sha256', 'x-sep-media-mock', 'x-should-retry',
])

function safeText(value: string): string {
  return redactText(value, Infinity).replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
    .replace(/\p{Cc}/gu, ' ').slice(0, 8192)
}

function sanitize(value: unknown, secrets: readonly string[] = []): unknown {
  const clean = (text: string) => safeText(secrets.reduce((result, secret) => secret ? result.replaceAll(secret, '[redacted]') : result, text))
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map(child => sanitize(child, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [clean(key), sanitize(child, secrets)]))
  return value
}

function exceedsLimits(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.length > 8192
  if (!value || typeof value !== 'object') return false
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return true
  const entries = Array.isArray(value) ? value : Object.values(value)
  return entries.length > 50 || entries.some(child => exceedsLimits(child, depth + 1))
}

/** Revalidate and redact again at IPC boundaries; never accept arbitrary response headers. */
export function safeApiDiagnostic(value: unknown, secrets: readonly string[] = []): ApiDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const headers = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
    ? Object.fromEntries(Object.entries(raw.headers).filter(([key, entry]) => HEADERS.has(key.toLowerCase()) && typeof entry === 'string')
      .map(([key, entry]) => [key.toLowerCase(), sanitize(entry, secrets)])) : undefined
  const evidence = { ...raw, headers: undefined }
  const sanitized: Record<string, unknown> = { ...sanitize(redactValue(evidence, 0, '', { secrets, maxDepth: MAX_DIAGNOSTIC_DEPTH }), secrets) as Record<string, unknown>,
    ...(headers ? { headers } : {}), ...(raw.truncated === true || exceedsLimits(evidence) ? { truncated: true } : {}) }
  const valid: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(apiDiagnosticSchema.shape)) {
    const parsed = schema.safeParse(sanitized[key])
    if (parsed.success && parsed.data !== undefined) valid[key] = parsed.data
  }
  const result = apiDiagnosticSchema.safeParse(valid)
  return result.success ? result.data : undefined
}

export function transportApiDiagnostic(error: unknown, operation?: string, secrets: readonly string[] = []): ApiDiagnostic {
  const describe = (value: unknown, depth = 0): unknown => {
    if (!(value instanceof Error)) return value
    return { name: value.name, message: value.message,
      ...('code' in value ? { code: value.code } : {}),
      ...(value.cause !== undefined && depth < 3 ? { cause: describe(value.cause, depth + 1) } : {}) }
  }
  return safeApiDiagnostic({ operation, transportError: describe(error) }, secrets) ?? {}
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function reasons(value: unknown, depth = 0): string[] {
  if (depth > 5) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.slice(0, 50).flatMap(child => reasons(child, depth + 1))
  const item = record(value)
  const parts = [item.error, item.message, item.reason, item.detail, item.body].flatMap(child => reasons(child, depth + 1))
  if (Array.isArray(item.errors)) parts.push(...item.errors.slice(0, 50).flatMap(child => {
    const issue = record(child)
    const message = reasons(issue.message, depth + 1).join('; ')
    return message ? [typeof issue.field === 'string' ? `${issue.field}: ${message}` : message] : reasons(child, depth + 1)
  }))
  return parts
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined
  const text = value.trim()
  const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000
    : /[a-z]/i.test(text) && text.includes(',') ? Date.parse(text) - now : NaN
  return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : undefined
}

/** Read once with a byte/time budget, keeping partial evidence when the stream fails. */
export async function readApiDiagnostic(response: Response, operation?: string,
  limits: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal; secrets?: readonly string[] } = {}): Promise<ApiDiagnostic> {
  const maxBytes = limits.maxBytes ?? MAX_BYTES
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  let readError: string | undefined
  const reader = response.body?.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  if (reader) {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Error response body read timed out')), limits.timeoutMs ?? TIMEOUT_MS)
    })
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(limits.signal?.reason ?? new Error('Error response body read aborted'))
      limits.signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      limits.signal?.throwIfAborted()
      for (;;) {
        const part = await Promise.race([reader.read(), deadline, aborted])
        if (part.done) break
        const remaining = maxBytes - size
        const bytes = part.value.subarray(0, remaining)
        chunks.push(bytes)
        size += bytes.byteLength
        if (part.value.byteLength > remaining) { truncated = true; break }
      }
    } catch (error) {
      readError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    } finally {
      clearTimeout(timer)
      if (onAbort) limits.signal?.removeEventListener('abort', onAbort)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const declaredLength = response.headers.get('content-length')
  const encoding = response.headers.get('content-encoding')?.toLowerCase()
  if ((!encoding || encoding === 'identity') && !truncated && !readError && declaredLength !== null
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== size)) {
    readError = 'Error response body length mismatch'
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  let body: unknown = text || undefined
  if (text && !truncated && !readError) {
    try { body = JSON.parse(text) as unknown } catch { /* Plain text is valid error evidence. */ }
  }
  const top = record(body), nested = record(top.error), wrapped = record(top.body)
  const code = nested.code ?? top.code ?? record(wrapped.error).code ?? wrapped.code
  const source = response.headers.get('x-sep-error-source') ?? nested.source ?? top.source
  const headers = Object.fromEntries([...response.headers].filter(([key]) => HEADERS.has(key)))
  const computeStatus = Number(response.headers.get('x-compute-status'))
  const diagnostic = safeApiDiagnostic({
    operation, httpStatus: response.status, contentType: response.headers.get('content-type') ?? undefined,
    source, code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    message: [...new Set(reasons(body))].join('; ') || '未返回可读原因', body,
    field: nested.field ?? top.field, stage: nested.stage ?? top.stage,
    retryable: nested.retryable ?? top.retryable, recovery: nested.recovery ?? top.recovery,
    sepRequestId: response.headers.get('x-request-id') ?? top.sepRequestId ?? top.requestId ?? nested.requestId,
    computeRequestId: response.headers.get('x-compute-request-id') ?? undefined,
    sepReceiptId: response.headers.get('x-sep-receipt-id') ?? undefined,
    clientRequestId: response.headers.get('x-sep-client-request-id') ?? response.headers.get('x-client-request-id') ?? undefined,
    upstreamRequestId: response.headers.get('x-upstream-request-id') ?? undefined,
    executionId: response.headers.get('x-sep-execution-id') ?? undefined,
    computeStatus: computeStatus >= 100 && computeStatus <= 599 ? computeStatus : undefined,
    headers, readError, ...(truncated ? { truncated: true } : {}),
  }, limits.secrets)
  return diagnostic ?? { httpStatus: response.status, message: '未返回可读原因', readError: 'Invalid error diagnostic' }
}
