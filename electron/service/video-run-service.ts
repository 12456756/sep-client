import { videoToolJobInputSchema } from '../../src/shared/video-host'
import { videoBillingPending, videoRuntimeSchema } from '../../src/shared/video-media'
import { videoErrorMessage } from '../../src/shared/video-errors'
import { videoLocalIdSchema } from '../domain/video-media'
import type { VideoHostTools, VideoRunPort, VideoToolName } from '../domain/video-tools'
import { AppError } from '../errors/app-error'
import { isErrorCode } from '../errors/error-codes'
import { abortableVideo } from '../data/video-files'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'
import { ArrangementMediaRecoveryError } from '../domain/arrangement-media-runtime'
import { setTimeout as delay } from 'node:timers/promises'

type RunInput = Parameters<VideoRunPort['prepareRun']>[0]
interface Run {
  taskId: string
  host: MockVideoHostService
  controller: AbortController
  pending: Set<Promise<unknown>>
  jobs: Set<string>
  tracking?: Promise<void>
  finished: boolean
  terminalFailureNotified: boolean
  onTerminalFailure?: RunInput['onTerminalFailure']
}
const names: readonly VideoToolName[] = ['video_from_image', 'video_generate', 'video_get_job']
const TERMINAL_FAILURE_CODES = new Set([
  'PERMISSION_DENIED', 'AUTH_REQUIRED', 'INSUFFICIENT_FUNDS', 'VIDEO_BUDGET_EXCEEDED',
  'MEDIA_FORBIDDEN', 'QUOTE_EXPIRED', 'VIDEO_CONCURRENCY_LIMIT',
])

function terminalVideoFailure(error: unknown): boolean {
  return error instanceof AppError && TERMINAL_FAILURE_CODES.has(error.code)
}

/** Explicit mode composition, with no Pi dependency or synthetic capability fallback. */
export class VideoRunService implements VideoRunPort {
  private readonly runs = new Map<string, Run>()
  private readonly stops = new Map<string, number>()
  private readonly preparations = new Map<string, Set<AbortController>>()
  constructor(private readonly options: MockVideoHostOptions, private readonly ipcHost?: MockVideoHostService) {
    if (typeof options.mock !== 'boolean') throw new AppError('INVALID_ARGUMENT')
  }
  private key(taskId: string, runId: string): string { return JSON.stringify([taskId, runId]) }

