import { redactText } from '../common/redact'
import { AppError } from './app-error'

export interface MediaToolFailure {
  ok: false
  error: { code: string; message: string }
}

function safeText(value: string): string {
  return redactText(value).replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
}

/** Model-facing business failures never include transport details, causes or URLs. */
export function mediaToolFailure(code: string, message: string): MediaToolFailure {
  return { ok: false, error: { code: safeText(code), message: safeText(message) } }
}

export function mediaToolFailureFrom(error: unknown, cancelled = false): MediaToolFailure {
  if (error instanceof AppError) return mediaToolFailure(error.code, error.userMessage)
  return cancelled
    ? mediaToolFailure('MEDIA_CANCELLED', 'Media tool call cancelled.')
    : mediaToolFailure('MEDIA_FAILED', 'Media tool request failed.')
}
