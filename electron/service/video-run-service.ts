import { z } from 'zod'
import { videoGenerationInputSchema } from '../../src/shared/video-host'
import { videoRuntimeSchema } from '../../src/shared/video-media'
import { videoLocalIdSchema } from '../domain/video-media'
import type { VideoHostTools, VideoRunPort, VideoToolName } from '../domain/video-tools'
import { AppError } from '../errors/app-error'
import { abortableVideo } from '../data/video-files'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'

type RunInput = Parameters<VideoRunPort['prepareRun']>[0]
interface Run {
  taskId: string
  host: MockVideoHostService
  controller: AbortController
  pending: Set<Promise<unknown>>
  jobs: Set<string>
  tracking?: Promise<void>
}
const names: readonly VideoToolName[] = ['video_from_image', 'video_generate', 'video_get_job']

/** Explicit mock composition, with no Pi dependency or synthetic capability fallback. */
export class VideoRunService implements VideoRunPort {
  private readonly runs = new Map<string, Run>()
  private readonly stops = new Map<string, number>()
  private readonly preparations = new Map<string, Set<AbortController>>()
  constructor(private readonly options: MockVideoHostOptions, private readonly ipcHost?: MockVideoHostService) {
    if (options.mock !== true) throw new AppError('INVALID_ARGUMENT')
  }
  private key(taskId: string, runId: string): string { return JSON.stringify([taskId, runId]) }

  async prepareRun(input: RunInput): Promise<VideoHostTools | undefined> {
    videoLocalIdSchema.parse(input.taskId); videoLocalIdSchema.parse(input.runId)
    const stop = this.stops.get(input.taskId) ?? 0
    const runtime = videoRuntimeSchema.safeParse(input.employee.video)
    if (input.employee.subscriptionId !== input.subscriptionId || !runtime.success || !runtime.data.executionAvailable) return undefined
    let allowed = names.filter(name => runtime.data.tools.includes(name) && (!input.toolPolicy || input.toolPolicy.preset === 'full-local' ||
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
    const host = new MockVideoHostService({ ...this.options,
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
    const run: Run = { taskId: input.taskId, host, controller, pending: new Set(), jobs: new Set() }
    this.runs.set(key, run)
    try {
      const restored = await abortableVideo(host.getTaskVideo(input.taskId), controller.signal)
      validate()
      allowed = allowed.filter(name => restored.runtime.tools.includes(name))
      if (!allowed.length) { await this.finishRun(input.taskId, input.runId); return undefined }
      for (const job of restored.jobs) {
        if (job.generationStatus !== 'NOT_SUBMITTED' && (!['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(job.generationStatus)) && job.saveStatus !== 'SAVED') run.jobs.add(job.jobId)
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
      const pending = Promise.resolve().then(() => { validate(); return call() })
      run.pending.add(pending)
      return pending.finally(() => run.pending.delete(pending))
    }
    return { names: allowed, execute: (name, raw, parent) => activity(async () => {
      if (!allowed.includes(name)) throw new AppError('PERMISSION_DENIED')
      const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])])
      signal.throwIfAborted()
      const current = videoRuntimeSchema.safeParse(await abortableVideo(this.options.authorize(input.subscriptionId, signal), signal))
      validate()
      if (!current.success || !current.data.executionAvailable || !current.data.tools.includes(name)) throw new AppError('PERMISSION_DENIED')
      if (name === 'video_get_job') {
        const args = z.object({ jobId: videoLocalIdSchema }).strict().parse(raw)
        const view = await abortableVideo(host.getTaskVideo(input.taskId), signal)
        validate()
        const job = view.jobs.find(job => job.jobId === args.jobId)
        if (!job) throw new AppError('NOT_FOUND')
        return job
      }
      const value = videoGenerationInputSchema.parse(raw)
      if ((name === 'video_from_image') !== (value.operation === 'image-to-video')) throw new AppError('INVALID_ARGUMENT')
      const job = await host.generate(input.taskId, value, signal, { runId: input.runId, requestApproval: request => { validate(); return input.requestApproval(request) } })
      run.jobs.add(job.jobId)
      validate()
      if (job.trackingStatus === 'AUTH_REQUIRED') throw new AppError(job.error === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'AUTH_REQUIRED')
      run.tracking = host.track(input.taskId)
      void run.tracking.catch(() => undefined)
      return job
    }) }
  }

  async waitForRun(taskId: string, runId: string): Promise<void> {
    const run = this.runs.get(this.key(taskId, runId))
    if (!run) return
    while (run.pending.size) await Promise.all([...run.pending])
    run.controller.signal.throwIfAborted()
    if (!run.jobs.size) return
    await run.tracking
    // The tracker only queries the frozen request; never quote or submit again.
    await run.host.track(taskId)
    run.controller.signal.throwIfAborted()
    const view = await run.host.getTaskVideo(taskId)
    for (const id of run.jobs) {
      const job = view.jobs.find(job => job.jobId === id)
      if (!job || !['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus) || job.saveStatus !== 'SAVED') throw new AppError('INVALID_STATE')
    }
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
    run.controller.abort(new Error('Video run finished.'))
    await run.host.stopAll()
    await Promise.allSettled([...run.pending])
    if (this.runs.get(key) === run) this.runs.delete(key)
  }
}
