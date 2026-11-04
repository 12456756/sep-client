import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { VideoRunPort, VideoHostTools } from '../domain/video-tools'
import type { VideoScope } from '../domain/video-media'
import { abortableVideo } from '../data/video-files'
import { AppError } from '../errors/app-error'
import { isErrorCode } from '../errors/error-codes'
import { ArrangementMediaRecoveryError } from '../domain/arrangement-media-runtime'
import { logger } from '../common/logger'
import { requireScope } from './scope-guard'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'

type RunInput = Parameters<VideoRunPort['prepareRun']>[0]
interface ConversationVideoRun {
  input: RunInput
  scope: VideoScope
  revision: number
  taskSubscriptionId: string | null | undefined
  controller: AbortController
  jobs: Set<string>
  host: MockVideoHostService
  recovery?: Promise<void>
}
const generating = new Set(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'])
const recoverable = new Set(['INVALID_STATE', 'NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED'])
const MAX_RECOVERY_DELAY_MS = 30_000
const log = logger.child('conversation-video-run')

/** Conversation-only recovery of original jobs; arrangement keeps its existing run facade. */
export class ConversationVideoRunService implements VideoRunPort {
  private readonly runs = new Map<string, ConversationVideoRun>()

  constructor(private readonly base: VideoRunPort, private readonly options: MockVideoHostOptions) {}

  private key(taskId: string, runId: string): string { return JSON.stringify([taskId, runId]) }

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
    const raw = await this.base.prepareRun({ ...input, onJobCreated: async job => {
      await input.onJobCreated?.(job)
      jobs.add(job.jobId)
    } })
    if (!raw) return undefined
    const scope = { ...owner, subscriptionId: input.subscriptionId }
    const run: ConversationVideoRun = {
      input, scope, revision, taskSubscriptionId: task.subscriptionId, controller: new AbortController(), jobs,
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
      const existing = await this.options.store.listJobs(scope)
      this.validate(run)
      for (const job of existing) {
        if (job.taskId !== input.taskId || input.recoverJobIds && !input.recoverJobIds.includes(job.jobId)) continue
        if ((job.executionMode ?? 'mock') !== (this.options.mock ? 'mock' : 'real')) continue
        if (job.submission !== 'NOT_SENT' && (generating.has(job.receipt?.status ?? 'SUBMISSION_UNKNOWN') ||
          ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.receipt?.status ?? '') && job.saveStatus !== 'SAVED')) jobs.add(job.jobId)
      }
    } catch (error) {
      await this.stopTask(input.taskId)
      throw error
    }
    return { names: raw.names, execute: async (name, args, parent) => {
      this.validate(run)
      const signal = AbortSignal.any([run.controller.signal, ...(parent ? [parent] : [])])
      const before = new Set(jobs)
      try { return await raw.execute(name, args, signal) } catch (error) {
        signal.throwIfAborted()
        const created = [...jobs].filter(id => !before.has(id))
        if (name === 'video_get_job' || !created.length || !(error instanceof AppError) || !recoverable.has(error.code)) throw error
        await this.recover(run, signal, error)
        await this.base.waitForRun(input.taskId, input.runId, { recoverOriginal: true, signal })
        return raw.execute('video_get_job', { jobId: created[0] }, signal)
      }
    } }
  }

  async waitForRun(taskId: string, runId: string, options: { recoverOriginal?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const run = this.runs.get(this.key(taskId, runId))
    if (!run) return this.base.waitForRun(taskId, runId, { ...options, recoverOriginal: true })
    const signal = AbortSignal.any([run.controller.signal, ...(options.signal ? [options.signal] : [])])
    this.validate(run)
    try { await this.base.waitForRun(taskId, runId, { recoverOriginal: true, signal }) } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof ArrangementMediaRecoveryError) && (!(error instanceof AppError) || !recoverable.has(error.code))) throw error
      await this.recover(run, signal, error)
      await this.base.waitForRun(taskId, runId, { recoverOriginal: true, signal })
    }
  }

  private async recover(run: ConversationVideoRun, signal: AbortSignal, original: unknown): Promise<void> {
    if (!run.recovery) {
      run.recovery = this.trackOriginal(run, signal, original).finally(() => { run.recovery = undefined })
    }
    await abortableVideo(run.recovery, signal)
  }

  private async trackOriginal(run: ConversationVideoRun, signal: AbortSignal, original: unknown): Promise<void> {
    let failures = 0
    const saveRecoveries = new Map<string, number>()
    for (;;) {
      signal.throwIfAborted()
      this.validate(run)
      const jobs = await this.options.store.listJobs(run.scope)
      this.validate(run)
      const relevant = jobs.filter(job => job.taskId === run.input.taskId && run.jobs.has(job.jobId))
      const denied = relevant.find(job => job.trackingStatus === 'AUTH_REQUIRED')
      if (denied) throw new AppError(denied.error === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'AUTH_REQUIRED', { cause: original })
      const pending = relevant.filter(job => job.submission !== 'NOT_SENT' && generating.has(job.receipt?.status ?? 'SUBMISSION_UNKNOWN'))
      const failedSave = relevant.find(job => ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.receipt?.status ?? '') &&
        ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus))
      const downloadable = failedSave?.receipt?.recovery.canDownload ? failedSave : undefined
      if (!pending.length && !downloadable) {
        if (failedSave) throw new AppError('INVALID_STATE', { cause: original })
        if (!relevant.length) throw original
        return
      }
      if (pending.some(job => job.trackingStatus === 'STOPPED' || job.receipt && !job.receipt.recovery.canQuery)) throw original
      if (!pending.length && downloadable) {
        if (!isErrorCode(downloadable.error) || !recoverable.has(downloadable.error)) throw new AppError('INVALID_STATE', { cause: original })
        for (const output of downloadable.receipt!.outputs) {
          if (!output.expiresAt || Date.parse(output.expiresAt) > Date.now()) continue
          try {
            const asset = await this.options.store.getAsset(run.scope, run.input.taskId, downloadable.jobId, output.outputId)
            if (asset?.status === 'SAVED') continue
          } catch {
            // Treat unreadable local state as missing and let the save path report its concrete failure.
          }
          throw new AppError('INVALID_STATE', { cause: original })
        }
        const nextAttempt = Math.min((saveRecoveries.get(downloadable.jobId) ?? 0) + 1, 52)
        saveRecoveries.set(downloadable.jobId, nextAttempt)
        const floor = this.options.tracker?.floorMs ?? 1000
        const delayMs = Math.min(MAX_RECOVERY_DELAY_MS, Math.max(floor, downloadable.receipt?.pollAfterMs ?? 0) * 2 ** (nextAttempt - 1))
        await delay(delayMs, undefined, { signal })
        this.validate(run)
        try {
          await abortableVideo(run.host.retrySave(run.input.taskId, downloadable.jobId), signal)
        } catch (error) {
          signal.throwIfAborted()
          this.validate(run)
          if (!(error instanceof AppError) || !recoverable.has(error.code)) throw error
        }
        continue
      }
      // Respect the original receipt's polling interval across bounded tracker rounds.
      const interval = Math.max(this.options.tracker?.floorMs ?? 1000, ...pending.map(job => job.receipt?.pollAfterMs ?? 1000),
        Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)))
      await delay(interval, undefined, { signal })
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
    }
  }

  async stopTask(taskId: string): Promise<void> {
    const runs = [...this.runs.entries()].filter(([, run]) => run.input.taskId === taskId)
    for (const [, run] of runs) run.controller.abort(new Error('Conversation video stopped.'))
    await Promise.all([this.base.stopTask(taskId), ...runs.map(async ([key, run]) => {
      await run.host.stopAll()
      await run.recovery?.catch(() => undefined)
      if (this.runs.get(key) === run) this.runs.delete(key)
    })])
  }

  async finishRun(taskId: string, runId: string): Promise<void> {
    const key = this.key(taskId, runId), run = this.runs.get(key)
    if (run) {
      run.controller.abort(new Error('Conversation video finished.'))
      await run.host.stopAll()
      await run.recovery?.catch(() => undefined)
      if (this.runs.get(key) === run) this.runs.delete(key)
    }
    await this.base.finishRun?.(taskId, runId)
  }
}
