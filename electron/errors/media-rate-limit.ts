import { rateLimitRetryDelay } from '../common/rate-limit-retry'
import type { MediaRetryGate } from '../domain/media-retry-gate'
import { AppError } from './app-error'

const nonTransient = new Set(['INSUFFICIENT_FUNDS', 'INSUFFICIENT_QUOTA', 'PROVIDER_QUOTA_EXHAUSTED', 'BUDGET_EXCEEDED', 'VIDEO_BUDGET_EXCEEDED'])

export function mediaRateLimit(error: unknown, now: number, fallbackMs: number): MediaRetryGate | undefined {
  if (!(error instanceof AppError)) return undefined
  const diagnostic = error.diagnostic
  if (error.code !== 'RATE_LIMITED' && error.details?.statusCode !== 429 && diagnostic?.httpStatus !== 429 && diagnostic?.computeStatus !== 429) return undefined
  const codes = [error.code, error.details?.businessCode, diagnostic?.code]
  const automatic = diagnostic?.retryable !== false && !codes.some(code => typeof code === 'string' && nonTransient.has(code.toUpperCase()))
  const retryAfter = rateLimitRetryDelay(diagnostic ?? {}, now)
  return { retryAt: Math.min(Number.MAX_SAFE_INTEGER, now + (retryAfter ?? (automatic ? fallbackMs : 0))), automatic }
}

export function mediaCooldownError(retryAt: number, now = Date.now()): AppError {
  return new AppError('RATE_LIMITED', { details: { retryAfterMs: Math.max(0, retryAt - now) } })
}
