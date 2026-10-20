import type { LocalVideoJob } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { videoBillingPending } from '../../src/shared/video-media'

export interface VideoTrackerPort {
  recover(signal?: AbortSignal): Promise<LocalVideoJob[]>
  resume(taskId: string, jobId: string, signal?: AbortSignal): Promise<LocalVideoJob>
}

export interface VideoTrackerOptions {
  service: VideoTrackerPort
  floorMs?: number
  /** Caps error backoff only; server pollAfterMs may be longer. */
  maxDelayMs?: number
  maxAttempts?: number
  budgetMs?: number
  now?: () => number
  /** Must settle on abort and release any timers/listeners it owns. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

const terminal = new Set(['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'])
const retryable = new Set(['RATE_LIMITED', 'NETWORK_ERROR'])
const MAX_TIMER_MS = 2_147_483_647

function positive(value: number, name: string, maximum = MAX_TIMER_MS): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`Invalid video tracker ${name}.`)
  return value
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const aborted = (): void => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function pollable(job: LocalVideoJob): boolean {
  if (job.submission === 'NOT_SENT' || job.trackingStatus === 'STOPPED') return false
  if (!job.receipt) return true
  const billingPending = !job.receipt.mock && videoBillingPending(job.receipt.billingStatus)
  return (!terminal.has(job.receipt.status) || billingPending) && job.receipt.recovery.canQuery && (job.receipt.pollAfterMs !== null || billingPending)
}

/** One authenticated scope per instance. No explicit resume, dispatch or runtime wiring. */
export class VideoTracker {
  private readonly service: VideoTrackerPort
  private readonly floorMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number
  private readonly budgetMs: number
  private readonly now: () => number
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>
  private started = false
  private stopped = false
  private active?: { controller: AbortController; promise: Promise<void> }

  constructor(options: VideoTrackerOptions) {
    this.service = options.service
    this.floorMs = positive(options.floorMs ?? 1000, 'floorMs')
    this.maxDelayMs = positive(options.maxDelayMs ?? 30_000, 'maxDelayMs')
    this.maxAttempts = positive(options.maxAttempts ?? 120, 'maxAttempts', Number.MAX_SAFE_INTEGER)
    this.budgetMs = positive(options.budgetMs ?? 30 * 60_000, 'budgetMs')
    if (this.maxDelayMs < this.floorMs) throw new RangeError('Video tracker maxDelayMs is below floorMs.')
    this.now = options.now ?? Date.now
    this.delay = options.delay ?? delay
  }

  /** Idempotent startup; resolves when idle, paused, bounded or stopped. */
  start(): Promise<void> {
    if (this.started || this.stopped) return this.active?.promise ?? Promise.resolve()
    this.started = true
    return this.launch()
  }

  /** Host calls this after explicit service.resume. Active rounds coalesce without bypassing backoff. */
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.started = true
    return this.active?.promise ?? this.launch()
  }

  /** Permanent stop; cooperative service operations must settle after their signal aborts. */
  async stop(): Promise<void> {
    this.stopped = true
    const active = this.active
    active?.controller.abort()
    await active?.promise
  }

  private launch(): Promise<void> {
    const controller = new AbortController()
    const active = { controller, promise: Promise.resolve() }
    this.active = active
    active.promise = Promise.resolve().then(() => this.run(controller)).finally(() => {
      if (this.active === active) this.active = undefined
    })
    // Keep a detached host start safe; callers still receive the original rejection.
    void active.promise.catch(() => undefined)
    return active.promise
  }

  private async run(controller: AbortController): Promise<void> {
    const { signal } = controller
    if (signal.aborted) return
    const startedAt = this.now()
    const deadline = this.delay(this.budgetMs, signal).then(() => controller.abort(), error => {
      if (!signal.aborted) { controller.abort(); throw error }
    })
    void deadline.catch(() => undefined)
    let failures = 0
    try {
      for (let attempt = 0; attempt < this.maxAttempts && !signal.aborted; attempt++) {
        if (this.now() - startedAt >= this.budgetMs) return
        let waitMs: number
        try {
          const jobs = await this.service.recover(signal)
          if (signal.aborted || jobs.some(job => job.trackingStatus === 'AUTH_REQUIRED')) return
          const pending = jobs.filter(pollable)
          if (!pending.length) return
          const failed = pending.some(job => job.error !== null && retryable.has(job.error))
          failures = failed ? failures + 1 : 0
          // recover polls the whole scope, so every sibling's minimum interval must elapse.
          const advertised = pending.reduce((ms, job) => Math.max(ms, job.receipt?.pollAfterMs ?? this.floorMs), this.floorMs)
          waitMs = Number.isFinite(advertised) ? Math.ceil(advertised) : this.budgetMs
          if (failed) waitMs = Math.max(waitMs, this.backoff(failures))
        } catch (error) {
          if (signal.aborted) return
          if (error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')) return
          if (!(error instanceof AppError) || !retryable.has(error.code)) throw error
          waitMs = this.backoff(++failures)
        }
        if (attempt + 1 >= this.maxAttempts) return
        const remaining = this.budgetMs - (this.now() - startedAt)
        if (remaining <= waitMs || signal.aborted) return
        await this.delay(waitMs, signal)
      }
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      controller.abort()
      await deadline
    }
  }

  private backoff(failures: number): number {
    return Math.min(this.maxDelayMs, this.floorMs * 2 ** Math.min(failures - 1, 52))
  }
}
