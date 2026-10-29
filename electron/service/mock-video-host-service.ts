import { randomUUID, createHash } from 'node:crypto'
import type { z } from 'zod'
import { videoGenerationInputSchema, videoToolGenerationInputSchema, type VideoGenerationInput, type VideoJobView, type VideoTaskView } from '../../src/shared/video-host'
import { videoAllowedAudioModes, videoBillingPending, videoRuntimeSchema, videoReferenceSchema, videoParametersSchema, type VideoGatewayPort, type VideoRuntime } from '../../src/shared/video-media'
import { mediaSpecMetadataSchema, mediaSpecsEqual, videoRequestedSpecSchema } from '../../src/shared/media-spec-contract'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { MediaAssetView } from '../../src/shared/media'
import { videoSubmissionRejected, videoSpecAcceptance, videoLocalIdSchema, videoScopeSchema, type LocalVideoJob, type VideoScope, type VideoStorePort } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { logger } from '../common/logger'
import { abortableVideo } from '../data/video-files'
import { requireScope, type ScopeSource } from './scope-guard'
import type { TaskToolPolicy } from '../runtime/run-types'
import type { MediaJobCreated } from '../domain/media-tools'
import type { ArrangementMediaLinkStorePort } from '../domain/arrangement-media'
import { VideoService } from './video-service'
import { VideoTracker, type VideoTrackerOptions } from './video-tracker'

