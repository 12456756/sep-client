import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { MediaAssetView, MediaJobView, MediaTaskView } from '../../src/shared/media'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { TaskOwnerScope } from '../data/scope-path'
import type { LocalMediaJob, MediaCapabilities, MediaGatewayPort, MediaGenerationInput, MediaReceipt, MediaStorePort } from '../domain/media'
import type { MediaHostTools, MediaJobCreated } from '../domain/media-tools'
import type { EmployeeRuntimeConfig, TaskToolPolicy } from '../runtime/run-types'
import { mediaToolGenerationInputSchema } from '../../src/shared/media-host'
import { mediaId, mediaQuoteSchema, mediaReceiptSchema, parseMediaCapabilities, parseMediaInput } from '../common/platform/media-contract'
import { realMediaParameters, realMediaSemanticHash } from '../common/platform/real-media-semantics'
import { imageAspectRatio } from '../../src/shared/media-spec'
import { logger } from '../common/logger'
import { AppError } from '../errors/app-error'
import { transportKind } from '../errors/operation-feedback'
import { requireScope, type ScopeSource } from './scope-guard'

const log = logger.child('media-service')
const terminal = new Set(['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'])
const explicitStop = Symbol('explicit-media-stop')
type Approval = (input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => Promise<boolean>
interface TaskBinding { subscriptionId?: string | null }
export type MediaEmployeeRuntime = Pick<EmployeeRuntimeConfig, 'subscriptionId' | 'media' | 'runtimeSnapshot' | 'systemPrompt'>
export interface MediaServiceOptions {
  scope: ScopeSource
  store: MediaStorePort
  gateway?: MediaGatewayPort
  getTask: (taskId: string) => Promise<TaskBinding | null>
  authorize: (subscriptionId: string) => Promise<MediaEmployeeRuntime | null>
  requestApproval: Approval
  policy?: (taskId: string) => Promise<TaskToolPolicy | undefined>
  capabilities?: (employee: MediaEmployeeRuntime) => unknown
  pollFloorMs?: number
  maxAttempts?: number
  operationTimeoutMs?: number
  /** Submission may outlive ordinary control-plane calls while SEP waits on its upstream. */
  submissionTimeoutMs?: number
}
interface RunInput {
  taskId: string; runId: string; subscriptionId: string; employee: MediaEmployeeRuntime
  toolPolicy?: TaskToolPolicy; requestApproval: Approval
  onJobCreated?: (job: MediaJobCreated) => Promise<void>
  recoverJobIds?: readonly string[]
}
interface Activity { taskId: string; controller: AbortController; promise: Promise<void> }

/** Host-owned execution. No provider payloads, filesystem paths or prices come from the model. */
export class MediaService {
  private epoch = 0
  private sessionController = new AbortController()
  private readonly activities = new Map<string, Activity>()
  private readonly caps = new Map<string, MediaCapabilities | null>()
  private readonly capabilityLoads = new Map<string, Promise<void>>()
  private readonly selectedReferences = new Map<string, string[]>()
  private readonly submitting = new Set<string>()
  private readonly recoveryQueue = new Map<string, { taskId: string; jobId: string }>()
  private readonly runRecoveries = new Map<string, string[]>()
  private readonly taskStops = new Map<string, number>()
  private readonly jobStops = new Map<string, number>()
  private recoveryDraining = false
  constructor(private readonly options: MediaServiceOptions) {}

  private scope(): TaskOwnerScope { return requireScope(this.options.scope) }
  private assert(scope: TaskOwnerScope, epoch = this.epoch): void {
    const current = this.options.scope.currentScope()
    if (epoch !== this.epoch || !current || current.enterpriseId !== scope.enterpriseId || current.memberId !== scope.memberId) throw new AppError('AUTH_REQUIRED')
  }
  private key(scope: TaskOwnerScope, id: string): string { return JSON.stringify([scope.enterpriseId, scope.memberId, id]) }
  private async task(taskId: string): Promise<{ scope: TaskOwnerScope; subscriptionId: string }> {
    mediaId.parse(taskId)
    const scope = this.scope(), epoch = this.epoch
    const task = await this.options.getTask(taskId)
    this.assert(scope, epoch)
    if (!task?.subscriptionId) throw new AppError('NOT_FOUND')
    return { scope, subscriptionId: task.subscriptionId }
  }
  private gateway(): MediaGatewayPort {
    if (!this.options.gateway) throw new AppError('SERVICE_UNAVAILABLE', { message: '图片网关尚未接通，当前不能生成图片。' })
    return this.options.gateway
  }
  private capabilities(employee: MediaEmployeeRuntime): MediaCapabilities | null {
    if (!this.options.gateway) return null
    const raw = this.options.capabilities?.(employee) ?? employee.media
    if (raw === undefined || raw === null) return null
    try {
      const parsed = parseMediaCapabilities(raw)
      return parsed.profiles.length ? parsed : null
    } catch {
      log.warn('media capabilities unavailable', { subscriptionId: employee.subscriptionId })
      return null
    }
  }
  private invalidateCapabilities(scope: TaskOwnerScope, taskId: string, epoch: number, error: unknown): void {
    if (epoch !== this.epoch || !(error instanceof AppError) || (error.code !== 'AUTH_REQUIRED' && error.code !== 'PERMISSION_DENIED'
      && error.code !== 'MEDIA_FORBIDDEN' && error.details?.businessCode !== 'CONFIG_CHANGED')) return
    const key = this.key(scope, taskId)
    this.caps.delete(key)
    this.capabilityLoads.delete(key)
  }
  private async network<T>(scope: TaskOwnerScope, parent: AbortSignal, call: (signal: AbortSignal) => Promise<T>, timeoutMs = this.options.operationTimeoutMs ?? 60_000): Promise<T> {
    const epoch = this.epoch
    this.assert(scope, epoch)
    const signal = AbortSignal.any([parent, this.sessionController.signal, AbortSignal.timeout(timeoutMs)])
    signal.throwIfAborted()
    let onAbort: () => void = () => undefined
    try {
      const abort = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }) })
      const result = await Promise.race([call(signal), abort])
      this.assert(scope, epoch)
      signal.throwIfAborted()
      return result
    } finally { signal.removeEventListener('abort', onAbort) }
  }
  private viewAsset(asset: MediaAssetView): MediaAssetView {
    return { localAssetId: asset.localAssetId, taskId: asset.taskId, jobId: asset.jobId, outputId: asset.outputId,
      source: asset.source, mime: asset.mime, size: asset.size, width: asset.width, height: asset.height, status: asset.status }
  }
  private needsBillingQuery(job: LocalMediaJob): boolean {
    return (job.billingStatus === 'RESERVED' || job.billingStatus === 'RECONCILING') && job.recovery?.canQuery === true
  }
  private viewJob(job: LocalMediaJob, assets: MediaAssetView[]): MediaJobView {
    const jobAssets = assets.filter(asset => asset.jobId === job.jobId)
    const missingOutput = job.outputs.some(output => !jobAssets.some(asset => asset.outputId === output.outputId && asset.status === 'SAVED'))
    const saveStatus = job.saveStatus === 'SAVED' && missingOutput ? 'MISSING' : job.saveStatus
    const canRetrySave = job.recovery?.canDownload !== false && job.outputs.some(output =>
      (output.expiresAt === null || output.expiresAt > Date.now()) && !jobAssets.some(asset => asset.outputId === output.outputId && asset.status === 'SAVED'))
    return { jobId: job.jobId, taskId: job.taskId, runId: job.runId, profileId: job.profile.profileId,
      operation: job.input.operation, parameters: { ...job.input.parameters }, generationStatus: job.generationStatus,
      trackingStatus: job.trackingStatus, saveStatus, billingStatus: job.billingStatus,
      ...(job.lastQueriedAt !== undefined ? { lastQueriedAt: job.lastQueriedAt } : {}),
      ...(job.providerWaitMs !== undefined ? { providerWaitMs: job.providerWaitMs } : {}),
      ...(job.downloadMs !== undefined ? { downloadMs: job.downloadMs } : {}),
      error: this.publicJobError(job.errorCode ?? job.error), createdAt: job.createdAt, updatedAt: job.updatedAt,
      assets: jobAssets.map(asset => this.viewAsset(asset)), canRetrySave,
      canResumeTracking: terminal.has(job.generationStatus) ? canRetrySave || this.needsBillingQuery(job) : job.recovery?.canQuery !== false,
      canCancelUpstream: job.recovery?.canCancel !== false && job.profile.capabilities.cancel && !!job.receiptId && !terminal.has(job.generationStatus) }
  }
  private publicJobError(error: string | null): string | null {
    if (!error) return null
    if (error === '本地跟踪已停止，上游任务可能仍在执行。') return 'TRACKING_STOPPED'
    if (error === '未保存的原结果已过期，无法再次下载；已保存的图片仍可使用。') return 'RESULT_EXPIRED'
    if (error === '原结果当前不可下载，不会重新生成。') return 'DOWNLOAD_UNAVAILABLE'
    if (error === '本轮跟踪已达时长或查询上限，可手动恢复原请求。' || error === '查询重试已达上限，可继续跟踪原请求。') return 'TRACKING_LIMIT'
    if (error === '服务端无法继续查询原请求，不会再次生成。' || error === '该通道不支持按原请求找回，不能自动恢复。') return 'QUERY_UNAVAILABLE'
    return ['AUTH_REQUIRED', 'NETWORK_ERROR', 'NETWORK_TIMEOUT', 'RATE_LIMITED', 'INSUFFICIENT_FUNDS', 'QUOTE_EXPIRED', 'MEDIA_FORBIDDEN', 'PERMISSION_DENIED'].includes(error) ? error : 'MEDIA_FAILED'
  }
  private async loadCapabilities(scope: TaskOwnerScope, taskId: string, subscriptionId: string, refresh: boolean, epoch: number): Promise<void> {
    const key = this.key(scope, taskId)
    const existing = this.capabilityLoads.get(key)
    if (existing) return existing
    if (!refresh && this.caps.has(key)) return
    this.caps.delete(key)
    if (!this.options.gateway) return
    const pending = Promise.resolve().then(async () => {
      this.assert(scope, epoch)
      let employee: MediaEmployeeRuntime | null = null
      try { employee = await this.network(scope, this.sessionController.signal, () => this.options.authorize(subscriptionId)) } catch {
        // Historical reads survive grant failures; the next read retries.
      }
      this.assert(scope, epoch)
      // A newly admitted run can supersede a presentation-only refresh.
      if (employee && this.capabilityLoads.get(key) === pending) this.caps.set(key, this.capabilities(employee))
    })
    this.capabilityLoads.set(key, pending)
    try { await pending } finally {
      if (this.capabilityLoads.get(key) === pending) this.capabilityLoads.delete(key)
    }
  }
  async getTaskMedia(taskId: string, options: { refreshCapabilities?: boolean } = {}): Promise<MediaTaskView> {
    const { scope, subscriptionId } = await this.task(taskId), epoch = this.epoch
    const key = this.key(scope, taskId)
    await this.loadCapabilities(scope, taskId, subscriptionId, options.refreshCapabilities === true, epoch)
    const [assets, jobs, archived] = await Promise.all([this.options.store.listAssets(scope, taskId), this.options.store.listJobs(scope, taskId), this.options.store.isArchived(scope, taskId)])
    this.assert(scope, epoch)
    const capabilities = this.caps.get(key) ?? null
    return { capabilities, unavailableReason: capabilities ? null : !this.options.gateway
      ? 'SEP 图片执行接口尚未接通，当前不能生成图片，普通对话不受影响。'
      : '当前员工未提供可用的图片能力，普通对话不受影响。',
      assets: assets.map(asset => this.viewAsset(asset)), selectedReferenceIds: this.selectedReferences.get(key) ?? [],
      jobs: jobs.map(job => this.viewJob(job, assets)), archived }
  }
  async setReferenceSelection(taskId: string, assetIds: readonly string[]): Promise<void> {
    const { scope } = await this.task(taskId), epoch = this.epoch
    if (new Set(assetIds).size !== assetIds.length || assetIds.length > 16) throw new AppError('INVALID_ARGUMENT')
    if (await this.options.store.isArchived(scope, taskId)) throw new AppError('INVALID_STATE')
    const assets = await this.options.store.listAssets(scope, taskId)
    this.assert(scope, epoch)
    const available = new Set(assets.filter(asset => asset.source === 'reference' && asset.status === 'SAVED').map(asset => asset.localAssetId))
    if (assetIds.some(assetId => !available.has(assetId))) throw new AppError('INVALID_ARGUMENT')
    this.selectedReferences.set(this.key(scope, taskId), [...assetIds])
  }
  async importReferences(taskId: string, paths: readonly string[]): Promise<MediaAssetView[]> {
    const { scope } = await this.task(taskId), epoch = this.epoch
    if (await this.options.store.isArchived(scope, taskId)) throw new AppError('INVALID_STATE')
    const imported: MediaAssetView[] = []
    for (const path of paths) { this.assert(scope, epoch); imported.push(this.viewAsset(await this.options.store.importReference(scope, taskId, path))) }
    this.assert(scope, epoch)
    return imported
  }
  async nativeSelection(taskId: string) {
    const { scope } = await this.task(taskId), epoch = this.epoch
    return {
      import: async (paths: readonly string[]) => { this.assert(scope, epoch); return this.importReferences(taskId, paths) },
      export: async (assetId: string, path: string) => { this.assert(scope, epoch); await this.export(taskId, assetId, path) },
    }
  }
  async preview(taskId: string, assetId: string) {
    const { scope } = await this.task(taskId), epoch = this.epoch
    const asset = await this.options.store.getAsset(scope, taskId, assetId)
    if (!asset) throw new AppError('NOT_FOUND')
    const bytes = await this.options.store.readAsset(scope, taskId, assetId)
    this.assert(scope, epoch)
    return { mime: asset.mime, bytes }
  }
  async export(taskId: string, assetId: string, path: string): Promise<void> {
    const { scope } = await this.task(taskId), epoch = this.epoch
    await this.options.store.exportAsset(scope, taskId, assetId, path)
    this.assert(scope, epoch)
  }
  async prepareRun(input: RunInput): Promise<MediaHostTools | undefined> {
    const { scope } = await this.task(input.taskId), epoch = this.epoch
    const approved = input.employee.runtimeSnapshot
    if (input.subscriptionId !== input.employee.subscriptionId || (approved && (approved.enterpriseId !== scope.enterpriseId || approved.memberId !== scope.memberId || approved.subscriptionId !== input.subscriptionId))) throw new AppError('AUTH_REQUIRED')
    const capabilities = this.capabilities(input.employee)
    this.capabilityLoads.delete(this.key(scope, input.taskId))
    this.caps.set(this.key(scope, input.taskId), capabilities)
    await this.options.store.saveSnapshot(scope, { version: 1, owner: scope, taskId: input.taskId, runId: input.runId,
      subscriptionId: input.subscriptionId, systemPrompt: input.employee.systemPrompt ?? '',
      skills: input.employee.runtimeSnapshot?.skills.map(skill => ({ path: skill.path, sha256: skill.sha256, version: skill.version })) ?? [],
      capabilities, runtimeSnapshot: input.employee.runtimeSnapshot, createdAt: Date.now() })
    this.assert(scope, epoch)
    const recovered: string[] = []
    for (const jobId of input.recoverJobIds ?? []) {
      try { mediaId.parse(jobId) } catch { continue }
      const job = await this.options.store.getJob(scope, input.taskId, jobId)
      if (!job || job.subscriptionId !== input.subscriptionId || job.submission === 'NOT_SENT') continue
      recovered.push(jobId)
      if (!(job.generationStatus === 'SUCCEEDED' || job.generationStatus === 'PARTIAL_SUCCEEDED') || job.saveStatus !== 'SAVED') {
        await this.resume(input.taskId, jobId)
      }
    }
    if (recovered.length) this.runRecoveries.set(this.key(scope, input.taskId) + ':' + input.runId, recovered)
    if (!capabilities) return undefined
    return { names: capabilities.tools, execute: async (name, raw, signal) => {
      this.assert(scope, epoch)
      if (!capabilities.tools.includes(name)) throw new AppError('PERMISSION_DENIED')
      if (name === 'media_get_capabilities') {
        z.object({}).strict().parse(raw)
        const selected = new Set(this.selectedReferences.get(this.key(scope, input.taskId)) ?? [])
        const referenceAssets = (await this.options.store.listAssets(scope, input.taskId))
          .filter(asset => selected.has(asset.localAssetId)).map(asset => this.viewAsset(asset))
        this.assert(scope, epoch)
        return { capabilities, referenceAssets }
      }
      if (name === 'media_generate_image') {
        const requested = mediaToolGenerationInputSchema.parse(raw)
        const profile = requested.profileId
          ? capabilities.profiles.find(item => item.profileId === requested.profileId)
          : capabilities.profiles.find(item => item.profileId === capabilities.defaultProfileId) ?? capabilities.profiles[0]
        if (!profile) throw new AppError('INVALID_ARGUMENT', { message: '当前授权配置没有可用的图片模型。' })
        const localAssetIds = requested.localAssetIds ?? this.selectedReferences.get(this.key(scope, input.taskId)) ?? []
        const operation = requested.operation ?? (localAssetIds.length && profile.operations.includes('edit')
          ? 'edit' : profile.operations.includes('generate') ? 'generate' : 'edit')
        const requestedParameters = requested.parameters ?? {}
        const ratios = profile.allowedAspectRatios.filter(ratio => !profile.allowedSizes?.length || profile.allowedSizes.some(size => {
          const mapped = imageAspectRatio(size)
          return mapped === undefined || mapped === ratio
        }))
        if (requestedParameters.aspectRatio && !ratios.includes(requestedParameters.aspectRatio)) throw new AppError('INVALID_ARGUMENT')
        const sizes = (profile.allowedSizes ?? []).filter(size => {
          const ratio = imageAspectRatio(size)
          return ratio === undefined || profile.allowedAspectRatios.includes(ratio)
        })
        const size = requestedParameters.size
        if (size && !sizes.includes(size)) throw new AppError('INVALID_ARGUMENT')
        const aspectRatio = requestedParameters.aspectRatio ?? (size && imageAspectRatio(size)) ??
          (profile.defaultSize && imageAspectRatio(profile.defaultSize)) ?? ratios[0]
        const quality = requestedParameters.quality ?? profile.defaultQuality ?? profile.allowedQualities?.[0]
        const count = requestedParameters.count ?? 1
        if (!aspectRatio || (quality && !profile.allowedQualities?.includes(quality)) || (size && imageAspectRatio(size) && imageAspectRatio(size) !== aspectRatio)) {
          throw new AppError('INVALID_ARGUMENT')
        }
        const toolSize = size ?? sizes.find(value => imageAspectRatio(value) === undefined)
        const normalized = parseMediaInput({ profileId: profile.profileId, operation, localAssetIds, creativeBrief: requested.creativeBrief,
          parameters: { aspectRatio, count, ...(toolSize ? { size: toolSize } : {}), ...(quality ? { quality } : {}) } })
        return this.generate(input.taskId, normalized, { ...input, capabilities }, signal)
      }
      const args = z.object({ jobId: mediaId, cancelUpstream: z.boolean().optional() }).strict().parse(raw)
      if (name === 'media_cancel_job') await this.cancel(input.taskId, args.jobId, args.cancelUpstream ?? false, input, signal)
      return this.getJobView(input.taskId, args.jobId)
    } }
  }
  async generateTaskMedia(taskId: string, raw: MediaGenerationInput): Promise<MediaJobView> {
    const initialScope = this.scope(), initialEpoch = this.epoch, stopKey = this.key(initialScope, taskId)
    const stopVersion = this.taskStops.get(stopKey) ?? 0
    const { scope, subscriptionId } = await this.task(taskId), epoch = this.epoch
    const employee = await this.options.authorize(subscriptionId)
    this.assert(scope, epoch)
    if (!employee) throw new AppError('EMPLOYEE_UNAVAILABLE')
    const capabilities = this.capabilities(employee)
    if (!capabilities) throw new AppError('SERVICE_UNAVAILABLE')
    const runId = randomUUID(), toolPolicy = await this.options.policy?.(taskId)
    this.assert(scope, epoch)
    await this.prepareRun({ taskId, runId, subscriptionId, employee, toolPolicy, requestApproval: this.options.requestApproval })
    this.assert(initialScope, initialEpoch)
    if (stopVersion !== (this.taskStops.get(stopKey) ?? 0)) throw new AppError('INVALID_STATE')
    return this.generate(taskId, parseMediaInput(raw), { runId, subscriptionId, toolPolicy, capabilities, requestApproval: this.options.requestApproval })
  }
  private async generate(taskId: string, input: MediaGenerationInput, binding: { runId: string; subscriptionId: string; toolPolicy?: TaskToolPolicy; capabilities: MediaCapabilities; requestApproval: Approval; onJobCreated?: RunInput['onJobCreated'] }, signal?: AbortSignal): Promise<MediaJobView> {
    const epoch = this.epoch, initialScope = this.scope(), stopKey = this.key(initialScope, taskId)
    const stopVersion = this.taskStops.get(stopKey) ?? 0
    const { scope } = await this.task(taskId)
    if (await this.options.store.isArchived(scope, taskId)) throw new AppError('INVALID_STATE')
    this.assert(scope, epoch); signal?.throwIfAborted()
    if (stopVersion !== (this.taskStops.get(stopKey) ?? 0)) throw new AppError('INVALID_STATE')
    if (binding.toolPolicy && (binding.toolPolicy.preset === 'read-only' || (binding.toolPolicy.preset !== 'full-local' && !binding.toolPolicy.allowedTools.includes('media_generate_image')))) throw new AppError('PERMISSION_DENIED')
    const profile = binding.capabilities.profiles.find(profile => profile.profileId === input.profileId)
    if (!binding.capabilities.tools.includes('media_generate_image') || !profile || !profile.operations.includes(input.operation)
      || !profile.allowedAspectRatios.includes(input.parameters.aspectRatio) || input.parameters.count > profile.maxCount
      || (input.parameters.size !== undefined && !profile.allowedSizes?.includes(input.parameters.size))
      || (input.parameters.quality !== undefined && !profile.allowedQualities?.includes(input.parameters.quality))
      || (input.localAssetIds.length > 0 && !profile.capabilities.referenceImage)
      || (input.operation === 'edit' && input.localAssetIds.length === 0)
      || new Set(input.localAssetIds).size !== input.localAssetIds.length) throw new AppError('INVALID_ARGUMENT', {
        message: '图片参数不受当前配置支持，请查询 media_get_capabilities，按返回的操作、比例、尺寸、数量和质量选项重试；未提供质量选项时不要传 quality。这不是权限拒绝。',
      })
    // Resolve defaults once, before approval, quoting or persistence. Every entry
    // point (manual UI and Pi) freezes these same effective parameters.
    const realGateway = this.gateway().quoteRequiresUploadedReferences === true
    const pixelSizes = profile.allowedSizes?.filter(size => imageAspectRatio(size) !== undefined)
    const size = input.parameters.size ?? (profile.defaultSize && imageAspectRatio(profile.defaultSize) === input.parameters.aspectRatio ? profile.defaultSize
      : pixelSizes?.find(size => imageAspectRatio(size) === input.parameters.aspectRatio))
    if (pixelSizes?.length && !size) throw new AppError('INVALID_ARGUMENT', { message: '当前比例没有合法尺寸，请刷新模型规格。' })
    if (size && imageAspectRatio(size) !== undefined && imageAspectRatio(size) !== input.parameters.aspectRatio) {
      throw new AppError('INVALID_ARGUMENT', { message: '图片比例与尺寸不匹配。' })
    }
    const quality = input.parameters.quality ?? profile.defaultQuality
    input = { ...input, parameters: { ...input.parameters, ...(size ? { size } : {}), ...(quality ? { quality } : {}) } }
    if (realGateway) input = { ...input, parameters: { aspectRatio: input.parameters.aspectRatio, ...realMediaParameters(input.parameters) } }
    const gate = this.key(scope, taskId)
    if (this.submitting.has(gate)) throw new AppError('CONFLICT')
    if (this.activities.size >= 4) throw new AppError('RATE_LIMITED')
    this.submitting.add(gate)
    const controller = new AbortController(), parent = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    const jobId = randomUUID(), activityKey = this.key(scope, jobId)
    let job: LocalMediaJob | undefined
    let finish: () => void = () => undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
    let trackingStarted = false
    this.activities.set(activityKey, { taskId, controller, promise: pending })
    try {
      const gateway = this.gateway(), referenceHashes: string[] = [], referenceIds: string[] = []
      for (const id of input.localAssetIds) {
        const asset = await this.options.store.getAsset(scope, taskId, id)
        if (!asset || asset.taskId !== taskId) throw new AppError('NOT_FOUND')
        referenceHashes.push(asset.sha256)
      }
      const semantic = { profileId: profile.profileId, configVersion: profile.configVersion, operation: input.operation,
        referenceHashes, creativeBrief: input.creativeBrief, parameters: { aspectRatio: input.parameters.aspectRatio, count: input.parameters.count,
          ...(input.parameters.size ? { size: input.parameters.size } : {}), ...(input.parameters.quality ? { quality: input.parameters.quality } : {}) } }
      const requestHash = gateway.quoteRequiresUploadedReferences ? realMediaSemanticHash(semantic)
        : createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
      const automatic = binding.toolPolicy?.preset === 'full-local' && binding.toolPolicy.approvalMode === 'auto-approve'
      const uploadReferences = async () => {
        for (const id of input.localAssetIds) {
          const asset = await this.options.store.getAsset(scope, taskId, id)
          if (!asset) throw new AppError('NOT_FOUND')
          const bytes = await this.options.store.readAsset(scope, taskId, id)
          const uploaded = z.object({ referenceId: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive() }).strict()
            .parse(await this.network(scope, parent, s => gateway.uploadReference(binding.subscriptionId, { bytes, mime: asset.mime, sha256: asset.sha256 }, s)))
          if (uploaded.sha256 !== asset.sha256 || uploaded.expiresAt <= Date.now()) throw new AppError('INVALID_STATE')
          referenceIds.push(uploaded.referenceId)
        }
      }
      // SEP quotes bind uploaded references. Approve transmission before sending any image bytes.
      if (gateway.quoteRequiresUploadedReferences && input.localAssetIds.length) {
        if (!automatic) {
          const allowed = await this.network(scope, parent, () => binding.requestApproval({ taskId, runId: binding.runId, subscriptionId: binding.subscriptionId,
            toolName: 'media_generate_image', input: { operation: 'upload-references', referenceCount: input.localAssetIds.length,
              transmission: '参考图片将上传到 SEP 图片网关；尚未提交生成，报价后另行确认。' } }))
          if (!allowed) throw new AppError('PERMISSION_DENIED')
        }
        await uploadReferences()
      }
      const quoteRequest = { ...semantic, referenceIds, requestHash }
      const readQuote = async () => {
        const next = mediaQuoteSchema.parse(await this.network(scope, parent, s => gateway.quote(binding.subscriptionId, quoteRequest, s)))
        // Keep legacy quote fields readable; unknown prices cannot authorize generation.
        if (next.requestHash !== requestHash || !next.authorized || !next.budgetAuthorized
          || next.status !== 'quoted' || next.amount === null || !next.currency?.trim()) throw new AppError('PERMISSION_DENIED')
        return next
      }
      let quote = await readQuote()
      let approvalAccepted = automatic
      const approve = async () => {
        const allowed = await this.network(scope, parent, () => binding.requestApproval({ taskId, runId: binding.runId, subscriptionId: binding.subscriptionId,
          toolName: 'media_generate_image', input: { profile: profile.displayName, operation: input.operation, referenceCount: input.localAssetIds.length,
            transmission: '参考图片将上传到 SEP 图片网关', parameters: input.parameters, creativeBrief: input.creativeBrief,
            quote: { status: quote.status, amount: quote.amount, currency: quote.currency, expiresAt: quote.expiresAt } } }))
        if (!allowed) throw new AppError('PERMISSION_DENIED')
        approvalAccepted = true
      }
      if (!automatic) await approve()
      // Human approval can outlive a short quote. Re-quote at most once using the
      // same semantic hash; a price/currency change requires fresh approval.
      if (quote.expiresAt <= Date.now()) {
        const previous = quote
        quote = await readQuote()
        if (quote.amount !== previous.amount || quote.currency !== previous.currency) {
          approvalAccepted = automatic
          if (!automatic) await approve()
        }
      }
      if (!approvalAccepted || quote.expiresAt <= Date.now()) throw new AppError('PERMISSION_DENIED', { message: '报价授权已过期，请重新发起。' })
      if (!gateway.quoteRequiresUploadedReferences) await uploadReferences()
      const now = Date.now(), clientRequestId = randomUUID()
      job = { version: 1, owner: scope, jobId, taskId, runId: binding.runId, subscriptionId: binding.subscriptionId,
        clientRequestId, requestHash, input, profile, request: { ...semantic, referenceIds, requestHash, quoteId: quote.quoteId, clientRequestId },
        quote, approval: automatic ? 'automatic' : 'manual', receiptId: null, submission: 'NOT_SENT', generationStatus: 'SUBMITTING',
        trackingStatus: 'ACTIVE', saveStatus: 'PENDING', outputs: [], billingStatus: 'UNKNOWN', nextPollAt: now, attempts: 0, error: null, createdAt: now, updatedAt: now }
      this.assert(scope, epoch); parent.throwIfAborted()
      await this.options.store.saveJob(scope, job)
      await binding.onJobCreated?.({ kind: 'image', jobId, operation: input.operation, localAssetIds: input.localAssetIds })
      this.assert(scope, epoch); parent.throwIfAborted()
      if (quote.expiresAt <= Date.now()) throw new AppError('PERMISSION_DENIED')
      job = { ...job, submission: 'MAYBE_SENT' }
      await this.options.store.saveJob(scope, job)
      try {
        // SEP can spend up to 180s waiting on its upstream image provider. Keep this
        // phase separate from ordinary control-plane calls so a slow accepted submit
        // becomes an UNKNOWN request that is queried by its original id instead of
        // being mistaken for a local failure or retried with a new id.
        this.acceptReceipt(job, await this.network(scope, parent, s => gateway.submit(binding.subscriptionId, job!.request, s), this.options.submissionTimeoutMs ?? 190_000))
      } catch (error) {
        this.invalidateCapabilities(scope, taskId, epoch, error)
        job.generationStatus = 'SUBMISSION_UNKNOWN'
        job.error = '提交结果尚未确认，仅查询原请求，不会再次生成。'
      }
      // Persistence failure must not rewrite a confirmed receipt into an unknown submission.
      await this.options.store.saveJob(scope, job)
      this.assert(scope, epoch)
      const submitted = job
      // Once the submitted job is durable, model handoff cannot cancel host-owned saving.
      // Explicit task/session stops still abort the activity controller.
      const tracking = this.track(scope, submitted, controller.signal, epoch).finally(finish)
      this.activities.set(activityKey, { taskId, controller, promise: tracking })
      trackingStarted = true
      void tracking.finally(() => this.releaseActivity(activityKey, controller)).catch(() => undefined)
      const assets = await this.options.store.listAssets(scope, taskId)
      this.assert(scope, epoch)
      return this.viewJob(job, assets)
    } catch (error) {
      this.invalidateCapabilities(scope, taskId, epoch, error)
      if (trackingStarted) {
        controller.abort()
        await this.activities.get(activityKey)?.promise.catch(() => undefined)
      } else if (job) {
        job.trackingStatus = epoch !== this.epoch && parent.reason !== explicitStop ? 'INTERRUPTED' : 'STOPPED'
        if (job.submission === 'NOT_SENT') { job.generationStatus = 'FAILED'; job.error = '请求未提交。' }
        job.updatedAt = Date.now()
        try { await this.options.store.saveJob(scope, job) } catch {
          log.warn('media submission state could not be saved', { taskId, jobId })
        }
      }
      throw error
    } finally {
      if (!trackingStarted) { this.releaseActivity(activityKey, controller); finish() }
      this.submitting.delete(gate)
    }
  }
  private acceptReceipt(job: LocalMediaJob, raw: unknown): void {
    const receipt: MediaReceipt = mediaReceiptSchema.parse(raw)
    if (receipt.clientRequestId !== job.clientRequestId || receipt.profileId !== job.profile.profileId || receipt.configVersion !== job.profile.configVersion
      || (job.receiptId && job.receiptId !== receipt.receiptId) || new Set(receipt.outputs.map(output => output.outputId)).size !== receipt.outputs.length
      || receipt.outputs.length > job.input.parameters.count) throw new AppError('INVALID_ARGUMENT')
    job.receiptId = receipt.receiptId; job.submission = 'RECEIPTED'; job.generationStatus = receipt.status
    job.outputs = receipt.outputs; job.billingStatus = receipt.billingStatus
    job.recovery = receipt.recovery; job.errorCode = receipt.errorCode; job.outputErrors = receipt.outputErrors
    job.nextPollAt = Date.now() + Math.max(this.options.pollFloorMs ?? 1_000, receipt.pollAfterMs ?? 0)
    job.error = null; job.attempts = 0; job.updatedAt = Date.now()
    if (terminal.has(receipt.status) && job.providerWaitMs === undefined) job.providerWaitMs = Math.max(0, job.updatedAt - job.createdAt)
  }
  private async save(scope: TaskOwnerScope, job: LocalMediaJob, parent: AbortSignal): Promise<void> {
    if (!job.outputs.length || !job.receiptId) return
    const downloadStartedAt = Date.now()
    let downloaded = 0
    let failed = 0, expired = 0
    const initialAssets = await this.options.store.listAssets(scope, job.taskId)
    const missing = job.outputs.filter(output => !initialAssets.some(asset => asset.jobId === job.jobId && asset.outputId === output.outputId && asset.status === 'SAVED'))
    if (!missing.length) {
      if (job.saveStatus !== 'SAVED') { job.saveStatus = 'SAVED'; await this.options.store.saveJob(scope, job) }
      return
    }
    job.saveStatus = 'SAVING'; await this.options.store.saveJob(scope, job)
    for (const output of job.outputs) {
      const assets = await this.options.store.listAssets(scope, job.taskId)
      if (assets.some(asset => asset.jobId === job.jobId && asset.outputId === output.outputId && asset.status === 'SAVED')) continue
      if (output.expiresAt !== null && output.expiresAt <= Date.now()) { failed++; expired++; continue }
      if (job.recovery?.canDownload === false) { failed++; continue }
      try {
        await this.network(scope, parent, async signal => {
          const stream = await this.gateway().content(job.subscriptionId, job.receiptId!, output.outputId, signal)
          await this.options.store.saveOutput(scope, job.taskId, job.jobId, output, stream, signal)
        })
        downloaded++
      } catch (error) {
        if (parent.aborted) throw parent.reason
        if (error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')) throw error
        failed++
      }
    }
    job.saveStatus = failed ? 'SAVE_FAILED' : 'SAVED'
    job.error = !failed ? null : expired === failed ? '未保存的原结果已过期，无法再次下载；已保存的图片仍可使用。'
      : job.recovery?.canDownload === false ? '原结果当前不可下载，不会重新生成。' : '部分图片未保存，可以重试保存原结果。'
    if (downloaded > 0) job.downloadMs = (job.downloadMs ?? 0) + (Date.now() - downloadStartedAt)
    await this.options.store.saveJob(scope, job)
  }
  private async track(scope: TaskOwnerScope, job: LocalMediaJob, parent: AbortSignal, epoch = this.epoch): Promise<void> {
    const trackingStartedAt = Date.now()
    let polls = 0
    try {
      // Generation may finish before billing. Deliver its outputs before querying the original receipt further.
      if (terminal.has(job.generationStatus)) await this.save(scope, job, parent)
      while (!terminal.has(job.generationStatus) || this.needsBillingQuery(job)) {
        this.assert(scope, epoch); parent.throwIfAborted()
        if (job.receiptId && job.recovery?.canQuery === false) {
          job.trackingStatus = 'STOPPED'; job.error = '服务端无法继续查询原请求，不会再次生成。'; break
        }
        if (++polls > 500 || Date.now() - trackingStartedAt > 86_400_000) {
          job.trackingStatus = 'STOPPED'; job.error = '本轮跟踪已达时长或查询上限，可手动恢复原请求。'; break
        }
        if (job.submission === 'NOT_SENT') { job.trackingStatus = 'STOPPED'; job.error = '请求未提交，不会自动生成。'; break }
        if (!job.receiptId && !job.profile.capabilities.recoverByRequestId) {
          job.trackingStatus = 'STOPPED'; job.error = '该通道不支持按原请求找回，不能自动恢复。'; break
        }
        await delay(Math.max(0, job.nextPollAt - Date.now()), undefined, { signal: parent })
        try {
          job.lastQueriedAt = Date.now()
          await this.options.store.saveJob(scope, job)
          const receipt = await this.network(scope, parent, signal => job.receiptId
            ? this.gateway().getReceipt(job.subscriptionId, job.receiptId, signal)
            : this.gateway().findReceipt(job.subscriptionId, job.clientRequestId, signal))
          if (receipt === null) throw new AppError('NOT_FOUND')
          this.acceptReceipt(job, receipt)
          await this.options.store.saveJob(scope, job)
          await this.save(scope, job, parent)
        } catch (error) {
          if (parent.aborted) throw parent.reason
          if (error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')) {
            job.trackingStatus = 'AUTH_REQUIRED'; job.error = '请恢复图片任务的读取授权。'; break
          }
          job.attempts++; job.nextPollAt = Date.now() + Math.min(30_000, (this.options.pollFloorMs ?? 1_000) * 2 ** Math.min(job.attempts, 5))
          if (job.attempts >= (this.options.maxAttempts ?? 8)) {
            const transport = transportKind(error)
            job.trackingStatus = 'STOPPED'
            job.error = transport === 'timeout' ? 'NETWORK_TIMEOUT' : transport === 'network' ? 'NETWORK_ERROR'
              : error instanceof AppError && error.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : '查询重试已达上限，可继续跟踪原请求。'
            break
          }
          await this.options.store.saveJob(scope, job)
        }
      }
      if (terminal.has(job.generationStatus) && !this.needsBillingQuery(job) && job.trackingStatus === 'ACTIVE') {
        job.trackingStatus = 'STOPPED'
      }
    } catch (error) {
      const interrupted = epoch !== this.epoch && parent.reason !== explicitStop
      const authRequired = !interrupted && parent.reason !== explicitStop && error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')
      job.trackingStatus = authRequired ? 'AUTH_REQUIRED' : interrupted ? 'INTERRUPTED' : 'STOPPED'
      if (job.saveStatus === 'SAVING') job.saveStatus = 'SAVE_FAILED'
      job.error = authRequired ? '请恢复图片任务的读取授权。' : parent.aborted ? '本地跟踪已停止，上游任务可能仍在执行。' : '本地跟踪暂不可用，可恢复原请求。'
      if (!parent.aborted) log.warn('media tracking interrupted', { taskId: job.taskId, jobId: job.jobId, authChanged: error instanceof AppError && error.code === 'AUTH_REQUIRED' })
    } finally {
      job.updatedAt = Date.now()
      await this.options.store.saveJob(scope, job)
    }
  }
  private async job(taskId: string, jobId: string) {
    const epoch = this.epoch
    mediaId.parse(jobId)
    const { scope } = await this.task(taskId)
    const job = await this.options.store.getJob(scope, taskId, jobId)
    if (!job) throw new AppError('NOT_FOUND')
    this.assert(scope, epoch)
    return { scope, job }
  }
  private async getJobView(taskId: string, jobId: string): Promise<MediaJobView> {
    const { scope, job } = await this.job(taskId, jobId)
    return this.viewJob(job, await this.options.store.listAssets(scope, taskId))
  }
  async resume(taskId: string, jobId: string): Promise<void> {
    mediaId.parse(taskId); mediaId.parse(jobId)
    const epoch = this.epoch, scope = this.scope(), key = this.key(scope, jobId)
    const taskKey = this.key(scope, taskId), stopVersion = this.taskStops.get(taskKey) ?? 0
    if (this.activities.has(key)) return
    if (this.activities.size >= 4) throw new AppError('RATE_LIMITED')
    const controller = new AbortController()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    this.activities.set(key, { taskId, controller, promise: pending })
    let trackingStarted = false
    try {
      const { job } = await this.job(taskId, jobId)
      if (controller.signal.aborted || stopVersion !== (this.taskStops.get(taskKey) ?? 0)) {
        job.trackingStatus = epoch !== this.epoch && controller.signal.reason !== explicitStop ? 'INTERRUPTED' : 'STOPPED'
        job.updatedAt = Date.now()
        await this.options.store.saveJob(scope, job)
        return
      }
      this.assert(scope, epoch)
      job.trackingStatus = 'ACTIVE'; job.attempts = 0; job.nextPollAt = Date.now()
      await this.options.store.saveJob(scope, job)
      const promise = this.track(scope, job, controller.signal, epoch).finally(finish)
      this.activities.set(key, { taskId, controller, promise })
      trackingStarted = true
      void promise.finally(() => this.releaseActivity(key, controller)).catch(() => undefined)
    } catch (error) {
      if (controller.signal.aborted) {
        // Settle only the captured owner's local record, even after its session has ended.
        const job = await this.options.store.getJob(scope, taskId, jobId)
        if (job) {
          job.trackingStatus = controller.signal.reason === explicitStop ? 'STOPPED' : 'INTERRUPTED'
          job.updatedAt = Date.now()
          await this.options.store.saveJob(scope, job)
        }
      }
      throw error
    } finally {
      if (!trackingStarted) { this.releaseActivity(key, controller); finish() }
    }
  }
  async retrySave(taskId: string, jobId: string): Promise<void> { await this.resume(taskId, jobId) }
  async redo(taskId: string, jobId: string): Promise<MediaJobView> {
    const { job } = await this.job(taskId, jobId)
    if (!terminal.has(job.generationStatus)) throw new AppError('INVALID_STATE', { message: '原请求尚未结束或提交状态不明，不能重做。' })
    return this.generateTaskMedia(taskId, job.input)
  }
  async cancel(taskId: string, jobId: string, cancelUpstream: boolean, binding?: { toolPolicy?: TaskToolPolicy; requestApproval: Approval }, signal?: AbortSignal): Promise<void> {
    const epoch = this.epoch, parent = signal ?? new AbortController().signal
    parent.throwIfAborted()
    const { scope, job: initial } = await this.job(taskId, jobId), key = this.key(scope, jobId)
    const check = () => { this.assert(scope, epoch); parent.throwIfAborted() }
    check()
    if (cancelUpstream) {
      if (!initial.receiptId || !initial.profile.capabilities.cancel || initial.recovery?.canCancel === false || terminal.has(initial.generationStatus)) throw new AppError('INVALID_STATE')
      const policy = binding ? binding.toolPolicy : await this.options.policy?.(taskId)
      check()
      if (policy && (policy.preset === 'read-only' || (policy.preset !== 'full-local' && !policy.allowedTools.includes('media_cancel_job')))) throw new AppError('PERMISSION_DENIED')
      if (!(policy?.preset === 'full-local' && policy.approvalMode === 'auto-approve')) {
        const approved = await this.network(scope, parent, () => (binding?.requestApproval ?? this.options.requestApproval)({
          taskId, runId: initial.runId, subscriptionId: initial.subscriptionId, toolName: 'media_cancel_job',
          input: { jobId, cancelUpstream: true, billing: '取消不代表退款，上游可能已产生费用。' },
        }))
        check()
        if (!approved) throw new AppError('PERMISSION_DENIED')
      }
    }
    const activity = this.activities.get(key)
    this.jobStops.set(key, (this.jobStops.get(key) ?? 0) + 1)
    this.recoveryQueue.delete(key)
    activity?.controller.abort(explicitStop)
    let settlementError: unknown
    try { await activity?.promise } catch (error) { settlementError = error }
    check()
    const { job } = await this.job(taskId, jobId)
    check()
    if (cancelUpstream) {
      if (!job.receiptId || !job.profile.capabilities.cancel || job.recovery?.canCancel === false || terminal.has(job.generationStatus)) throw new AppError('INVALID_STATE')
      this.acceptReceipt(job, await this.network(scope, parent, signal => this.gateway().cancel(job.subscriptionId, job.receiptId!, signal)))
    }
    check()
    job.trackingStatus = 'STOPPED'; job.updatedAt = Date.now()
    await this.options.store.saveJob(scope, job)
    check()
    if (settlementError) throw settlementError
  }
  async waitForRun(taskId: string, runId: string): Promise<void> {
    const { scope } = await this.task(taskId)
    const isDelivered = (job: LocalMediaJob): boolean =>
      (job.generationStatus === 'SUCCEEDED' || job.generationStatus === 'PARTIAL_SUCCEEDED') && job.saveStatus === 'SAVED'
    for (;;) {
      const recoveredIds = this.runRecoveries.get(this.key(scope, taskId) + ':' + runId) ?? []
      const recoveredSet = new Set(recoveredIds)
      const jobs = (await this.options.store.listJobs(scope, taskId)).filter(job => job.runId === runId || recoveredSet.has(job.jobId))
      // Runs without image work are valid (for example, video-only runs).
      if (jobs.length === 0) return
      const pending = jobs.filter(job => !isDelivered(job))
      if (!pending.length) return
      if (pending.some(job => ['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(job.generationStatus))) {
        throw new AppError('INVALID_STATE', { message: '图片尚未完整交付，请查看图片任务状态。' })
      }
      const activity = pending.map(job => this.activities.get(this.key(scope, job.jobId))?.promise).find(Boolean)
      if (activity) {
        // A tracker owns provider polling. Waiting here only blocks until generation
        // and local materialization are ready; billing reconciliation may continue.
        await Promise.race([activity, delay(100)])
        continue
      }
      if (pending.some(job => job.saveStatus === 'SAVE_FAILED')) {
        throw new AppError('INVALID_STATE', { message: '图片尚未完整交付，请查看图片任务状态。' })
      }
      throw new AppError('INVALID_STATE', { message: '图片任务未在本地跟踪，请恢复原请求。' })
    }
  }
  async stopTask(taskId: string): Promise<void> {
    mediaId.parse(taskId)
    const scope = this.options.scope.currentScope()
    if (scope) {
      const key = this.key(scope, taskId)
      this.taskStops.set(key, (this.taskStops.get(key) ?? 0) + 1)
    }
    const queued: string[] = []
    for (const key of this.runRecoveries.keys()) if (key.startsWith(`${scope ? this.key(scope, taskId) : ''}:`)) this.runRecoveries.delete(key)
    for (const [key, job] of this.recoveryQueue) if (job.taskId === taskId) { this.recoveryQueue.delete(key); queued.push(job.jobId) }
    const matches = [...this.activities.values()].filter(activity => activity.taskId === taskId)
    for (const activity of matches) activity.controller.abort(explicitStop)
    await Promise.allSettled(matches.map(activity => activity.promise))
    // An accepted local stop remains valid for this captured owner during logout.
    if (scope) for (const jobId of queued) {
      const job = await this.options.store.getJob(scope, taskId, jobId)
      if (job && (job.trackingStatus === 'ACTIVE' || job.trackingStatus === 'INTERRUPTED')) {
        job.trackingStatus = 'STOPPED'; job.updatedAt = Date.now(); await this.options.store.saveJob(scope, job)
      }
    }
  }
  async stopAll(): Promise<void> {
    this.epoch++; this.caps.clear(); this.capabilityLoads.clear(); this.selectedReferences.clear(); this.taskStops.clear(); this.jobStops.clear(); this.runRecoveries.clear()
    this.recoveryQueue.clear()
    this.sessionController.abort()
    this.sessionController = new AbortController()
    const activities = [...this.activities.values()]
    for (const activity of activities) activity.controller.abort()
    await Promise.allSettled(activities.map(activity => activity.promise))
  }
  async resumePending(): Promise<void> {
    if (!this.options.gateway) return
    const scope = this.scope(), epoch = this.epoch
    const stops = new Map(this.taskStops)
    const jobStops = new Map(this.jobStops)
    for (const job of await this.options.store.listJobs(scope)) {
      this.assert(scope, epoch)
      const key = this.key(scope, job.jobId)
      const taskKey = this.key(scope, job.taskId)
      if (jobStops.get(key) !== this.jobStops.get(key)) continue
      if (stops.get(taskKey) !== this.taskStops.get(taskKey)) {
        const current = await this.options.store.getJob(scope, job.taskId, job.jobId)
        this.assert(scope, epoch)
        if (current && (current.trackingStatus === 'ACTIVE' || current.trackingStatus === 'INTERRUPTED')) {
          current.trackingStatus = 'STOPPED'; current.updatedAt = Date.now(); await this.options.store.saveJob(scope, current)
        }
        continue
      }
      if ((job.trackingStatus === 'ACTIVE' || job.trackingStatus === 'INTERRUPTED') && !this.activities.has(key)) this.recoveryQueue.set(key, { taskId: job.taskId, jobId: job.jobId })
    }
    await this.drainRecoveryQueue()
  }
  private releaseActivity(key: string, controller: AbortController): void {
    if (this.activities.get(key)?.controller !== controller) return
    this.activities.delete(key)
    void this.drainRecoveryQueue()
  }
  private async drainRecoveryQueue(): Promise<void> {
    if (this.recoveryDraining || !this.recoveryQueue.size) return
    this.recoveryDraining = true
    const epoch = this.epoch
    try {
      while (epoch === this.epoch && this.recoveryQueue.size && this.activities.size < 4) {
        const [key, job] = this.recoveryQueue.entries().next().value!
        this.recoveryQueue.delete(key)
        try { await this.resume(job.taskId, job.jobId) } catch (error) {
          if (epoch !== this.epoch) return
          if (error instanceof AppError && error.code === 'RATE_LIMITED') { this.recoveryQueue.set(key, job); break }
          log.warn('media recovery unavailable', { taskId: job.taskId, jobId: job.jobId, errorType: error instanceof Error ? error.name : 'unknown' })
        }
      }
    } finally {
      this.recoveryDraining = false
      if (epoch !== this.epoch && this.recoveryQueue.size) void this.drainRecoveryQueue()
    }
  }
  async archiveIfMedia(taskId: string): Promise<boolean> {
    mediaId.parse(taskId)
    const scope = this.scope(), epoch = this.epoch
    if (!await this.options.getTask(taskId)) throw new AppError('NOT_FOUND')
    this.assert(scope, epoch)
    const [jobs, assets] = await Promise.all([this.options.store.listJobs(scope, taskId), this.options.store.listAssets(scope, taskId)])
    this.assert(scope, epoch)
    if (!jobs.length && !assets.length) return false
    await this.options.store.archive(scope, taskId)
    this.assert(scope, epoch)
    return true
  }
  async isArchived(taskId: string): Promise<boolean> {
    return this.options.store.isArchived(this.scope(), taskId)
  }
}
