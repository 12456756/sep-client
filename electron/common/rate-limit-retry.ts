import { setTimeout as delay } from 'node:timers/promises'
import type { ApiDiagnostic } from '../../src/shared/api-diagnostic'
import { AppError } from '../errors/app-error'
import { parseRetryAfter, readApiDiagnostic } from './platform/api-diagnostic'
import { logger } from './logger'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function rateLimitRetryDelay(diagnostic: { headers?: Record<string, string>; body?: unknown; httpStatus?: number }, now = Date.now()): number | undefined {
  const headers = new Headers(diagnostic.headers)
  const standard = parseRetryAfter(headers.get('retry-after'), now)
  if (standard !== undefined && Number.isSafeInteger(standard)) return standard
  const body = record(diagnostic.body), error = record(body.error), limit = record(error.rateLimit)
  for (const seconds of [body.retryAfterSeconds, error.retryAfterSeconds, limit.retryAfterSeconds]) {
    if (typeof seconds === 'number' && seconds >= 0 && Number.isFinite(seconds) && Number.isSafeInteger(Math.ceil(seconds * 1000))) return Math.ceil(seconds * 1000)
  }
  for (const name of ['retry-after-auth', 'retry-after-chat']) {
    const named = parseRetryAfter(headers.get(name), now)
    if (named !== undefined && Number.isSafeInteger(named)) return named
  }
  const ms = headers.get('retry-after-ms')
  return ms !== null && /^\d+(?:\.\d+)?$/.test(ms) && Number.isSafeInteger(Math.ceil(Number(ms))) ? Math.ceil(Number(ms)) : undefined
}

export function rateLimitDiagnostic(error: unknown): ApiDiagnostic | undefined {
  const item = record(error), embedded = record(item.error), details = record(item.details)
  const diagnostic = record(item.diagnostic ?? embedded.diagnostic) as ApiDiagnostic
  const status = diagnostic.httpStatus ?? item.statusCode ?? embedded.statusCode ?? details.statusCode
  if (status !== 429) return undefined
  const retryAfterMs = item.retryAfterMs ?? embedded.retryAfterMs
  return { ...diagnostic, httpStatus: 429, ...(diagnostic.headers || typeof retryAfterMs !== 'number' ? {} : {
    headers: { 'retry-after-ms': String(retryAfterMs) },
  }) }
}

export interface RateLimitWait {
  retryAt: number
  diagnostic: ApiDiagnostic
}
interface RateLimitRetryOptions {
  signal?: AbortSignal
  timeoutMs?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  onWait?: (wait: RateLimitWait | undefined) => void | Promise<void>
  shouldRetry?: (error: unknown) => boolean
  preserveWaitOnAbort?: boolean
}

export async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  // Node clamps overflowing timers to 1ms; retain long server deadlines in chunks.
  let remaining = ms
  do {
    const chunk = Math.min(2_147_483_647, Math.max(1, remaining))
    await delay(chunk, undefined, { signal })
    remaining -= chunk
  } while (remaining > 0)
}

async function attempt<T>(call: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs?: number): Promise<T> {
  const controller = new AbortController()
  const signal = AbortSignal.any([parent, controller.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  let aborted = () => {}
  try {
    signal.throwIfAborted()
    if (timeoutMs !== undefined) timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
    return await Promise.race([call(signal), new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', aborted)
  }
}

/** Only an actual HTTP 429 retries the same call. Network uncertainty is left to original-request recovery. */
export async function retryRateLimited<T>(call: (signal: AbortSignal) => Promise<T>, options: RateLimitRetryOptions = {}): Promise<T> {
  const signal = options.signal ?? new AbortController().signal
  let failures = 0
  let waiting = false
  try {
    for (;;) {
      signal.throwIfAborted()
      try { return await attempt(call, signal, options.timeoutMs) } catch (error) {
        signal.throwIfAborted()
        const diagnostic = rateLimitDiagnostic(error)
        if (!diagnostic) throw error
        const body = record(diagnostic.body), nested = record(body.error)
        if ((nested.code ?? body.code ?? diagnostic.code) === 'GATEWAY_AUTH_RATE_LIMIT_EXCEEDED') {
          throw new AppError('AUTH_REQUIRED', { message: '雇佣令牌认证失败次数过多，请恢复有效授权后再试。', diagnostic,
            details: error instanceof AppError ? error.details : undefined, cause: error })
        }
        if (options.shouldRetry?.(error) === false) throw error
        const ms = rateLimitRetryDelay(diagnostic) ?? Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
        failures++
        waiting = true
        await options.onWait?.({ retryAt: Date.now() + ms, diagnostic })
        logger.child('rate-limit').warn('request rate limited; waiting to retry original operation', { retry: failures, waitMs: ms, diagnostic })
        await (options.sleep ?? waitForRetry)(ms, signal)
      }
    }
  } finally {
    if (waiting && !(options.preserveWaitOnAbort && signal.aborted)) await options.onWait?.(undefined)
  }
}

export async function fetchRateLimited(call: (signal: AbortSignal) => Promise<Response>, options: RateLimitRetryOptions & {
  operation?: string
  secrets?: readonly string[]
} = {}): Promise<Response> {
  return retryRateLimited(async signal => {
    const response = await call(signal)
    if (response.status !== 429) return response
    const diagnostic = await readApiDiagnostic(response, options.operation, { signal, secrets: options.secrets })
    throw new AppError('RATE_LIMITED', { diagnostic })
  }, options)
}
