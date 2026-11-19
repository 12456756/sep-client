import { mediaUpstreamErrorSchema, mediaUpstreamMessage, type MediaUpstreamError } from '../../src/shared/media-upstream-error'
import { redactText, redactValue } from './redact'
import { safeApiDiagnostic } from './platform/api-diagnostic'

export function safeMediaUpstreamMessage(value: unknown): string | undefined {
  const message = mediaUpstreamMessage(value)
  return message ? redactText(message, 1000).replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]').replace(/\p{Cc}/gu, ' ') : undefined
}

export function safeMediaUpstreamError(value: unknown, secrets: readonly string[] = []): MediaUpstreamError | undefined {
  const parsed = mediaUpstreamErrorSchema.safeParse(redactValue(value, 0, '', { maxDepth: 10, secrets }))
  if (!parsed.success) return undefined
  const sanitize = (entry: unknown): unknown => typeof entry === 'string' ? secrets.reduce((result, secret) => secret ? result.replaceAll(secret, '[redacted]') : result, entry)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]').replace(/\p{Cc}/gu, ' ')
    : Array.isArray(entry) ? entry.map(sanitize)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).map(([key, child]) => [sanitize(key) as string, sanitize(child)])) : entry
  return mediaUpstreamErrorSchema.parse({ ...parsed.data, body: sanitize(parsed.data.body),
    ...(parsed.data.headers ? { headers: safeApiDiagnostic({ headers: parsed.data.headers }, secrets)?.headers ?? {} } : {}) })
}
