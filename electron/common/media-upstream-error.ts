import { mediaUpstreamErrorSchema, mediaUpstreamMessage, type MediaUpstreamError } from '../../src/shared/media-upstream-error'
import { redactText, redactValue } from './redact'

export function safeMediaUpstreamMessage(value: unknown): string | undefined {
  const message = mediaUpstreamMessage(value)
  return message ? redactText(message, 1000).replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]').replace(/[\u0000-\u001f\u007f]/g, ' ') : undefined
}

export function safeMediaUpstreamError(value: unknown): MediaUpstreamError | undefined {
  const parsed = mediaUpstreamErrorSchema.safeParse(redactValue(value))
  if (!parsed.success) return undefined
  const sanitize = (entry: unknown): unknown => typeof entry === 'string' ? entry.replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, sanitize(child)])) : entry
  return mediaUpstreamErrorSchema.parse(sanitize(parsed.data))
}
