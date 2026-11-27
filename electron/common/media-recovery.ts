import { AppError } from '../errors/app-error'
import { rateLimitRetryDelay } from './rate-limit-retry'

/** A saved receipt or upstream response switches creation to original-request recovery. */
export function mediaSubmissionRecovery(error: unknown, clientRequestId: string, now = Date.now()): {
  receiptId?: string; retryAt?: number
} | undefined {
  const diagnostic = error instanceof AppError ? error.diagnostic : undefined
  if (!diagnostic || diagnostic.httpStatus === undefined || diagnostic.httpStatus < 400) return undefined
  const headers = new Headers(diagnostic.headers)
  const receiptId = headers.get('x-sep-receipt-id') ?? diagnostic.sepReceiptId
  const originalId = headers.get('x-sep-client-request-id') ?? diagnostic.clientRequestId
  if (diagnostic.source !== 'upstream' && !receiptId) return undefined
  const correlated = originalId === clientRequestId && typeof receiptId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(receiptId)
  const waitMs = rateLimitRetryDelay(diagnostic, now) ?? (diagnostic.httpStatus === 429 ? 1000 : undefined)
  return { ...(correlated ? { receiptId } : {}), ...(waitMs === undefined ? {} : { retryAt: now + waitMs }) }
}

export const MEDIA_RECOVERY_DEFAULTS = {
  floorMs: 1000,
  maxDelayMs: 30_000,
  maxAttempts: 120,
  budgetMs: 30 * 60_000,
} as const

/** Provider polling hints are a minimum even when error backoff has reached its cap. */
export function mediaRecoveryDelay(attempt: number, floorMs: number = MEDIA_RECOVERY_DEFAULTS.floorMs,
  advertisedMs = 0, maxDelayMs: number = MEDIA_RECOVERY_DEFAULTS.maxDelayMs): number {
  return Math.max(advertisedMs, floorMs, Math.min(maxDelayMs, floorMs * 2 ** Math.min(Math.max(attempt - 1, 0), 52)))
}