  async prepareRun(input: RunInput): Promise<VideoHostTools | undefined> {
    videoLocalIdSchema.parse(input.taskId); videoLocalIdSchema.parse(input.runId)
    const stop = this.stops.get(input.taskId) ?? 0
    const runtime = videoRuntimeSchema.safeParse(input.employee.video)
    if (input.employee.subscriptionId !== input.subscriptionId || !runtime.success || (runtime.data.executionMode ?? 'mock') !== (this.options.mock ? 'mock' : 'real') || !runtime.data.executionAvailable) return undefined
    const allowed = names.filter(name => runtime.data.tools.includes(name) && (!input.toolPolicy || input.toolPolicy.preset === 'full-local' ||
      (input.toolPolicy.preset !== 'read-only' && input.toolPolicy.allowedTools.includes(name))))
    if (!allowed.length) return undefined
    const revision = this.options.authorizationRevision()
    const controller = new AbortController()
    const preparing = this.preparations.get(input.taskId) ?? new Set<AbortController>()
    this.preparations.set(input.taskId, preparing)
    preparing.add(controller)
    let task: Awaited<ReturnType<MockVideoHostOptions['getTask']>>
    try { task = await abortableVideo(this.options.getTask(input.taskId), AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.operationTimeoutMs ?? 60_000)])) } finally {
      preparing.delete(controller)
      if (!preparing.size && this.preparations.get(input.taskId) === preparing) this.preparations.delete(input.taskId)
    }
    if (!task || stop !== (this.stops.get(input.taskId) ?? 0)) throw new AppError('AUTH_REQUIRED')
    const taskSubscriptionId = task.subscriptionId
    const key = this.key(input.taskId, input.runId)
    if (this.runs.has(key)) throw new AppError('CONFLICT')
    const validate = () => {
      controller.signal.throwIfAborted()
      if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
    }
    const jobs = new Set<string>()
    const host = new MockVideoHostService({ ...this.options, trackingJobIds: jobs,
      localRuntime: subscriptionId => this.options.localRuntime ? this.options.localRuntime(subscriptionId) : runtime.data,
      authorize: async (subscriptionId, signal) => {
        validate()
        const runtime = await abortableVideo(this.options.authorize(subscriptionId, signal), signal)
        validate()
        return runtime
      },
      getTask: async id => {
        validate()
        const current = await this.options.getTask(id)
        validate()
        if (id !== input.taskId || !current || current.subscriptionId !== taskSubscriptionId) throw new AppError('AUTH_REQUIRED')
        return { subscriptionId: input.subscriptionId }
      },
      policy: async id => {
        validate()
        const current = await this.options.policy?.(id)
        validate()
        return current ?? input.toolPolicy
      },
      requestApproval: request => { validate(); return input.requestApproval({ ...request, runId: input.runId }) },
    })
    validate()
    const run: Run = { taskId: input.taskId, host, controller, pending: new Set(), jobs, finished: false, terminalFailureNotified: false, onTerminalFailure: input.onTerminalFailure }
    this.runs.set(key, run)
    try {
      const restored = await abortableVideo(host.getTaskVideo(input.taskId), controller.signal)
      validate()
      for (const job of restored.jobs) {
        if (input.recoverJobIds && !input.recoverJobIds.includes(job.jobId)) continue
        if (!input.recoverJobIds && [...this.runs.values()].some(other => other !== run && other.jobs.has(job.jobId))) continue
        if (videoBillingPending(job.billingStatus) || job.generationStatus !== 'NOT_SUBMITTED' && (!['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(job.generationStatus)) && job.saveStatus !== 'SAVED') run.jobs.add(job.jobId)
      }
      if (run.jobs.size) {
        run.tracking = host.track(input.taskId)
        void run.tracking.catch(() => undefined)
      }
    } catch (error) {
      await host.stopAll()
      if (this.runs.get(key) === run) this.runs.delete(key)
      throw error
    }
    const activity = <T>(call: () => Promise<T>): Promise<T> => {
      const pending = Promise.resolve().then(() => { validate(); if (run.finished) throw new AppError('CONFLICT'); return call() }).catch(async error => {
        await this.notifyTerminalFailure(run, error)
        throw error
      })
      run.pending.add(pending)
      return pending.finally(() => run.pending.delete(pending))
    }
    return { names: allowed, execute: (name, raw, parent) => activity(async () => {
      if (!allowed.includes(name)) throw new AppError('PERMISSION_DENIED')
      const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])])
      signal.throwIfAborted()
      if (name === 'video_get_job') {
        const args = videoToolJobInputSchema.parse(raw)
        const view = await abortableVideo(host.getTaskVideo(input.taskId), signal)
        validate()
        if (!args.jobId) {
          const referenceAssets = await abortableVideo(host.getReferences(input.taskId), signal)
          validate()
          return { ...view, referenceAssets }
        }
        const job = view.jobs.find(job => job.jobId === args.jobId)
        if (!job) throw new AppError('NOT_FOUND')
        return job
      }
      const job = await host.generateTool(input.taskId, name, raw, signal, { runId: input.runId, onJobCreated: input.onJobCreated,
        requestApproval: request => {
          validate()
          return input.autoApproveMedia ? Promise.resolve(true) : input.requestApproval(request)
        } })
      run.jobs.add(job.jobId)
      validate()
      if (job.trackingStatus === 'AUTH_REQUIRED') throw new AppError(videoErrorMessage(job.error) && isErrorCode(job.error)
        ? job.error : job.error === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'AUTH_REQUIRED')
      run.tracking = host.track(input.taskId)
      void run.tracking.catch(() => undefined)
      return job
    }) }
  }

  async waitForRun(taskId: string, runId: string, options: { recoverOriginal?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const run = this.runs.get(this.key(taskId, runId))
    if (!run) return
    const signal = AbortSignal.any([run.controller.signal, ...(options.signal ? [options.signal] : [])])
    signal.throwIfAborted()
    while (run.pending.size) await abortableVideo(Promise.all([...run.pending]), signal)
    signal.throwIfAborted()
    if (!run.jobs.size) return
    let trackingError: unknown
    let trackingDone = false
    const recoveries = new Map<string, number>()
    if (!run.tracking) return
    void run.tracking.then(() => { trackingDone = true }, error => { trackingDone = true; trackingError = error })
    tracking: for (;;) {
      signal.throwIfAborted()
      const trackingWasDone = trackingDone
      const trackedBeforeRead = [...run.jobs].filter(id => run.host.hasActiveTracker(taskId, id))
      const view = await abortableVideo(run.host.getTaskVideo(taskId), signal)
      // The read may have captured pre-save state while the tracker completed.
      if (!trackingWasDone && trackingDone || trackedBeforeRead.some(id => !run.host.hasActiveTracker(taskId, id))) continue
      let complete = true
      for (const id of run.jobs) {
        const job = view.jobs.find(job => job.jobId === id)
        if (!job || !['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus) || job.saveStatus !== 'SAVED') {
          complete = false
          const failed = job && (['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(job.generationStatus) || ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus))
          // An observing host may finish its own loop while another host is saving.
          if (failed || trackingDone && !run.host.hasActiveTracker(taskId, id)) {
            const error = trackingError instanceof AppError ? trackingError : new AppError(job && videoErrorMessage(job.error) && isErrorCode(job.error) ? job.error : 'INVALID_STATE')
            await this.notifyTerminalFailure(run, error)
            if (options.recoverOriginal && job?.generationStatus === 'RESULT_EXPIRED' && !terminalVideoFailure(error)) throw new ArrangementMediaRecoveryError('download', error)
            if (options.recoverOriginal && !terminalVideoFailure(error) && job && ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)) {
              if ((recoveries.get(id) ?? 0) < 3) {
                recoveries.set(id, (recoveries.get(id) ?? 0) + 1)
                await delay(100 * 2 ** ((recoveries.get(id) ?? 1) - 1), undefined, { signal })
                try { await abortableVideo(run.host.retrySave(taskId, id), signal) }
                catch (failure) {
                  signal.throwIfAborted()
                  await this.notifyTerminalFailure(run, failure)
                  if (terminalVideoFailure(failure)) throw failure
                  if (recoveries.get(id) === 3) throw new ArrangementMediaRecoveryError('download', failure)
                }
                continue tracking
              }
              throw new ArrangementMediaRecoveryError('download', error)
            }
            throw error
          }
        }
      }
      if (complete) return
      await delay(100, undefined, { signal })
    }
  }

  private async notifyTerminalFailure(run: Run, error: unknown): Promise<void> {
    if (!terminalVideoFailure(error) || run.terminalFailureNotified) return
    run.terminalFailureNotified = true
    await run.onTerminalFailure?.(error)
  }

  async stopTask(taskId: string): Promise<void> {
    this.stops.set(taskId, (this.stops.get(taskId) ?? 0) + 1)
    for (const controller of this.preparations.get(taskId) ?? []) controller.abort(new Error('Video preparation stopped.'))
    const runs = [...this.runs.entries()].filter(([, run]) => run.taskId === taskId)
    for (const [, run] of runs) run.controller.abort(new Error('Video run stopped.'))
    await Promise.all([this.ipcHost?.stopTask(taskId), ...runs.map(async ([key, run]) => {
      await run.host.stopAll()
      await Promise.allSettled([...run.pending])
      if (this.runs.get(key) === run) this.runs.delete(key)
    })])
  }
  async stopAll(): Promise<void> {
    await Promise.all([...new Set([...this.runs.values()].map(run => run.taskId).concat([...this.preparations.keys()]))].map(id => this.stopTask(id)))
    await this.ipcHost?.stopAll()
  }
  async finishRun(taskId: string, runId: string): Promise<void> {
    const key = this.key(taskId, runId), run = this.runs.get(key)
    if (!run) return
    run.finished = true
    await Promise.allSettled([...run.pending])
    if (!run.tracking) {
      run.controller.abort(new Error('Video run finished.'))
      await run.host.stopAll()
      if (this.runs.get(key) === run) this.runs.delete(key)
      return
    }
    void run.tracking.finally(async () => {
      run.controller.abort(new Error('Video run finished.'))
      await run.host.stopAll()
      if (this.runs.get(key) === run) this.runs.delete(key)
    }).catch(() => undefined)
  }
}
