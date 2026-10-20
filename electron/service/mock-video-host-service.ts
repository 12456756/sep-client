import { randomUUID, createHash } from 'node:crypto'
import type { z } from 'zod'
import { videoGenerationInputSchema, type VideoGenerationInput, type VideoJobView, type VideoTaskView } from '../../src/shared/video-host'
import { videoRuntimeSchema, videoReferenceSchema, type VideoGatewayPort, type VideoRuntime } from '../../src/shared/video-media'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { MediaAssetView } from '../../src/shared/media'
import { videoLocalIdSchema, videoScopeSchema, type LocalVideoJob, type VideoScope, type VideoStorePort } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { logger } from '../common/logger'
import { abortableVideo } from '../data/video-files'
import { requireScope, type ScopeSource } from './scope-guard'
import type { TaskToolPolicy } from '../runtime/run-types'
import { VideoService } from './video-service'
import { VideoTracker, type VideoTrackerOptions } from './video-tracker'

type Approval = (input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => Promise<boolean>
const log = logger.child('mock-video-host')
// Run and IPC hosts share the same task persistence. An instance-local gate
// cannot protect a task while approval, upload or submit is still in flight.
const submissions = new Set<string>()
export interface MockVideoHostGateway extends VideoGatewayPort {
  uploadReference(bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof videoReferenceSchema>>
}
export interface MockVideoHostOptions {
  /** Explicit test composition only. No production adapter or runtime fallback. */
  mock: true
  scope: ScopeSource
  store: VideoStorePort
  getTask(taskId: string): Promise<{ subscriptionId?: string | null } | null>
  authorize(subscriptionId: string, signal: AbortSignal): Promise<unknown>
  gateway(scope: VideoScope): MockVideoHostGateway
  readReference(scope: VideoScope, taskId: string, localAssetId: string): Promise<{ bytes: Uint8Array; sha256: string }>
  references?: {
    list(scope: VideoScope, taskId: string): Promise<MediaAssetView[]>
    import(scope: VideoScope, taskId: string, paths: readonly string[], signal: AbortSignal, validate: () => void): Promise<MediaAssetView[]>
  }
  exportOutput?(scope: VideoScope, taskId: string, jobId: string, outputId: string, path: string, signal: AbortSignal, validate: () => void): Promise<void>
  requestApproval: Approval
  policy?(taskId: string): Promise<TaskToolPolicy | undefined>
  /** Synchronous host generation, incremented on task binding, policy or grant changes. */
  authorizationRevision(): number
  now?: () => number
  operationTimeoutMs?: number
  tracker?: Omit<VideoTrackerOptions, 'service'>
}
interface Context {
  taskId: string
  scope: VideoScope
  service: VideoService
  tracker: VideoTracker
  uploadReference(taskId: string, toolName: string, bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof videoReferenceSchema>>
}

function jobView(job: LocalVideoJob): VideoJobView {
  return {
    jobId: job.jobId, taskId: job.taskId, profileId: job.request.profileId, operation: job.request.operation,
    parameters: { ...job.request.parameters }, generationStatus: job.receipt?.status ?? (job.submission === 'NOT_SENT' ? 'NOT_SUBMITTED' : 'SUBMISSION_UNKNOWN'),
    trackingStatus: job.trackingStatus, saveStatus: job.saveStatus, billingStatus: 'MOCK_NOT_CHARGED',
    createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error,
    outputs: structuredClone(job.receipt?.outputs ?? []),
  }
}

/** Host-only mock use cases. Side effects require approval after a durable quote. */
export class MockVideoHostService {
  private epoch = 0
  private session = new AbortController()
  private readonly contexts = new Map<string, Context>()
  private readonly active = new Set<Promise<unknown>>()
  private readonly taskSessions = new Map<string, AbortController>()
  private readonly taskOperations = new Map<string, Set<Promise<unknown>>>()
  private readonly now: () => number

  constructor(private readonly options: MockVideoHostOptions) {
    if (options.mock !== true) throw new AppError('INVALID_ARGUMENT')
    this.now = options.now ?? Date.now
  }
  private assert(scope: VideoScope, epoch: number, signal: AbortSignal): void {
    signal.throwIfAborted()
    const current = requireScope(this.options.scope)
    if (epoch !== this.epoch || current.enterpriseId !== scope.enterpriseId || current.memberId !== scope.memberId) throw new AppError('AUTH_REQUIRED')
  }
  private async task(taskId: string, signal: AbortSignal): Promise<{ scope: VideoScope; epoch: number }> {
    videoLocalIdSchema.parse(taskId)
    const owner = requireScope(this.options.scope), epoch = this.epoch
    signal.throwIfAborted()
    const task = await abortableVideo(this.options.getTask(taskId), signal)
    if (!task?.subscriptionId) throw new AppError('NOT_FOUND')
    const scope = videoScopeSchema.parse({ ...owner, subscriptionId: task.subscriptionId })
    this.assert(scope, epoch, signal)
    return { scope, epoch }
  }
  private async runtime(scope: VideoScope, epoch: number, signal: AbortSignal): Promise<VideoRuntime> {
    this.assert(scope, epoch, signal)
    const result = videoRuntimeSchema.safeParse(await abortableVideo(this.options.authorize(scope.subscriptionId, signal), signal))
    this.assert(scope, epoch, signal)
    if (!result.success || !result.data.executionAvailable || !result.data.tools.some(tool => tool !== 'video_cancel_job')) throw new AppError('PERMISSION_DENIED')
    return result.data
  }
  private signal(taskId: string, parent?: AbortSignal): AbortSignal {
    videoLocalIdSchema.parse(taskId)
    let task = this.taskSessions.get(taskId)
    if (!task) { task = new AbortController(); this.taskSessions.set(taskId, task) }
    return AbortSignal.any([this.session.signal, task.signal, ...(parent ? [parent] : []), AbortSignal.timeout(this.options.operationTimeoutMs ?? 60_000)])
  }
  private async sideEffect(scope: VideoScope, epoch: number, taskId: string, toolName: string, signal: AbortSignal, revision: number): Promise<() => void> {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new AppError('AUTH_REQUIRED')
    const current = await this.task(taskId, signal)
    if (JSON.stringify(current.scope) !== JSON.stringify(scope)) throw new AppError('AUTH_REQUIRED')
    const policy = this.options.policy ? await abortableVideo(this.options.policy(taskId), signal) : undefined
    if (policy && (policy.preset === 'read-only' || policy.preset !== 'full-local' && !policy.allowedTools.includes(toolName))) throw new AppError('PERMISSION_DENIED')
    // Invoke synchronously in the dispatch continuation, not before resolving
    // this promise: even its final await can otherwise invalidate the lease.
    return () => {
      this.assert(scope, epoch, signal)
      if (this.options.authorizationRevision() !== revision) throw new AppError('AUTH_REQUIRED')
    }
  }
  private context(scope: VideoScope, epoch: number, taskId: string): Context {
    const key = JSON.stringify([scope, taskId])
    const existing = this.contexts.get(key)
    if (existing) return existing
    const source = this.options.gateway(structuredClone(scope))
    this.signal(taskId)
    const session = AbortSignal.any([this.session.signal, this.taskSessions.get(taskId)!.signal])
    const authorized = async <T>(parent: AbortSignal, call: (signal: AbortSignal, revision: number) => Promise<T>): Promise<T> => {
      const signal = AbortSignal.any([parent, session, AbortSignal.timeout(this.options.operationTimeoutMs ?? 60_000)])
      const revision = this.options.authorizationRevision()
      await this.runtime(scope, epoch, signal)
      if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
      const result = await abortableVideo(call(signal, revision), signal)
      this.assert(scope, epoch, signal)
      if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
      return result
    }
    const gateway: VideoGatewayPort = {
      quote: (input, signal) => authorized(signal, bounded => source.quote(input, bounded)),
      submit: (input, signal) => authorized(signal, async (bounded, revision) => {
        const runtime = await this.runtime(scope, epoch, bounded)
        this.profile(runtime, { ...input, localAssetIds: input.referenceIds }, input.configVersion)
        const job = (await this.options.store.listJobs(scope)).find(job => job.request.clientRequestId === input.clientRequestId)
        if (!job) throw new AppError('NOT_FOUND')
        const dispatch = await this.sideEffect(scope, epoch, job.taskId, input.operation === 'image-to-video' ? 'video_from_image' : 'video_generate', bounded, revision)
        dispatch()
        return source.submit(input, bounded)
      }),
      findReceipt: (id, signal) => authorized(signal, bounded => source.findReceipt(id, bounded)),
      getReceipt: (id, signal) => authorized(signal, bounded => source.getReceipt(id, bounded)),
      content: (receiptId, outputId, signal) => authorized(signal, async (bounded, revision) => {
        const stream = await source.content(receiptId, outputId, bounded)
        const assert = () => {
          this.assert(scope, epoch, bounded)
          if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
        }
        return (async function* () {
          const iterator = stream[Symbol.asyncIterator]()
          let complete = false
          try {
            for (;;) {
              assert()
              const next = await abortableVideo(iterator.next(), bounded)
              assert()
              if (next.done) { complete = true; return }
              yield next.value
            }
          } finally {
            if (!complete && iterator.return) void iterator.return().catch(() => undefined)
          }
        })()
      }),
    }
    const service = new VideoService({ scope, store: this.options.store, gateway, now: this.now })
    const context: Context = {
      taskId, scope, service, tracker: new VideoTracker({ ...this.options.tracker, service: {
        resume: (id, jobId, signal) => service.resume(id, jobId, signal),
        recover: async signal => {
          const jobs = (await service.listJobs()).filter(job => job.taskId === taskId)
          if (jobs.some(job => job.trackingStatus === 'AUTH_REQUIRED')) return jobs
          const restored: LocalVideoJob[] = []
          for (const job of jobs) {
            signal?.throwIfAborted()
            const current = await service.resume(taskId, job.jobId, signal)
            restored.push(current)
            if (current.trackingStatus === 'AUTH_REQUIRED') break
          }
          return restored
        },
      } }),
      uploadReference: (taskId, toolName, bytes, signal) => authorized(signal, async (bounded, revision) => {
        const dispatch = await this.sideEffect(scope, epoch, taskId, toolName, bounded, revision)
        dispatch()
        return source.uploadReference(bytes, bounded)
      }),
    }
    this.contexts.set(key, context)
    return context
  }
  private profile(runtime: VideoRuntime, input: VideoGenerationInput, configVersion?: string) {
    const profile = runtime.profiles.find(candidate => candidate.profileId === input.profileId)
    const tool = input.operation === 'image-to-video' ? 'video_from_image' : 'video_generate'
    const parameters = input.parameters
    if (!runtime.executionAvailable || !runtime.tools.includes(tool) || !profile ||
      configVersion !== undefined && configVersion !== profile.configVersion || !profile.operations.includes(input.operation) ||
      !profile.capabilities.durationsSeconds.includes(parameters.durationSeconds) ||
      !profile.capabilities.aspectRatios.includes(parameters.aspectRatio) || !profile.capabilities.resolutions.includes(parameters.resolution) ||
      !profile.capabilities.frameRates.includes(parameters.frameRate) || !profile.capabilities.outputFormats.includes(parameters.outputFormat) ||
      parameters.audio && !profile.capabilities.supportsAudio || input.localAssetIds.length > profile.capabilities.maxReferenceCount) {
      throw new AppError('PERMISSION_DENIED')
    }
    return profile
  }
  private async binding(taskId: string, signal: AbortSignal) {
    const { scope, epoch } = await this.task(taskId, signal)
    const runtime = await this.runtime(scope, epoch, signal)
    return { scope, epoch, runtime, context: this.context(scope, epoch, taskId) }
  }
  private operation<T>(taskId: string, call: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(call)
    this.active.add(pending)
    const operations = this.taskOperations.get(taskId) ?? new Set<Promise<unknown>>()
    this.taskOperations.set(taskId, operations)
    operations.add(pending)
    return pending.finally(() => { this.active.delete(pending); operations.delete(pending); if (!operations.size && this.taskOperations.get(taskId) === operations) this.taskOperations.delete(taskId) })
  }
  async getTaskVideo(taskId: string): Promise<VideoTaskView> {
    const signal = this.signal(taskId)
    const revision = this.options.authorizationRevision()
    const { scope, epoch, runtime, context } = await this.binding(taskId, signal)
    const jobs = (await context.service.listJobs()).filter(job => job.taskId === taskId)
    const views: VideoJobView[] = []
    for (const job of jobs) {
      const savedOutputIds: string[] = []
      for (const output of job.receipt?.outputs ?? []) {
        // A corrupt output must remain visible for explicit repair. Never count
        // it as saved or let it hide the other verified outputs in the task.
        try {
          const asset = await this.options.store.getAsset(scope, taskId, job.jobId, output.outputId)
          if (asset?.status === 'SAVED') savedOutputIds.push(output.outputId)
        } catch { /* persistence evidence stays intact for explicit retry */ }
      }
      views.push({ ...jobView(job), savedOutputIds })
    }
    this.assert(scope, epoch, signal)
    if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
    return { mock: true, runtime, jobs: views }
  }
  async getReferences(taskId: string): Promise<MediaAssetView[]> {
    const signal = this.signal(taskId)
    const revision = this.options.authorizationRevision()
    const { scope, epoch } = await this.binding(taskId, signal)
    const assets = await this.options.references?.list(scope, taskId) ?? []
    this.assert(scope, epoch, signal)
    if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
    return assets.filter(asset => asset.source === 'reference' && asset.taskId === taskId).map(asset => ({
      localAssetId: asset.localAssetId, taskId: asset.taskId, jobId: null, outputId: null,
      source: 'reference', mime: asset.mime, size: asset.size, width: asset.width, height: asset.height, status: asset.status,
    }))
  }
  /** Native dialogs retain an authorization lease, never renderer-provided paths. */
  async nativeSelection(taskId: string) {
    const signal = this.signal(taskId)
    const revision = this.options.authorizationRevision()
    const { scope, epoch } = await this.binding(taskId, signal)
    const validate = () => {
      this.assert(scope, epoch, signal)
      if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
    }
    validate()
    return {
      import: async (paths: readonly string[]) => this.operation(taskId, async () => {
        validate()
        await this.runtime(scope, epoch, signal)
        validate()
        if (!this.options.references || paths.length > 4) throw new AppError('INVALID_ARGUMENT')
        const result = await this.options.references.import(scope, taskId, paths, signal, validate)
        validate()
        return result
      }),
      export: async (jobId: string, outputId: string, path: string) => this.operation(taskId, async () => {
        videoLocalIdSchema.parse(jobId); videoLocalIdSchema.parse(outputId)
        validate()
        await this.runtime(scope, epoch, signal)
        validate()
        if (!this.options.exportOutput) throw new AppError('SERVICE_UNAVAILABLE')
        await this.options.exportOutput(scope, taskId, jobId, outputId, path, signal, validate)
        validate()
      }),
    }
  }
  async preview(taskId: string, jobId: string, outputId: string) {
    videoLocalIdSchema.parse(jobId); videoLocalIdSchema.parse(outputId)
    const signal = this.signal(taskId)
    const revision = this.options.authorizationRevision()
    const { scope, epoch } = await this.binding(taskId, signal)
    const asset = await this.options.store.getAsset(scope, taskId, jobId, outputId)
    // This preview bridge is mock-only; do not transfer a production-sized video over IPC.
    if (!asset || asset.status !== 'SAVED') throw new AppError('NOT_FOUND')
    if (asset.output.byteLength > 16 * 1024 * 1024) throw new AppError('INVALID_ARGUMENT')
    const bytes = await this.options.store.readAsset(scope, taskId, jobId, outputId)
    this.assert(scope, epoch, signal)
    if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
    return { mime: asset.output.mimeType, bytes }
  }
  async generate(taskId: string, value: VideoGenerationInput, parent?: AbortSignal, run?: { runId: string; requestApproval: Approval }): Promise<VideoJobView> {
    const signal = this.signal(taskId, parent)
    const revision = this.options.authorizationRevision()
    const input = videoGenerationInputSchema.parse(value)
    return this.operation(taskId, async () => {
      const owner = requireScope(this.options.scope)
      const key = JSON.stringify([owner.enterpriseId, owner.memberId, taskId])
      if (submissions.has(key)) throw new AppError('CONFLICT')
      submissions.add(key)
      try {
        const { scope, epoch, runtime, context } = await this.binding(taskId, signal)
        const jobs = await context.service.listJobs()
        this.assert(scope, epoch, signal)
        if (jobs.some(job => job.taskId === taskId && (job.submission === 'MAYBE_SENT' || job.receipt?.status === 'SUBMISSION_UNKNOWN'))) {
          throw new AppError('CONFLICT', { message: '原视频提交状态尚未确认，请查询或恢复原任务，不能重复生成。' })
        }
        const profile = this.profile(runtime, input)
        const policy = this.options.policy ? await abortableVideo(this.options.policy(taskId), signal) : undefined
        const toolName = input.operation === 'image-to-video' ? 'video_from_image' : 'video_generate'
        if (policy && (policy.preset === 'read-only' || policy.preset !== 'full-local' && !policy.allowedTools.includes(toolName))) throw new AppError('PERMISSION_DENIED')
        const runId = run?.runId ?? randomUUID()
        const approve = async (details: Record<string, unknown>) => {
          this.assert(scope, epoch, signal)
          if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
          const allowed = await abortableVideo((run?.requestApproval ?? this.options.requestApproval)({ taskId, runId, subscriptionId: scope.subscriptionId, toolName, input: details }), signal)
          this.assert(scope, epoch, signal)
          if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
          if (!allowed) throw new AppError('PERMISSION_DENIED')
        }
        const referenceIds: string[] = []
        if (input.localAssetIds.length) {
          await approve({ operation: 'upload-references', referenceCount: input.localAssetIds.length, mock: true })
          for (const id of input.localAssetIds) {
            const reference = await abortableVideo(this.options.readReference(scope, taskId, id), signal)
            this.assert(scope, epoch, signal)
            if (reference.bytes.byteLength > profile.capabilities.maxInputBytes || createHash('sha256').update(reference.bytes).digest('hex') !== reference.sha256) throw new AppError('INVALID_ARGUMENT')
            const uploaded = videoReferenceSchema.parse(await context.uploadReference(taskId, toolName, reference.bytes, signal))
            if (uploaded.sha256.toLowerCase() !== reference.sha256 || uploaded.byteLength !== reference.bytes.byteLength || Date.parse(uploaded.expiresAt) <= this.now()) throw new AppError('INVALID_STATE')
            referenceIds.push(uploaded.referenceId)
          }
        }
        const { localAssetIds: _localAssetIds, ...semantic } = input
        const job = await context.service.prepare(taskId, { ...semantic, configVersion: profile.configVersion, referenceIds }, signal)
        if (job.quote.amount !== '0.000000' || job.quote.currency !== 'MOCK') throw new AppError('PERMISSION_DENIED')
        await approve({ profile: profile.displayName, parameters: input.parameters, creativeBrief: input.creativeBrief,
          mock: true, quote: { amount: job.quote.amount, currency: job.quote.currency, expiresAt: job.quote.expiresAt } })
        // Approval is for the captured task/subscription and frozen configuration only.
        const current = await this.task(taskId, signal)
        if (JSON.stringify(current.scope) !== JSON.stringify(scope)) throw new AppError('AUTH_REQUIRED')
        this.profile(await this.runtime(scope, epoch, signal), input, profile.configVersion)
        if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
        const submitted = await context.service.submit(taskId, job.jobId, signal)
        this.assert(scope, epoch, signal)
        return jobView(submitted)
      } finally { submissions.delete(key) }
    })
  }
  async resume(taskId: string, jobId: string, parent?: AbortSignal): Promise<VideoJobView> {
    const signal = this.signal(taskId, parent)
    return this.operation(taskId, async () => {
      const { scope, epoch, context } = await this.binding(taskId, signal)
      const job = await context.service.resume(taskId, jobId, signal)
      this.assert(scope, epoch, signal)
      return jobView(job)
    })
  }
  async retrySave(taskId: string, jobId: string): Promise<VideoJobView> {
    const signal = this.signal(taskId)
    return this.operation(taskId, async () => {
      const { scope, epoch, context } = await this.binding(taskId, signal)
      const job = await context.service.retrySave(taskId, jobId, signal)
      this.assert(scope, epoch, signal)
      return jobView(job)
    })
  }
  /** Only explicit host/run lifecycle calls wake recovery; reads never do. */
  async track(taskId: string): Promise<void> {
    const signal = this.signal(taskId)
    return this.operation(taskId, async () => {
      const { scope, epoch } = await this.task(taskId, signal)
      // Let service.recover persist a grant failure as AUTH_REQUIRED. Checking
      // runtime before entering recover would leave disk jobs ACTIVE on denial.
      await this.context(scope, epoch, taskId).tracker.wake()
    })
  }
  /** Login/startup recovery is explicit. Persisted grant failures need user resume. */
  async resumePending(taskIds: readonly string[]): Promise<void> {
    const epoch = this.epoch
    for (const taskId of taskIds) {
      if (epoch !== this.epoch) return
      try {
        const view = await this.getTaskVideo(taskId)
        if (epoch !== this.epoch) return
        if (view.jobs.some(job => job.trackingStatus === 'AUTH_REQUIRED')) continue
        if (!view.jobs.some(job => job.generationStatus !== 'NOT_SUBMITTED' &&
          (job.trackingStatus === 'ACTIVE' || job.trackingStatus === 'INTERRUPTED' ||
            ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus) && job.saveStatus !== 'SAVED'))) continue
        void this.track(taskId).catch(error => {
          log.warn('mock video recovery interrupted', { taskId, errorType: error instanceof Error ? error.name : 'unknown' })
        })
      } catch (error) {
        if (epoch !== this.epoch) return
        log.warn('mock video recovery unavailable', { taskId, errorType: error instanceof Error ? error.name : 'unknown' })
      }
    }
  }
  /** Stops only local work for this task, retaining its original durable receipt. */
  async stopTask(taskId: string): Promise<void> {
    videoLocalIdSchema.parse(taskId)
    const session = this.taskSessions.get(taskId)
    session?.abort(new Error('Mock video task stopped.'))
    const contexts = [...this.contexts.entries()].filter(([, context]) => context.taskId === taskId)
    for (const [key, context] of contexts) { context.service.close(); this.contexts.delete(key) }
    await Promise.allSettled(contexts.map(([, context]) => context.tracker.stop()))
    await Promise.allSettled([...(this.taskOperations.get(taskId) ?? [])])
    if (this.taskSessions.get(taskId) === session) this.taskSessions.delete(taskId)
  }
  async stopAll(): Promise<void> {
    this.epoch++
    this.session.abort(new Error('Mock video host stopped.'))
    const contexts = [...this.contexts.values()]
    for (const context of contexts) context.service.close()
    this.contexts.clear()
    await Promise.allSettled(contexts.map(context => context.tracker.stop()))
    await Promise.allSettled([...this.active])
    this.taskSessions.clear()
    this.session = new AbortController()
  }
}
