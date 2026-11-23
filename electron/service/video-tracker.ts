import type { LocalVideoJob } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { videoBillingPending } from '../../src/shared/video-media'
import { mediaRateLimit } from '../errors/media-rate-limit'

export type VideoTrackingSelection = (job: LocalVideoJob) => { query: boolean; download: boolean }

export interface VideoTrackerPort {
  recover(signal: AbortSignal, select: VideoTrackingSelection): Promise<LocalVideoJob[]>
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

function queryable(job: LocalVideoJob, initial: boolean): boolean {
  if (job.submission === 'NOT_SENT') return false
  if ((!initial && job.trackingStatus === 'STOPPED') || job.queryRateLimit?.automatic === false) return false
  if (!job.receipt) return true
  const billingPending = !job.receipt.mock && videoBillingPending(job.receipt.billingStatus)
  return (!terminal.has(job.receipt.status) || billingPending) && job.receipt.recovery.canQuery && (initial || job.receipt.pollAfterMs !== null || billingPending)
}

interface ActivitySchedule { at: number; attempts: number; failures: number }
interface JobSchedule { query?: ActivitySchedule; download?: ActivitySchedule }

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
  private generation = 0
  private sleeping?: AbortController
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

  /** A host mutation can request a rescan without changing any existing job deadline. */
  wake(rescan = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (rescan) {
      this.generation++
      this.sleeping?.abort()
    }
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
    const schedules = new Map<string, JobSchedule>()
    const queryAt = (job: LocalVideoJob, schedule?: ActivitySchedule, owned = true): number => {
      if (!queryable(job, owned && !schedule) || (schedule?.attempts ?? 0) >= this.maxAttempts) return Infinity
      const last = job.lastQueriedAt
      return Math.max(schedule?.at ?? 0, job.queryRateLimit?.retryAt ?? 0,
        last === undefined ? 0 : last + Math.max(this.floorMs, job.receipt?.pollAfterMs ?? 0))
    }
    const downloadAt = (job: LocalVideoJob, schedule?: ActivitySchedule): number => {
      if (job.submission === 'NOT_SENT' || job.downloadRateLimit?.automatic === false || (schedule?.attempts ?? 0) >= this.maxAttempts) return Infinity
      if (!job.receipt?.outputs.length || job.saveStatus === 'SAVED') return Infinity
      if (schedule && !(job.saveStatus === 'SAVE_FAILED' && job.downloadRateLimit?.automatic && job.receipt.recovery.canDownload)) return Infinity
      return Math.max(schedule?.at ?? 0, job.downloadRateLimit?.retryAt ?? 0)
    }
    try {
      while (!signal.aborted) {
        if (this.now() - startedAt >= this.budgetMs) return
        const generation = this.generation
        let waitMs: number
        try {
          const selected = new Map<string, ReturnType<VideoTrackingSelection>>()
          const jobs = await this.service.recover(signal, job => {
            const schedule = schedules.get(job.jobId)
            const now = this.now()
            const query = queryAt(job, schedule?.query) <= now
            const download = downloadAt(job, schedule?.download) <= now ||
              (query && !job.downloadRateLimit && (schedule?.download?.attempts ?? 0) < this.maxAttempts)
            selected.set(job.jobId, { query, download })
            return { query, download }
          })
          if (signal.aborted || jobs.some(job => job.trackingStatus === 'AUTH_REQUIRED')) return
          failures = 0
          const now = this.now()
          let next = Infinity
          for (const job of jobs) {
            const schedule = schedules.get(job.jobId) ?? {}
            const actions = selected.get(job.jobId)
            if (actions?.query) {
              const failed = !!job.queryRateLimit || (job.error !== null && retryable.has(job.error) && job.failure?.stage !== 'video-save')
              const count = failed ? (schedule.query?.failures ?? 0) + 1 : 0
              schedule.query = { at: now + Math.max(this.floorMs, job.receipt?.pollAfterMs ?? 0, count ? this.backoff(count) : 0),
                attempts: (schedule.query?.attempts ?? 0) + 1, failures: count }
            }
            if (actions?.download && job.receipt?.outputs.length) {
              const count = job.downloadRateLimit ? (schedule.download?.failures ?? 0) + 1 : 0
              schedule.download = { at: now + (count ? this.backoff(count) : this.floorMs),
                attempts: (schedule.download?.attempts ?? 0) + 1, failures: count }
            }
            if (actions) schedules.set(job.jobId, schedule)
            const due = Math.min(queryAt(job, schedule.query, !!actions), downloadAt(job, schedule.download))
            // Another host may already own this job. Observe it without polling hot.
            next = Math.min(next, actions ? due : Math.max(due, now + Math.max(this.floorMs, job.receipt?.pollAfterMs ?? 0)))
          }
          waitMs = Math.max(this.floorMs, next - now)
        } catch (error) {
          if (signal.aborted) return
          if (error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')) return
          const now = this.now()
          const backoff = this.backoff(failures + 1)
          const gate = mediaRateLimit(error, now, backoff)
          if (gate?.automatic === false) throw error
          if (!gate && (!(error instanceof AppError) || !retryable.has(error.code))) throw error
          if (++failures >= this.maxAttempts) return
          waitMs = Math.max(backoff, (gate?.retryAt ?? now) - now)
        }
        if (failures === 0 && generation !== this.generation) continue
        const remaining = this.budgetMs - (this.now() - startedAt)
        if (remaining <= waitMs || signal.aborted) return
        if (failures > 0) {
          await this.delay(waitMs, signal)
          continue
        }
        const sleeping = new AbortController()
        this.sleeping = sleeping
        try { await this.delay(waitMs, AbortSignal.any([signal, sleeping.signal])) }
        catch (error) { if (!sleeping.signal.aborted) throw error }
        finally { this.sleeping = undefined }
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