type Approval = (input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => Promise<boolean>
type GenerationRun = { runId: string; requestApproval: Approval; onJobCreated?: (job: MediaJobCreated) => Promise<void> }
const log = logger.child('mock-video-host')
// Run and IPC hosts share the same task persistence. An instance-local gate
// cannot protect a task while approval, upload or submit is still in flight.
const submissions = new Set<string>()
const trackingOwners = new Map<string, symbol>()
export interface MockVideoHostGateway extends VideoGatewayPort {
  uploadReference(bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof videoReferenceSchema>>
}
interface VideoHostOptionsBase {
  scope: ScopeSource
  store: VideoStorePort
  /** Persisted node associations are the authority for cross-employee saved outputs. */
  arrangementMediaLinks?: ArrangementMediaLinkStorePort
  getTask(taskId: string): Promise<{ subscriptionId?: string | null } | null>
  authorize(subscriptionId: string, signal: AbortSignal): Promise<unknown>
  /** Identity/subscription check for original receipts, independent of generation capabilities. */
  authorizeRecovery?(subscriptionId: string, signal: AbortSignal): Promise<void>
  /** Cached presentation only; local history must never trigger a network authorization. */
  localRuntime?(subscriptionId: string): unknown
  gateway(scope: VideoScope): MockVideoHostGateway
  readReference(scope: VideoScope, taskId: string, localAssetId: string): Promise<{ bytes: Uint8Array; sha256: string }>
  references?: {
    list(scope: VideoScope, taskId: string): Promise<MediaAssetView[]>
    import(scope: VideoScope, taskId: string, paths: readonly string[], signal: AbortSignal, validate: () => void): Promise<MediaAssetView[]>
  }
  exportOutput?(scope: VideoScope, taskId: string, jobId: string, outputId: string, path: string, signal: AbortSignal, validate: () => void): Promise<void>
  openOutput?(scope: VideoScope, taskId: string, jobId: string, outputId: string, signal: AbortSignal, validate: () => void): Promise<void>
  requestApproval: Approval
  policy?(taskId: string): Promise<TaskToolPolicy | undefined>
  /** Synchronous host generation, incremented on task binding, policy or grant changes. */
  authorizationRevision(): number
  /** Local ownership only: employee grant changes must not revoke saved files. */
  localAuthorizationRevision?(): number
  /** Identity and employee grants, never generation model catalogs. */
  recoveryAuthorizationRevision?(): number
  now?: () => number
  operationTimeoutMs?: number
  tracker?: Omit<VideoTrackerOptions, 'service'>
  /** Run hosts track only their submitted or explicitly recovered jobs. */
  trackingJobIds?: ReadonlySet<string>
}
export type MockVideoHostOptions = VideoHostOptionsBase & ({ mock: true } | { mock: false })
interface Context {
  taskId: string
  scope: VideoScope
  service: VideoService
  tracker: VideoTracker
  trackingOwner: symbol
  trackedKeys: Set<string>
  tracking?: Promise<void>
  uploadReference(taskId: string, toolName: string, bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof videoReferenceSchema>>
}

function jobView(job: LocalVideoJob): VideoJobView {
  const rejected = videoSubmissionRejected(job)
  const measured = videoSpecAcceptance(job)
  return {
    jobId: job.jobId, taskId: job.taskId, profileId: job.request.profileId, operation: job.request.operation,
    parameters: { ...job.request.parameters }, generationStatus: job.receipt?.status ?? (job.submission === 'NOT_SENT' ? 'NOT_SUBMITTED' : rejected ? 'FAILED' : 'SUBMISSION_UNKNOWN'),
    ...(job.request.protocolVersion === 3 ? { protocolVersion: 3, requestedSpec: job.request.requestedSpec, specRevision: job.request.specRevision, parameterSources: job.request.parameterSources,
      effectiveSpec: job.quote.effectiveSpec, actualSpec: measured.actualSpec, acceptance: measured.acceptance } : {}),
    trackingStatus: job.trackingStatus, saveStatus: job.saveStatus, billingStatus: job.receipt?.billingStatus ?? ((job.executionMode ?? 'mock') === 'real'
      ? job.submission === 'NOT_SENT' || rejected ? 'NOT_RESERVED' : 'RECONCILING' : 'MOCK_NOT_CHARGED'),
    ...((job.executionMode ?? 'mock') === 'real' ? { amountCny: job.receipt && !job.receipt.mock ? job.receipt.amountCny ?? job.quote.amount! : job.quote.amount!,
      ...(job.receipt && !job.receipt.mock ? { actualCostCny: job.receipt.actualCostCny, amountUsd: job.receipt.amountUsd ?? job.quote.amountUsd } : { amountUsd: job.quote.amountUsd }) } : {}),
    ...(job.specFailure ? { specFailure: structuredClone(job.specFailure) } : {}),
    createdAt: job.createdAt, updatedAt: job.updatedAt, error: measured.acceptance === 'mismatched' ? 'OUTPUT_SPEC_MISMATCH' : job.error,
    ...(job.lastQueriedAt === undefined ? {} : { lastQueriedAt: job.lastQueriedAt }),
    ...(job.providerWaitMs === undefined ? {} : { providerWaitMs: job.providerWaitMs }),
    ...(job.downloadMs === undefined ? {} : { downloadMs: job.downloadMs }),
    outputs: structuredClone(job.receipt?.outputs ?? []),
  }
}

/** Shared host use cases. The explicit mode must match every fresh runtime authorization. */
export class MockVideoHostService {
  private epoch = 0
  private session = new AbortController()
  private readonly contexts = new Map<string, Context>()
  private readonly active = new Set<Promise<unknown>>()
  private readonly taskSessions = new Map<string, AbortController>()
  private readonly taskOperations = new Map<string, Set<Promise<unknown>>>()
  private readonly runtimes = new Map<string, VideoRuntime>()
  private readonly now: () => number

  constructor(private readonly options: MockVideoHostOptions) {
    if (typeof options.mock !== 'boolean') throw new AppError('INVALID_ARGUMENT')
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
  private localRevision(): number {
    return this.options.localAuthorizationRevision?.() ?? this.options.authorizationRevision()
  }
  private recoveryRevision(): number {
    return this.options.recoveryAuthorizationRevision?.() ?? this.localRevision()
  }
  private localRuntime(scope: VideoScope): VideoRuntime {
    const value = this.options.localRuntime ? this.options.localRuntime(scope.subscriptionId) : this.runtimes.get(JSON.stringify(scope))
    const result = videoRuntimeSchema.safeParse(value)
    if (result.success && (result.data.executionMode ?? 'mock') === (this.options.mock ? 'mock' : 'real')) return result.data
    return { protocolVersion: 1, executionMode: this.options.mock ? 'mock' : 'real', executionAvailable: false,
      defaultProfileId: null, tools: [], profiles: [] }
  }
  private async runtime(scope: VideoScope, epoch: number, signal: AbortSignal, execution = true): Promise<VideoRuntime> {
    this.assert(scope, epoch, signal)
    const result = videoRuntimeSchema.safeParse(await abortableVideo(this.options.authorize(scope.subscriptionId, signal), signal))
    this.assert(scope, epoch, signal)
    if (!result.success || (result.data.executionMode ?? 'mock') !== (this.options.mock ? 'mock' : 'real')) throw new AppError('PERMISSION_DENIED')
    this.runtimes.set(JSON.stringify(scope), result.data)
    if (execution && (!result.data.executionAvailable || !result.data.tools.some(tool => tool !== 'video_cancel_job'))) throw new AppError('PERMISSION_DENIED')
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
    const authorized = async <T>(parent: AbortSignal, call: (signal: AbortSignal, revision: number) => Promise<T>, execution = true): Promise<T> => {
      const signal = AbortSignal.any([parent, session, AbortSignal.timeout(this.options.operationTimeoutMs ?? 60_000)])
      const revisionNow = () => execution ? this.options.authorizationRevision() : this.recoveryRevision()
      const revision = revisionNow()
      if (!execution && this.options.authorizeRecovery) {
        this.assert(scope, epoch, signal)
        await abortableVideo(this.options.authorizeRecovery(scope.subscriptionId, signal), signal)
        this.assert(scope, epoch, signal)
      } else if (!execution) await this.runtime(scope, epoch, signal, false)
      const current = await this.task(taskId, signal)
      if (JSON.stringify(current.scope) !== JSON.stringify(scope) || revision !== revisionNow()) throw new AppError('AUTH_REQUIRED')
      const result = await abortableVideo(call(signal, revision), signal)
      this.assert(scope, epoch, signal)
      if (revision !== revisionNow()) throw new AppError('AUTH_REQUIRED')
      return result
    }
    const gateway: VideoGatewayPort = {
      quote: (input, signal) => authorized(signal, bounded => source.quote(input, bounded)),
      submit: (input, signal) => authorized(signal, async (bounded, revision) => {
        const dispatch = await this.sideEffect(scope, epoch, taskId, input.operation === 'image-to-video' ? 'video_from_image' : 'video_generate', bounded, revision)
        dispatch()
        return source.submit(input, bounded)
      }),
      findReceipt: (id, signal) => authorized(signal, bounded => source.findReceipt(id, bounded), false),
      getReceipt: (id, signal) => authorized(signal, bounded => source.getReceipt(id, bounded), false),
      content: (receiptId, outputId, signal) => authorized(signal, async (bounded, revision) => {
        const stream = await source.content(receiptId, outputId, bounded)
        const assert = () => {
          this.assert(scope, epoch, bounded)
          if (revision !== this.recoveryRevision()) throw new AppError('AUTH_REQUIRED')
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
      }, false),
    }
    const service = new VideoService({ scope, executionMode: this.options.mock ? 'mock' : 'real', store: this.options.store, gateway, now: this.now })
    const trackingOwner = Symbol('video-tracker')
    const trackedKeys = new Set<string>()
    const context: Context = {
      taskId, scope, service, trackingOwner, trackedKeys, tracker: new VideoTracker({ ...this.options.tracker, service: {
        resume: (id, jobId, signal) => service.resume(id, jobId, signal),
        recover: async signal => {
          const jobs = await service.listJobsSnapshot(taskId)
          if (jobs.some(job => job.trackingStatus === 'AUTH_REQUIRED')) return jobs
          const restored: LocalVideoJob[] = []
          for (const job of jobs) {
            signal?.throwIfAborted()
            if (this.options.trackingJobIds && !this.options.trackingJobIds.has(job.jobId)) continue
            const key = JSON.stringify([scope.enterpriseId, scope.memberId, scope.subscriptionId, taskId, job.jobId])
            const owner = trackingOwners.get(key)
            if (owner && owner !== trackingOwner) { restored.push(job); continue }
            trackingOwners.set(key, trackingOwner)
            trackedKeys.add(key)
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
    if (!runtime.executionAvailable || !runtime.tools.includes(tool) || !profile ||
      configVersion !== undefined && configVersion !== profile.configVersion || !profile.operations.includes(input.operation)) {
      throw new AppError('PERMISSION_DENIED')
    }
    if (input.localAssetIds.length > profile.capabilities.maxReferenceCount) throw new AppError('ADAPTER_FIELD_UNMAPPED', { details: { field: 'localAssetIds', source: 'adapter' } })
    if (runtime.protocolVersion === 3 && input.protocolVersion !== 3) throw new AppError('MISSING_SPEC', { details: { field: 'specRevision', source: 'client' } })
    if (input.protocolVersion === 3) {
      if (runtime.protocolVersion !== 3) throw new AppError('UPGRADE_REQUIRED')
      if (Object.keys(input.parameterSources ?? {}).some(key => input.parameters[key as keyof typeof input.parameters] === undefined)) throw new AppError('SPEC_CONFLICT', { details: { field: 'parameterSources', source: 'client' } })
      videoRequestedSpecSchema.parse(input.parameters)
    } else {
      const parameters = videoParametersSchema.parse(input.parameters)
      if (!profile.capabilities.durationsSeconds.includes(parameters.durationSeconds) ||
        !profile.capabilities.aspectRatios.includes(parameters.aspectRatio) || !profile.capabilities.resolutions.includes(parameters.resolution) ||
        !profile.capabilities.frameRates.includes(parameters.frameRate) || !profile.capabilities.outputFormats.includes(parameters.outputFormat) ||
        !videoAllowedAudioModes(runtime, profile).includes(parameters.audio)) throw new AppError('INVALID_ARGUMENT', { details: { field: 'parameters', source: 'platform' } })
    }
    return profile
  }
  private async binding(taskId: string, signal: AbortSignal) {
    const { scope, epoch } = await this.task(taskId, signal)
    const runtime = await this.runtime(scope, epoch, signal)
    return { scope, epoch, runtime, context: this.context(scope, epoch, taskId) }
  }
  private async localBinding(taskId: string, signal: AbortSignal) {
    const { scope, epoch } = await this.task(taskId, signal)
    return { scope, epoch, context: this.context(scope, epoch, taskId) }
  }
  private async savedOutput(taskId: string, jobId: string, outputId: string, signal: AbortSignal) {
    videoLocalIdSchema.parse(jobId); videoLocalIdSchema.parse(outputId)
    const revision = this.localRevision()
    const { scope: taskScope, epoch } = await this.task(taskId, signal)
    const validate = () => {
      this.assert(taskScope, epoch, signal)
      if (revision !== this.localRevision()) throw new AppError('AUTH_REQUIRED')
    }
    const validateTask = async () => {
      const current = await this.task(taskId, signal)
      validate()
      if (JSON.stringify(current.scope) !== JSON.stringify(taskScope)) throw new AppError('AUTH_REQUIRED')
    }
    // IPC supplies only task/job/output IDs. Resolve the employee from trusted
    // node evidence, never from renderer input or a scan of other employees.
    const link = await abortableVideo(this.options.arrangementMediaLinks?.get(taskScope, taskId, 'video', jobId) ?? Promise.resolve(null), signal)
    validate()
    const scope = link ? videoScopeSchema.parse({ ...taskScope, subscriptionId: link.subscriptionId }) : taskScope
    const job = await abortableVideo(this.options.store.getJob(scope, taskId, jobId), signal)
    validate()
    if (!job || (job.executionMode ?? 'mock') !== (this.options.mock ? 'mock' : 'real')) throw new AppError('NOT_FOUND')
    const output = job.receipt?.outputs.find(output => output.outputId === outputId)
    const asset = await abortableVideo(this.options.store.getAsset(scope, taskId, jobId, outputId), signal)
    await validateTask()
    if (!output || asset?.status !== 'SAVED') throw new AppError('NOT_FOUND')
    if (link && (job.runId !== link.nodeRunId || !link.outputs.some(item =>
      item.artifactId === asset.localAssetId && item.sha256 === asset.output.sha256))) throw new AppError('NOT_FOUND')
    return { scope, output, asset, validate, validateTask }
  }
  private operation<T>(taskId: string, call: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(call)
    this.active.add(pending)
    const operations = this.taskOperations.get(taskId) ?? new Set<Promise<unknown>>()
    this.taskOperations.set(taskId, operations)
    operations.add(pending)
    return pending.finally(() => { this.active.delete(pending); operations.delete(pending); if (!operations.size && this.taskOperations.get(taskId) === operations) this.taskOperations.delete(taskId) })
  }
  /** Explicit online execution refresh; history reads never call this method. */
  async authorizeExecution(taskId: string, parent?: AbortSignal): Promise<VideoRuntime> {
    const signal = this.signal(taskId, parent)
    const revision = this.options.authorizationRevision()
    const { scope, epoch, runtime } = await this.binding(taskId, signal)
    const current = await this.task(taskId, signal)
    this.assert(scope, epoch, signal)
    if (JSON.stringify(current.scope) !== JSON.stringify(scope) || revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
    return runtime
  }
  async getTaskVideo(taskId: string): Promise<VideoTaskView> {
    const signal = this.signal(taskId)
    const revision = this.localRevision()
    const { scope, epoch, context } = await this.localBinding(taskId, signal)
    const runtime = this.localRuntime(scope)
    const jobs = await context.service.listJobsSnapshot(taskId)
    const views: VideoJobView[] = []
    for (const job of jobs) {
      const savedOutputIds: string[] = []
      let invalidOutput = false
      for (const output of job.receipt?.outputs ?? []) {
        // A corrupt output must remain visible for explicit repair. Never count
        // it as saved or let it hide the other verified outputs in the task.
        try {
          const asset = await this.options.store.getAsset(scope, taskId, job.jobId, output.outputId)
          if (asset?.status === 'SAVED') savedOutputIds.push(output.outputId)
        } catch { invalidOutput = true }
      }
      const view = jobView(job)
      const hasMissing = (job.receipt?.outputs.length ?? 0) > 0 && savedOutputIds.length < (job.receipt?.outputs.length ?? 0)
      views.push({ ...view, ...(job.saveStatus === 'SAVED' && invalidOutput ? { saveStatus: 'SAVE_FAILED' as const, error: 'VIDEO_LOCAL_OUTPUT_INVALID' as const } :
        job.saveStatus === 'SAVED' && hasMissing ? { saveStatus: 'MISSING' as const, error: 'VIDEO_LOCAL_OUTPUT_MISSING' as const } : {}), savedOutputIds })
    }
    this.assert(scope, epoch, signal)
    if (revision !== this.localRevision()) throw new AppError('AUTH_REQUIRED')
    return { mock: this.options.mock, runtime, jobs: views }
  }
  async getReferences(taskId: string): Promise<MediaAssetView[]> {
    const signal = this.signal(taskId)
    const revision = this.localRevision()
    const { scope, epoch } = await this.localBinding(taskId, signal)
    const assets = await this.options.references?.list(scope, taskId) ?? []
    this.assert(scope, epoch, signal)
    if (revision !== this.localRevision()) throw new AppError('AUTH_REQUIRED')
    return assets.filter(asset => asset.source === 'reference' && asset.taskId === taskId).map(asset => ({
      localAssetId: asset.localAssetId, taskId: asset.taskId, jobId: null, outputId: null,
      source: 'reference', mime: asset.mime, size: asset.size, width: asset.width, height: asset.height, status: asset.status,
    }))
  }
  /** Native dialogs retain an authorization lease, never renderer-provided paths. */
  async nativeSelection(taskId: string) {
    const signal = this.signal(taskId)
    const revision = this.localRevision()
    const { scope, epoch } = await this.task(taskId, signal)
    const validate = () => {
      this.assert(scope, epoch, signal)
      if (revision !== this.localRevision()) throw new AppError('AUTH_REQUIRED')
    }
    const validateTask = async () => {
      const current = await this.task(taskId, signal)
      validate()
      if (JSON.stringify(current.scope) !== JSON.stringify(scope)) throw new AppError('AUTH_REQUIRED')
    }
    validate()
    return {
      import: async (paths: readonly string[]) => this.operation(taskId, async () => {
        validate()
        await validateTask()
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
        await validateTask()
        if (!this.options.exportOutput) throw new AppError('SERVICE_UNAVAILABLE')
        const saved = await this.savedOutput(taskId, jobId, outputId, signal)
        await validateTask()
        const validateOutput = () => { validate(); saved.validate() }
        validateOutput()
        await this.options.exportOutput(saved.scope, taskId, jobId, outputId, path, signal, validateOutput)
        await validateTask()
      }),
    }
  }
  async preview(taskId: string, jobId: string, outputId: string) {
    const signal = this.signal(taskId)
    const { scope, asset, validate, validateTask } = await this.savedOutput(taskId, jobId, outputId, signal)
    if (asset.output.mimeType !== 'video/mp4' && asset.output.mimeType !== 'video/webm') throw new AppError('INVALID_STATE', { message: '此视频格式暂不支持本地预览，可以导出原件后使用兼容的播放器打开。' })
    // Real outputs open through the native adapter; never transfer their bytes over IPC.
    if (!this.options.mock) {
      if (!this.options.openOutput || asset.output.byteLength > 256 * 1024 * 1024) throw new AppError('INVALID_ARGUMENT')
      validate()
      await this.operation(taskId, () => this.options.openOutput!(scope, taskId, jobId, outputId, signal, validate))
      await validateTask()
      return { mime: asset.output.mimeType, opened: true as const }
    }
    if (asset.output.byteLength > 16 * 1024 * 1024) throw new AppError('INVALID_ARGUMENT')
    const bytes = await abortableVideo(this.options.store.readAsset(scope, taskId, jobId, outputId), signal)
    await validateTask()
    return { mime: asset.output.mimeType, bytes }
  }
  async outputInfo(taskId: string, jobId: string, outputId: string) {
    return (await this.savedOutput(taskId, jobId, outputId, this.signal(taskId))).output
  }
  async generate(taskId: string, value: VideoGenerationInput, parent?: AbortSignal, run?: GenerationRun): Promise<VideoJobView> {
    const input = videoGenerationInputSchema.parse(value)
    return this.generateRequest(taskId, () => input, parent, run)
  }
  async generateTool(taskId: string, name: 'video_generate' | 'video_from_image', raw: unknown, parent?: AbortSignal, run?: GenerationRun): Promise<VideoJobView> {
    const parsed = videoToolGenerationInputSchema.safeParse(raw)
    if (!parsed.success) throw new AppError('INVALID_ARGUMENT')
    const { requirementId: _requirementId, ...request } = parsed.data
    const operation = name === 'video_from_image' ? 'image-to-video' : 'text-to-video'
    if (request.operation !== undefined && request.operation !== operation || request.localAssetIds.length !== (operation === 'image-to-video' ? 1 : 0)) throw new AppError('INVALID_ARGUMENT')
    return this.generateRequest(taskId, runtime => {
      const profiles = runtime.profiles.filter(profile => profile.operations.includes(operation) &&
        (operation === 'image-to-video' ? profile.capabilities.supportsImageToVideo : profile.capabilities.supportsTextToVideo))
      const profile = request.profileId ? profiles.find(profile => profile.profileId === request.profileId)
        : profiles.find(profile => profile.profileId === runtime.defaultProfileId) ?? profiles[0]
      if (!profile) throw new AppError('PERMISSION_DENIED')
      const parameters = request.requestedSpec ?? request.parameters ?? {}
      if (runtime.protocolVersion === 3) {
        const metadata = mediaSpecMetadataSchema.safeParse({ protocolVersion: request.protocolVersion, specRevision: request.specRevision, parameterSources: request.parameterSources })
        if (!metadata.success) throw new AppError('MISSING_SPEC', { details: { field: 'specRevision', source: 'client' } })
        if (Object.keys(metadata.data.parameterSources).some(key => parameters[key as keyof typeof parameters] === undefined)) throw new AppError('SPEC_CONFLICT', { details: { field: 'parameterSources', source: 'client' } })
        return { ...request, ...metadata.data, requestedSpec: parameters, profileId: profile.profileId, operation, parameters }
      }
      if (request.protocolVersion === 3 || request.requestedSpec !== undefined) throw new AppError('UPGRADE_REQUIRED')
      const legacy = videoParametersSchema.safeParse(parameters)
      if (!legacy.success) throw new AppError('MISSING_SPEC', { details: { field: 'parameters', source: 'client' } })
      return { ...request, profileId: profile.profileId, operation, parameters: legacy.data }
    }, parent, run)
  }
  private async generateRequest(taskId: string, resolve: (runtime: VideoRuntime) => VideoGenerationInput, parent?: AbortSignal, run?: GenerationRun): Promise<VideoJobView> {
    const signal = this.signal(taskId, parent)
    const revision = this.options.authorizationRevision()
    return this.operation(taskId, async () => {
      const owner = requireScope(this.options.scope)
      const key = JSON.stringify([owner.enterpriseId, owner.memberId, taskId])
      if (submissions.has(key)) throw new AppError('CONFLICT')
      submissions.add(key)
      try {
        const { scope, epoch, runtime, context } = await this.binding(taskId, signal)
        const input = resolve(runtime)
        const jobs = await context.service.listJobsSnapshot(taskId)
        this.assert(scope, epoch, signal)
        const runId = run?.runId ?? randomUUID()
        // Tool retries in one run must observe the original durable job. This
        // avoids a second quote/submit after a successful response was lost.
        const duplicate = input.localAssetIds.length === 0 ? jobs.find(job => job.taskId === taskId && job.runId === runId && !videoSubmissionRejected(job) &&
          job.request.operation === input.operation && job.request.profileId === input.profileId &&
          job.request.creativeBrief === input.creativeBrief &&
          job.request.specRevision === input.specRevision && mediaSpecsEqual(job.request.parameters, input.parameters) && job.request.referenceIds.length === 0) : undefined
        if (duplicate) return jobView(duplicate)
        if (jobs.some(job => job.taskId === taskId && !videoSubmissionRejected(job) && (job.submission === 'MAYBE_SENT' || job.receipt?.status === 'SUBMISSION_UNKNOWN'))) {
          throw new AppError('CONFLICT', { message: '原视频提交状态尚未确认，请查询或恢复原任务，不能重复生成。' })
        }
        const profile = this.profile(runtime, input)
        const policy = this.options.policy ? await abortableVideo(this.options.policy(taskId), signal) : undefined
        const toolName = input.operation === 'image-to-video' ? 'video_from_image' : 'video_generate'
        if (policy && (policy.preset === 'read-only' || policy.preset !== 'full-local' && !policy.allowedTools.includes(toolName))) throw new AppError('PERMISSION_DENIED')
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
          await approve({ operation: 'upload-references', referenceCount: input.localAssetIds.length, mock: this.options.mock })
          for (const id of input.localAssetIds) {
            const reference = await abortableVideo(this.options.readReference(scope, taskId, id), signal)
            this.assert(scope, epoch, signal)
            if (reference.bytes.byteLength > profile.capabilities.maxInputBytes || createHash('sha256').update(reference.bytes).digest('hex') !== reference.sha256) throw new AppError('INVALID_ARGUMENT')
            const uploaded = videoReferenceSchema.parse(await context.uploadReference(taskId, toolName, reference.bytes, signal))
            if (uploaded.mock !== this.options.mock || uploaded.sha256.toLowerCase() !== reference.sha256.toLowerCase() || uploaded.byteLength !== reference.bytes.byteLength || Date.parse(uploaded.expiresAt) <= this.now()) throw new AppError('INVALID_STATE')
            referenceIds.push(uploaded.referenceId)
          }
        }
        const { localAssetIds: _localAssetIds, ...semantic } = input
        const job = await context.service.prepare(taskId, { ...semantic, configVersion: profile.configVersion, referenceIds }, signal, run?.runId)
        if (this.options.mock ? job.quote.amount !== '0.000000' || job.quote.currency !== 'MOCK' : job.quote.currency !== 'CNY' || !/^\d+\.\d{6}$/.test(job.quote.amount ?? '')) throw new AppError('PERMISSION_DENIED')
        await approve({ profile: profile.displayName, parameters: input.parameters, creativeBrief: input.creativeBrief,
          mock: this.options.mock, quote: { amount: job.quote.amount, currency: job.quote.currency, expiresAt: job.quote.expiresAt,
            ...(!this.options.mock ? { amountUsd: job.quote.amountUsd, funding: job.quote.funding, pricingVersion: job.quote.pricingVersion } : {}) } })
        // Approval is for the captured task/subscription and frozen configuration only.
        this.profile(await this.runtime(scope, epoch, signal), input, profile.configVersion)
        const current = await this.task(taskId, signal)
        if (JSON.stringify(current.scope) !== JSON.stringify(scope)) throw new AppError('AUTH_REQUIRED')
        if (revision !== this.options.authorizationRevision()) throw new AppError('AUTH_REQUIRED')
        await run?.onJobCreated?.({ kind: 'video', jobId: job.jobId, operation: input.operation, localAssetIds: input.localAssetIds })
        this.assert(scope, epoch, signal)
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
      const { scope, epoch, context } = await this.localBinding(taskId, signal)
      const job = await context.service.resume(taskId, jobId, signal)
      this.assert(scope, epoch, signal)
      return jobView(job)
    })
  }
  async retrySave(taskId: string, jobId: string): Promise<VideoJobView> {
    const signal = this.signal(taskId)
    return this.operation(taskId, async () => {
      const { scope, epoch, context } = await this.localBinding(taskId, signal)
      const job = await context.service.retrySave(taskId, jobId, signal)
      this.assert(scope, epoch, signal)
      return jobView(job)
    })
  }
  /** Observers may wait on another host's bounded tracker without starting one. */
  hasActiveTracker(taskId: string, jobId: string): boolean {
    const owner = requireScope(this.options.scope)
    return [...this.contexts.values()].some(({ scope, taskId: id }) => id === taskId &&
      scope.enterpriseId === owner.enterpriseId && scope.memberId === owner.memberId &&
      trackingOwners.has(JSON.stringify([scope.enterpriseId, scope.memberId, scope.subscriptionId, taskId, jobId])))
  }

  /** Only explicit host/run lifecycle calls wake recovery; reads never do. */
  async track(taskId: string): Promise<void> {
    const signal = this.signal(taskId)
    return this.operation(taskId, async () => {
      const { scope, epoch } = await this.task(taskId, signal)
      // Let service.recover persist a grant failure as AUTH_REQUIRED. Checking
      // runtime before entering recover would leave disk jobs ACTIVE on denial.
      const context = this.context(scope, epoch, taskId)
      if (!context.tracking) {
        context.tracking = context.tracker.wake().finally(() => {
          for (const key of context.trackedKeys) {
            if (trackingOwners.get(key) === context.trackingOwner) trackingOwners.delete(key)
          }
          context.trackedKeys.clear()
          context.tracking = undefined
        })
      }
      await context.tracking
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
          (videoBillingPending(job.billingStatus) || job.trackingStatus === 'ACTIVE' || job.trackingStatus === 'INTERRUPTED' ||
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
    this.runtimes.clear()
    await Promise.allSettled(contexts.map(context => context.tracker.stop()))
    await Promise.allSettled([...this.active])
    this.taskSessions.clear()
    this.session = new AbortController()
  }
}
