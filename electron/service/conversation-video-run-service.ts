import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { VideoRunPort, VideoHostTools } from '../domain/video-tools'
import type { VideoScope } from '../domain/video-media'
import { videoDefaultRecoveryExclusions } from '../domain/video-media'
import { abortableVideo } from '../data/video-files'
import { AppError } from '../errors/app-error'
import { isErrorCode } from '../errors/error-codes'
import { ArrangementMediaRecoveryError } from '../domain/arrangement-media-runtime'
import { logger } from '../common/logger'
import { requireScope } from './scope-guard'
import { hasVideoTrackingOwner, MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'
import { RUNTIME_FAILURE_MESSAGES } from '../../src/shared/runtime-feedback'

type RunInput = Parameters<VideoRunPort['prepareRun']>[0]
interface ConversationVideoRun {
  input: RunInput
  scope: VideoScope
  revision: number
  taskSubscriptionId: string | null | undefined
  controller: AbortController
  wait: { controller: AbortController; timer?: ReturnType<typeof setTimeout> }
  jobs: Set<string>
  host: MockVideoHostService
  recovery?: Promise<void>
}
const generating = new Set(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'])
const recoverable = new Set(['INVALID_STATE', 'NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED'])
const MAX_RECOVERY_DELAY_MS = 30_000
const DEFAULT_WAIT_BUDGET_MS = 30 * 60_000
const log = logger.child('conversation-video-run')

/** Conversation-only recovery of original jobs; arrangement keeps its existing run facade. */
export class ConversationVideoRunService implements VideoRunPort {
  private readonly runs = new Map<string, ConversationVideoRun>()

  constructor(private readonly base: VideoRunPort, private readonly options: MockVideoHostOptions,
    private readonly waitBudgetMs = DEFAULT_WAIT_BUDGET_MS) {}

  private key(taskId: string, runId: string): string { return JSON.stringify([taskId, runId]) }

  private startWait(wait: ConversationVideoRun['wait']): void {
    if (!wait.timer) {
      wait.timer = setTimeout(() => wait.controller.abort(new Error(RUNTIME_FAILURE_MESSAGES.MEDIA_WAIT_EXPIRED)), this.waitBudgetMs)
      wait.timer.unref()
    }
  }

  private validate(run: ConversationVideoRun): void {
    run.controller.signal.throwIfAborted()
    const { subscriptionId: _subscriptionId, ...owner } = run.scope
    if (!isDeepStrictEqual(owner, requireScope(this.options.scope)) || run.revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
  }

  async prepareRun(input: RunInput): Promise<VideoHostTools | undefined> {
    const owner = structuredClone(requireScope(this.options.scope))
    const revision = this.options.authorizationRevision()
    const task = await this.options.getTask(input.taskId)
    if (!task || revision !== this.options.authorizationRevision() || !isDeepStrictEqual(owner, requireScope(this.options.scope))) throw new AppError('AUTH_REQUIRED')
    const jobs = new Set<string>()
    const wait: ConversationVideoRun['wait'] = { controller: new AbortController() }
    const raw = await this.base.prepareRun({ ...input, onJobCreated: async job => {
      await input.onJobCreated?.(job)
      for (const id of job.previousUnconfirmedJobIds ?? []) jobs.delete(id)
      jobs.add(job.jobId)
      this.startWait(wait)
    } })
    if (!raw) return undefined
    const scope = { ...owner, subscriptionId: input.subscriptionId }
    const run: ConversationVideoRun = {
      input, scope, revision, taskSubscriptionId: task.subscriptionId, controller: new AbortController(), jobs, wait,
      host: new MockVideoHostService({ ...this.options, trackingJobIds: jobs,
        getTask: async taskId => {
          this.validate(run)
          const current = await this.options.getTask(taskId)
          this.validate(run)
          if (taskId !== input.taskId || !current || current.subscriptionId !== run.taskSubscriptionId) throw new AppError('AUTH_REQUIRED')
          return { subscriptionId: input.subscriptionId }
        },
      }),
    }
    this.runs.set(this.key(input.taskId, input.runId), run)
    try {
      const existing = (await this.options.store.listJobs(scope)).filter(job => job.taskId === input.taskId &&
        (job.executionMode ?? 'mock') === (this.options.mock ? 'mock' : 'real'))
      this.validate(run)
      const excluded = videoDefaultRecoveryExclusions(existing)
      for (const job of existing) {
        if (input.recoverJobIds ? !input.recoverJobIds.includes(job.jobId) : excluded.has(job.jobId)) continue
        if (job.submission !== 'NOT_SENT' && (generating.has(job.receipt?.status ?? 'SUBMISSION_UNKNOWN') ||
          ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.receipt?.status ?? '') && job.saveStatus !== 'SAVED')) jobs.add(job.jobId)
      }
    } catch (error) {
      await this.closeRun(this.key(input.taskId, input.runId), run, true)
      throw error
    }
    return { names: raw.names, execute: async (name, args, parent) => {
      this.validate(run)
      const generation = name !== 'video_get_job'
      const signal = AbortSignal.any([run.controller.signal, ...(generation ? [run.wait.controller.signal] : []), ...(parent ? [parent] : [])])
      signal.throwIfAborted()
      const before = new Set(jobs)
      try { return await abortableVideo(raw.execute(name, args, signal), signal) } catch (error) {
        signal.throwIfAborted()
        const created = [...jobs].filter(id => !before.has(id))
        if (name === 'video_get_job' || !created.length || !(error instanceof AppError) || !recoverable.has(error.code)) throw error
        await this.recover(run, signal, error)
        await abortableVideo(this.base.waitForRun(input.taskId, input.runId, { recoverOriginal: true, signal }), signal)
        return raw.execute('video_get_job', { jobId: created[0] }, signal)
      }
    } }
  }

  async waitForRun(taskId: string, runId: string, options: { recoverOriginal?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const run = this.runs.get(this.key(taskId, runId))
    if (!run) return this.base.waitForRun(taskId, runId, { ...options, recoverOriginal: true })
    this.validate(run)
    const parent = AbortSignal.any([run.controller.signal, ...(options.signal ? [options.signal] : [])])
    parent.throwIfAborted()
    if (run.wait.controller.signal.aborted) {
      const view = await abortableVideo(run.host.getTaskVideo(taskId), parent)
      this.validate(run)
      if ([...run.jobs].every(id => view.jobs.some(job => job.jobId === id && job.saveStatus === 'SAVED' &&
        ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)))) return
      throw run.wait.controller.signal.reason
    }
    if (run.jobs.size) this.startWait(run.wait)
    const signal = AbortSignal.any([parent, run.wait.controller.signal])
    try { await abortableVideo(this.base.waitForRun(taskId, runId, { recoverOriginal: true, signal }), signal) } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof ArrangementMediaRecoveryError) && (!(error instanceof AppError) || !recoverable.has(error.code))) throw error
      await this.recover(run, signal, error)
      await abortableVideo(this.base.waitForRun(taskId, runId, { recoverOriginal: true, signal }), signal)
    }
  }

  private async recover(run: ConversationVideoRun, signal: AbortSignal, original: unknown): Promise<void> {
    if (!run.recovery) {
      run.recovery = this.trackOriginal(run, signal, original).finally(() => { run.recovery = undefined })
    }
    await abortableVideo(run.recovery, signal)
  }

  private async trackOriginal(run: ConversationVideoRun, signal: AbortSignal, original: unknown): Promise<void> {
    const nowMs = this.options.now ?? Date.now
    const floor = this.options.tracker?.floorMs ?? 1000
    let failures = 0
    let nextQueryRoundAt = nowMs() + Math.max(floor, 1000)
    const saveRecoveries = new Map<string, { attempts: number; nextAt: number }>()
    const expiredSaves = new Set<string>()
    for (;;) {
      signal.throwIfAborted()
      this.validate(run)
      const jobs = await this.options.store.listJobs(run.scope)
      this.validate(run)
      const relevant = jobs.filter(job => job.taskId === run.input.taskId && run.jobs.has(job.jobId))
      const denied = relevant.find(job => job.trackingStatus === 'AUTH_REQUIRED')
      if (denied) throw new AppError(denied.error === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'AUTH_REQUIRED', { cause: original })
      const pending = relevant.filter(job => job.submission !== 'NOT_SENT' && generating.has(job.receipt?.status ?? 'SUBMISSION_UNKNOWN'))
      const failedSaves = relevant.filter(job => ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.receipt?.status ?? '') &&
        ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus))
      const now = nowMs()
      const queryAt = Math.min(...pending.filter(job => job.trackingStatus !== 'STOPPED' && job.queryRateLimit?.automatic !== false &&
        (!job.receipt || job.receipt.recovery.canQuery)).map(job => Math.max(nextQueryRoundAt,
        job.lastQueriedAt === undefined ? 0 : job.lastQueriedAt + Math.max(floor, job.receipt?.pollAfterMs ?? 0), job.queryRateLimit?.retryAt ?? 0)))
      const download = failedSaves.filter(job => job.receipt?.recovery.canDownload && job.downloadRateLimit?.automatic !== false &&
        !expiredSaves.has(job.jobId) && isErrorCode(job.error) && recoverable.has(job.error)).map(job => {
        const schedule = saveRecoveries.get(job.jobId) ?? { attempts: 0, nextAt: now + floor }
        saveRecoveries.set(job.jobId, schedule)
        return { job, at: Math.max(schedule.nextAt, job.downloadRateLimit?.retryAt ?? 0), schedule }
      }).sort((a, b) => a.at - b.at)[0]
      if (queryAt === Infinity && !download) {
        if (pending.length) throw original
        if (failedSaves.some(job => job.downloadRateLimit?.automatic === false)) throw new ArrangementMediaRecoveryError('download', original)
        if (failedSaves.length) throw new AppError('INVALID_STATE', { cause: original })
        if (!relevant.length) throw original
        return
      }
      if (download && download.at <= queryAt) {
        const downloadable = download.job
        for (const output of downloadable.receipt!.outputs) {
          if (!output.expiresAt || Date.parse(output.expiresAt) > download.at) continue
          try {
            const asset = await this.options.store.getAsset(run.scope, run.input.taskId, downloadable.jobId, output.outputId)
            if (asset?.status === 'SAVED') continue
          } catch {
            // Treat unreadable local state as missing and let the save path report its concrete failure.
          }
          expiredSaves.add(downloadable.jobId)
          break
        }
        if (expiredSaves.has(downloadable.jobId)) continue
        const delayMs = download.at - nowMs()
        if (delayMs > 2_147_483_647) throw new ArrangementMediaRecoveryError('download', original)
        if (delayMs > 0) await delay(delayMs, undefined, { signal })
        this.validate(run)
        try {
          await abortableVideo(run.host.retrySave(run.input.taskId, downloadable.jobId, signal, true), signal)
        } catch (error) {
          signal.throwIfAborted()
          this.validate(run)
          if (!(error instanceof AppError) || !recoverable.has(error.code)) throw error
        }
        const attempts = Math.min(download.schedule.attempts + 1, 52)
        saveRecoveries.set(downloadable.jobId, { attempts, nextAt: nowMs() + Math.min(MAX_RECOVERY_DELAY_MS, floor * 2 ** attempts) })
        continue
      }
      // Wake for the first due job; the tracker will skip siblings whose deadlines have not arrived.
      const interval = queryAt - nowMs()
      if (interval > 2_147_483_647) throw new ArrangementMediaRecoveryError('query', original)
      if (interval > 0) await delay(interval, undefined, { signal })
      this.validate(run)
      try {
        await abortableVideo(run.host.track(run.input.taskId), signal)
        failures = 0
      } catch (error) {
        signal.throwIfAborted()
        this.validate(run)
        log.warn('original conversation video tracking interrupted', { taskId: run.input.taskId, runId: run.input.runId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
        if (!(error instanceof AppError) || !recoverable.has(error.code) || ++failures >= 3) throw error
      }
      nextQueryRoundAt = nowMs() + Math.max(floor, Math.min(30_000, 1000 * 2 ** failures))
    }
  }

  diagnosticJobIds(taskId: string, runId: string): readonly string[] {
    return [...(this.runs.get(this.key(taskId, runId))?.jobs ?? []), ...(this.base.diagnosticJobIds?.(taskId, runId) ?? [])]
  }

  async stopTask(taskId: string): Promise<void> {
    const runs = [...this.runs.entries()].filter(([, run]) => run.input.taskId === taskId)
    await Promise.all([this.base.stopTask(taskId), ...runs.map(([key, run]) => this.closeRun(key, run, false))])
  }

  private async closeRun(key: string, run: ConversationVideoRun, stopBase: boolean): Promise<void> {
    const { taskId, runId } = run.input
    clearTimeout(run.wait.timer)
    run.controller.abort(new Error('Conversation video run closed.'))
    const baseCleanup = stopBase ? this.base.stopRun?.(taskId, runId) ?? this.base.finishRun?.(taskId, runId) : undefined
    await Promise.all([baseCleanup, run.host.stopAll(), run.recovery?.catch(() => undefined)])
    if (this.runs.get(key) !== run) return
    this.runs.delete(key)
    if (!stopBase || !run.wait.controller.signal.aborted) return
    for (const jobId of run.jobs) {
      try {
        await this.options.store.updateJob(run.scope, taskId, jobId, job =>
          !this.runs.has(key) && !hasVideoTrackingOwner(run.scope, taskId, jobId) && job.submission !== 'NOT_SENT' &&
          job.trackingStatus === 'ACTIVE' && generating.has(job.receipt?.status ?? 'SUBMISSION_UNKNOWN')
            ? { ...job, trackingStatus: 'INTERRUPTED', updatedAt: Math.max(job.updatedAt, (this.options.now ?? Date.now)()) } : job)
      } catch { log.warn('video wait interruption could not be persisted', { taskId, jobId }) }
    }
  }

  async finishRun(taskId: string, runId: string): Promise<void> {
    const key = this.key(taskId, runId), run = this.runs.get(key)
    const expired = run?.wait.controller.signal.aborted === true
    if (run) await this.closeRun(key, run, expired)
    if (expired) return
    await this.base.finishRun?.(taskId, runId)
  }
}
