import { redactText } from '../common/redact'
import { AppError } from './app-error'

export interface MediaToolFailure {
  ok: false
  error: { code: string; message: string; businessCode?: string; field?: string; stage?: string; recovery?: string }
}

export interface MediaToolFailureMeta {
  businessCode?: string
  field?: string
  stage?: string
  recovery?: string
}

function safeText(value: string): string {
  return redactText(value).replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
}

/** Model-facing business failures never include transport details, causes or URLs. */
export function mediaToolFailure(code: string, message: string, meta?: MediaToolFailureMeta): MediaToolFailure {
  const error = { code: safeText(code), message: safeText(message),
    ...(meta?.businessCode && /^[A-Z][A-Z0-9_]{0,95}$/.test(meta.businessCode) ? { businessCode: meta.businessCode } : {}),
    ...(meta?.field && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(meta.field) ? { field: meta.field } : {}),
    ...(meta?.stage && /^[a-z][a-z0-9-]{0,63}$/.test(meta.stage) ? { stage: meta.stage } : {}),
    ...(meta?.recovery && /^[a-z][a-z0-9_-]{0,63}$/.test(meta.recovery) ? { recovery: meta.recovery } : {}) }
  return { ok: false, error }
}

export function mediaToolFailureFrom(error: unknown, cancelled = false): MediaToolFailure {
  if (error instanceof AppError) {
    const details = error.details ?? {}
    return mediaToolFailure(error.code, error.userMessage, {
      businessCode: typeof details.businessCode === 'string' ? details.businessCode : undefined,
      field: typeof details.field === 'string' ? details.field : undefined,
      stage: typeof details.stage === 'string' ? details.stage : undefined,
      recovery: typeof details.recovery === 'string' ? details.recovery : undefined,
    })
  }
  return cancelled
    ? mediaToolFailure('MEDIA_CANCELLED', 'Media tool call cancelled.')
    : mediaToolFailure('MEDIA_FAILED', 'Media tool request failed.')
}
