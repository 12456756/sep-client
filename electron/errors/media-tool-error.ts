import { redactText } from '../common/redact'
import { AppError } from './app-error'
import { ERROR_CODES } from './error-codes'
import { imageRequestedSpecSchema, videoRequestedSpecSchema, isMediaSpecError, type MediaSpecFailureContext } from '../../src/shared/media-spec-contract'

export interface MediaToolFailure {
  ok: false
  error: { code: string; message: string } & MediaToolFailureMeta
}

export type MediaToolFailureMeta = MediaSpecFailureContext

function safeText(value: string): string {
  return redactText(value).replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
}

const SOURCES = new Set(['client', 'sep', 'platform', 'adapter', 'pricing', 'sub2api', 'provider', 'upstream', 'authorization'])
const SUBMISSION_STATES = new Set(['not_submitted', 'submitted', 'unknown'])
const BILLING_STATES = new Set(['not_reserved', 'reserved', 'settled', 'released', 'reconciling', 'unknown'])

/** Only a single validated specification scalar may be reflected, never a prompt or transport body. */
function safeRequestedValue(meta?: MediaToolFailureMeta): string | number | boolean | undefined {
  const field = meta?.field?.split('.').at(-1)
  if (!field || meta?.requestedValue === undefined) return undefined
  const spec = { [field]: meta.requestedValue }
  return imageRequestedSpecSchema.safeParse(spec).success || videoRequestedSpecSchema.safeParse(spec).success ? meta.requestedValue : undefined
}

/** Model-facing business failures never include transport details, causes or URLs. */
export function mediaToolFailure(code: string, message: string, meta?: MediaToolFailureMeta): MediaToolFailure {
  const requestedValue = safeRequestedValue(meta)
  const alternatives = Array.isArray(meta?.alternatives) ? meta.alternatives.slice(0, 8).flatMap(value => {
    const parsed = imageRequestedSpecSchema.safeParse(value)
    if (parsed.success && Object.keys(parsed.data).length > 0) return [parsed.data]
    const video = videoRequestedSpecSchema.safeParse(value)
    return video.success && Object.keys(video.data).length > 0 ? [video.data] : []
  }) : undefined
  const error = { code: safeText(code), message: safeText(message),
    ...(meta?.businessCode && /^[A-Z][A-Z0-9_]{0,95}$/.test(meta.businessCode) ? { businessCode: meta.businessCode } : {}),
    ...(meta?.field && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(meta.field) ? { field: meta.field } : {}),
    ...(meta?.stage && /^[a-z][a-z0-9-]{0,63}$/.test(meta.stage) ? { stage: meta.stage } : {}),
    ...(meta?.recovery && /^[a-z][a-z0-9_-]{0,63}$/.test(meta.recovery) ? { recovery: meta.recovery } : {}),
    ...(meta?.source && SOURCES.has(meta.source) ? { source: meta.source } : {}),
    ...(requestedValue === undefined ? {} : { requestedValue }),
    ...(meta?.reasonCode && /^[A-Z][A-Z0-9_]{0,95}$/.test(meta.reasonCode) ? { reasonCode: meta.reasonCode } : {}),
    ...(alternatives?.length ? { alternatives } : {}),
    ...(meta?.submissionState && SUBMISSION_STATES.has(meta.submissionState) ? { submissionState: meta.submissionState } : {}),
    ...(meta?.billingState && BILLING_STATES.has(meta.billingState) ? { billingState: meta.billingState } : {}),
    ...(typeof meta?.retryable === 'boolean' ? { retryable: meta.retryable } : {}) }
  return { ok: false, error }
}

export function mediaToolFailureFrom(error: unknown, cancelled = false): MediaToolFailure {
  if (error instanceof AppError) {
    const details = error.details ?? {}
    return mediaToolFailure(error.code, isMediaSpecError(error.code) ? ERROR_CODES[error.code].message : error.userMessage, {
      businessCode: typeof details.businessCode === 'string' ? details.businessCode : undefined,
      field: typeof details.field === 'string' ? details.field : undefined,
      stage: typeof details.stage === 'string' ? details.stage : undefined,
      recovery: typeof details.recovery === 'string' ? details.recovery : undefined,
      source: typeof details.source === 'string' ? details.source : undefined,
      requestedValue: ['string', 'number', 'boolean'].includes(typeof details.requestedValue) ? details.requestedValue as string | number | boolean : undefined,
      reasonCode: typeof details.reasonCode === 'string' ? details.reasonCode : undefined,
      alternatives: Array.isArray(details.alternatives) ? details.alternatives as MediaSpecFailureContext['alternatives'] : undefined,
      submissionState: typeof details.submissionState === 'string' ? details.submissionState : undefined,
      billingState: typeof details.billingState === 'string' ? details.billingState : undefined,
      retryable: typeof details.retryable === 'boolean' ? details.retryable : undefined,
    })
  }
  return cancelled
    ? mediaToolFailure('MEDIA_CANCELLED', 'Media tool call cancelled.')
    : mediaToolFailure('MEDIA_FAILED', 'Media tool request failed.')
}

/** Specification diagnostics use public registry text, never free-form upstream messages. */
export function mediaSpecToolFailureFrom(error: AppError): MediaToolFailure {
  const failure = mediaToolFailureFrom(error)
  return { ...failure, error: { ...failure.error, message: ERROR_CODES[error.code].message } }
}
