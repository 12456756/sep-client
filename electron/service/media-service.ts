import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { MediaAssetView, MediaJobView, MediaTaskView } from '../../src/shared/media'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { TaskOwnerScope } from '../data/scope-path'
import type { LocalMediaJob, MediaCapabilities, MediaGatewayPort, MediaGenerationInput, MediaReceipt, MediaStorePort } from '../domain/media'
import type { MediaHostTools } from '../domain/media-tools'
import type { EmployeeRuntimeConfig, TaskToolPolicy } from '../runtime/run-types'
import { mediaId, mediaQuoteSchema, mediaReceiptSchema, parseMediaCapabilities, parseMediaInput } from '../common/platform/media-contract'
import { logger } from '../common/logger'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

const log = logger.child('media-service')
const terminal = new Set(['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'])
type Approval = (input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => Promise<boolean>
interface TaskBinding { subscriptionId?: string | null }
export interface MediaServiceOptions {
  scope: ScopeSource
  store: MediaStorePort
  gateway?: MediaGatewayPort
  getTask: (taskId: string) => Promise<TaskBinding | null>
  authorize: (subscriptionId: string) => Promise<EmployeeRuntimeConfig | null>
  requestApproval: Approval
  policy?: (taskId: string) => Promise<TaskToolPolicy | undefined>
  capabilities?: (employee: EmployeeRuntimeConfig) => unknown
  pollFloorMs?: number
  maxAttempts?: number
  operationTimeoutMs?: number
}
interface RunInput {
  taskId: string; runId: string; subscriptionId: string; employee: EmployeeRuntimeConfig
  toolPolicy?: TaskToolPolicy; requestApproval: Approval
}
interface Activity { taskId: string; controller: AbortController; promise: Promise<void> }

/** Host-owned execution. No provider payloads, filesystem paths or prices come from the model. */
export class MediaService {
  private epoch = 0
  private sessionController = new AbortController()
  private readonly activities = new Map<string, Activity>()
  private readonly caps = new Map<string, MediaCapabilities | null>()
  private readonly submitting = new Set<string>()
  private readonly recoveryQueue = new Map<string, { taskId: string; jobId: string }>()
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
  private capabilities(employee: EmployeeRuntimeConfig): MediaCapabilities | null {
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
  private async network<T>(scope: TaskOwnerScope, parent: AbortSignal, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const epoch = this.epoch
    this.assert(scope, epoch)
    const signal = AbortSignal.any([parent, this.sessionController.signal, AbortSignal.timeout(this.options.operationTimeoutMs ?? 60_000)])
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
  private viewJob(job: LocalMediaJob, assets: MediaAssetView[]): MediaJobView {
    return { jobId: job.jobId, taskId: job.taskId, runId: job.runId, profileId: job.profile.profileId,
      operation: job.input.operation, parameters: { ...job.input.parameters }, generationStatus: job.generationStatus,
      trackingStatus: job.trackingStatus, saveStatus: job.saveStatus, billingStatus: job.billingStatus,
      error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
      assets: assets.filter(asset => asset.jobId === job.jobId).map(asset => this.viewAsset(asset)),
      canCancelUpstream: job.profile.capabilities.cancel && !!job.receiptId && !terminal.has(job.generationStatus) }
  }
  async getTaskMedia(taskId: string): Promise<MediaTaskView> {
    const { scope, subscriptionId } = await this.task(taskId), epoch = this.epoch
    const key = this.key(scope, taskId)
    if (!this.caps.has(key)) {
      let employee: EmployeeRuntimeConfig | null = null
      try { if (this.options.gateway) employee = await this.options.authorize(subscriptionId) } catch { /* Historical local reads do not require a new generation grant. */ }
      this.assert(scope, epoch)
      this.caps.set(key, employee ? this.capabilities(employee) : null)
    }
    const [assets, jobs, archived] = await Promise.all([this.options.store.listAssets(scope, taskId), this.options.store.listJobs(scope, taskId), this.options.store.isArchived(scope, taskId)])
    this.assert(scope, epoch)
    const capabilities = this.caps.get(key) ?? null
    return { capabilities, unavailableReason: capabilities ? null : '当前员工未提供可用的图片能力，普通对话不受影响。',
      assets: assets.map(asset => this.viewAsset(asset)), jobs: jobs.map(job => this.viewJob(job, assets)), archived }
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
    this.caps.set(this.key(scope, input.taskId), capabilities)
    await this.options.store.saveSnapshot(scope, { version: 1, owner: scope, taskId: input.taskId, runId: input.runId,
      subscriptionId: input.subscriptionId, systemPrompt: input.employee.systemPrompt ?? '',
      skills: input.employee.runtimeSnapshot?.skills.map(skill => ({ path: skill.path, sha256: skill.sha256, version: skill.version })) ?? [],
      capabilities, runtimeSnapshot: input.employee.runtimeSnapshot, createdAt: Date.now() })
    this.assert(scope, epoch)
    if (!capabilities) return undefined
    return { names: capabilities.tools, execute: async (name, raw, signal) => {
      this.assert(scope, epoch)
      if (!capabilities.tools.includes(name)) throw new AppError('PERMISSION_DENIED')
      if (name === 'media_get_capabilities') {
        z.object({}).strict().parse(raw)
        const referenceAssets = (await this.options.store.listAssets(scope, input.taskId)).map(asset => this.viewAsset(asset))
        this.assert(scope, epoch)
        return { capabilities, referenceAssets }
      }
      if (name === 'media_generate_image') return this.generate(input.taskId, parseMediaInput(raw), { ...input, capabilities }, signal)
      const args = z.object({ jobId: mediaId, cancelUpstream: z.boolean().optional() }).strict().parse(raw)
      if (name === 'media_cancel_job') await this.cancel(input.taskId, args.jobId, args.cancelUpstream ?? false, input)
      return this.getJobView(input.taskId, args.jobId)
    } }
  }
  async generateTaskMedia(taskId: string, raw: MediaGenerationInput): Promise<MediaJobView> {
    const { scope, subscriptionId } = await this.task(taskId), epoch = this.epoch
    const employee = await this.options.authorize(subscriptionId)
    this.assert(scope, epoch)
    if (!employee) throw new AppError('EMPLOYEE_UNAVAILABLE')
    const capabilities = this.capabilities(employee)
    if (!capabilities) throw new AppError('SERVICE_UNAVAILABLE')
    const runId = randomUUID(), toolPolicy = await this.options.policy?.(taskId)
    this.assert(scope, epoch)
    await this.prepareRun({ taskId, runId, subscriptionId, employee, toolPolicy, requestApproval: this.options.requestApproval })
    return this.generate(taskId, parseMediaInput(raw), { runId, subscriptionId, toolPolicy, capabilities, requestApproval: this.options.requestApproval })
  }
  private async generate(taskId: string, input: MediaGenerationInput, binding: { runId: string; subscriptionId: string; toolPolicy?: TaskToolPolicy; capabilities: MediaCapabilities; requestApproval: Approval }, signal?: AbortSignal): Promise<MediaJobView> {
    const { scope } = await this.task(taskId), epoch = this.epoch
    if (await this.options.store.isArchived(scope, taskId)) throw new AppError('INVALID_STATE')
    if (binding.toolPolicy && (binding.toolPolicy.preset === 'read-only' || (binding.toolPolicy.preset !== 'full-local' && !binding.toolPolicy.allowedTools.includes('media_generate_image')))) throw new AppError('PERMISSION_DENIED')
    const profile = binding.capabilities.profiles.find(profile => profile.profileId === input.profileId)
    if (!binding.capabilities.tools.includes('media_generate_image') || !profile || !profile.operations.includes(input.operation)
      || !profile.allowedAspectRatios.includes(input.parameters.aspectRatio) || input.parameters.count > profile.maxCount
      || (input.parameters.size !== undefined && !profile.allowedSizes?.includes(input.parameters.size))
      || (input.parameters.quality !== undefined && !profile.allowedQualities?.includes(input.parameters.quality))
      || (input.localAssetIds.length > 0 && !profile.capabilities.referenceImage)
      || (input.operation === 'edit' && input.localAssetIds.length === 0)
      || new Set(input.localAssetIds).size !== input.localAssetIds.length) throw new AppError('INVALID_ARGUMENT')
    const gate = this.key(scope, taskId)
    if (this.submitting.has(gate)) throw new AppError('CONFLICT')
    if (this.activities.size >= 4) throw new AppError('RATE_LIMITED')
    this.submitting.add(gate)
    const controller = new AbortController(), parent = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    const jobId = randomUUID(), activityKey = this.key(scope, jobId)
    let job: LocalMediaJob | undefined
    let finish: () => void = () => undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
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
      const requestHash = createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
      // Quote before transfer: manual approval describes both the upload and its possible charge.
      const quote = mediaQuoteSchema.parse(await this.network(scope, parent, s => gateway.quote(binding.subscriptionId, { ...semantic, referenceIds: [], requestHash }, s)))
      if (quote.requestHash !== requestHash || quote.expiresAt <= Date.now() || !quote.authorized || !quote.budgetAuthorized
        || (quote.status === 'unavailable' && !quote.allowUnknownCost)) throw new AppError('PERMISSION_DENIED')
      const automatic = binding.toolPolicy?.preset === 'full-local' && binding.toolPolicy.approvalMode === 'auto-approve'
      if (!automatic) {
        const allowed = await this.network(scope, parent, () => binding.requestApproval({ taskId, runId: binding.runId, subscriptionId: binding.subscriptionId,
          toolName: 'media_generate_image', input: { profile: profile.displayName, operation: input.operation, referenceCount: input.localAssetIds.length,
            transmission: '参考图片将上传到 SEP 图片网关', parameters: input.parameters, creativeBrief: input.creativeBrief,
            quote: { status: quote.status, amount: quote.amount, currency: quote.currency, expiresAt: quote.expiresAt } } }))
        if (!allowed) throw new AppError('PERMISSION_DENIED')
      }
      if (quote.expiresAt <= Date.now()) throw new AppError('PERMISSION_DENIED', { message: '报价授权已过期，请重新发起。' })
      for (const id of input.localAssetIds) {
        const asset = await this.options.store.getAsset(scope, taskId, id)
        if (!asset) throw new AppError('NOT_FOUND')
        const bytes = await this.options.store.readAsset(scope, taskId, id)
        const uploaded = z.object({ referenceId: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive() }).strict()
          .parse(await this.network(scope, parent, s => gateway.uploadReference(binding.subscriptionId, { bytes, mime: asset.mime, sha256: asset.sha256 }, s)))
        if (uploaded.sha256 !== asset.sha256 || uploaded.expiresAt <= Date.now()) throw new AppError('INVALID_STATE')
        referenceIds.push(uploaded.referenceId)
      }
      const now = Date.now(), clientRequestId = randomUUID()
      job = { version: 1, owner: scope, jobId, taskId, runId: binding.runId, subscriptionId: binding.subscriptionId,
        clientRequestId, requestHash, input, profile, request: { ...semantic, referenceIds, requestHash, quoteId: quote.quoteId, clientRequestId },
        quote, approval: automatic ? 'automatic' : 'manual', receiptId: null, submission: 'NOT_SENT', generationStatus: 'SUBMITTING',
        trackingStatus: 'ACTIVE', saveStatus: 'PENDING', outputs: [], billingStatus: 'UNKNOWN', nextPollAt: now, attempts: 0, error: null, createdAt: now, updatedAt: now }
      this.assert(scope, epoch); parent.throwIfAborted()
      await this.options.store.saveJob(scope, job)
      if (quote.expiresAt <= Date.now()) throw new AppError('PERMISSION_DENIED')
      job = { ...job, submission: 'MAYBE_SENT' }
      await this.options.store.saveJob(scope, job)
      try {
        this.acceptReceipt(job, await this.network(scope, parent, s => gateway.submit(binding.subscriptionId, job!.request, s)))
      } catch {
        job.generationStatus = 'SUBMISSION_UNKNOWN'
        job.error = '提交结果尚未确认，仅查询原请求，不会再次生成。'
      }
      // Persistence failure must not rewrite a confirmed receipt into an unknown submission.
      await this.options.store.saveJob(scope, job)
      this.assert(scope, epoch)
      const submitted = job
      const tracking = this.track(scope, submitted, parent).finally(finish)
      this.activities.set(activityKey, { taskId, controller, promise: tracking })
      void tracking.finally(() => this.releaseActivity(activityKey, controller)).catch(() => undefined)
      const assets = await this.options.store.listAssets(scope, taskId)
      this.assert(scope, epoch)
      return this.viewJob(job, assets)
    } catch (error) {
      if (job && job.submission === 'NOT_SENT') { job.trackingStatus = 'STOPPED'; job.generationStatus = 'FAILED'; job.error = '请求未提交。'; await this.options.store.saveJob(scope, job) }
      if (job && job.submission !== 'NOT_SENT') {
        job.trackingStatus = epoch !== this.epoch ? 'INTERRUPTED' : 'STOPPED'
        job.updatedAt = Date.now()
        await this.options.store.saveJob(scope, job)
      }
      this.releaseActivity(activityKey, controller); finish()
      throw error
    } finally { this.submitting.delete(gate) }
  }
  private acceptReceipt(job: LocalMediaJob, raw: unknown): void {
    const receipt: MediaReceipt = mediaReceiptSchema.parse(raw)
    if (receipt.clientRequestId !== job.clientRequestId || receipt.profileId !== job.profile.profileId || receipt.configVersion !== job.profile.configVersion
      || (job.receiptId && job.receiptId !== receipt.receiptId) || new Set(receipt.outputs.map(output => output.outputId)).size !== receipt.outputs.length
      || receipt.outputs.length > job.input.parameters.count) throw new AppError('INVALID_ARGUMENT')
    job.receiptId = receipt.receiptId; job.submission = 'RECEIPTED'; job.generationStatus = receipt.status
    job.outputs = receipt.outputs; job.billingStatus = receipt.billingStatus
    job.nextPollAt = Date.now() + Math.max(this.options.pollFloorMs ?? 1_000, receipt.pollAfterMs)
    job.error = null; job.attempts = 0; job.updatedAt = Date.now()
  }
  private async save(scope: TaskOwnerScope, job: LocalMediaJob, parent: AbortSignal): Promise<void> {
    if (!job.outputs.length || !job.receiptId) return
    job.saveStatus = 'SAVING'; await this.options.store.saveJob(scope, job)
    let failed = 0
    for (const output of job.outputs) {
      const assets = await this.options.store.listAssets(scope, job.taskId)
      if (assets.some(asset => asset.jobId === job.jobId && asset.outputId === output.outputId && asset.status === 'SAVED')) continue
      if (output.expiresAt !== null && output.expiresAt <= Date.now()) { failed++; continue }
      try {
        await this.network(scope, parent, async signal => {
          const stream = await this.gateway().content(job.subscriptionId, job.receiptId!, output.outputId, signal)
          await this.options.store.saveOutput(scope, job.taskId, job.jobId, output, stream, signal)
        })
      } catch { if (parent.aborted) throw parent.reason; failed++ }
    }
    job.saveStatus = failed ? 'SAVE_FAILED' : 'SAVED'
    job.error = failed ? '部分图片未保存，可以重试保存原结果。' : null
    await this.options.store.saveJob(scope, job)
  }
  private async track(scope: TaskOwnerScope, job: LocalMediaJob, parent: AbortSignal): Promise<void> {
    const epoch = this.epoch
    const trackingStartedAt = Date.now()
    let polls = 0
    try {
      while (!terminal.has(job.generationStatus)) {
        this.assert(scope, epoch); parent.throwIfAborted()
        if (++polls > 500 || Date.now() - trackingStartedAt > 86_400_000) {
          job.trackingStatus = 'STOPPED'; job.error = '本轮跟踪已达时长或查询上限，可手动恢复原请求。'; break
        }
        if (job.submission === 'NOT_SENT') { job.trackingStatus = 'STOPPED'; job.error = '请求未提交，不会自动生成。'; break }
        if (!job.receiptId && !job.profile.capabilities.recoverByRequestId) {
          job.trackingStatus = 'STOPPED'; job.error = '该通道不支持按原请求找回，不能自动恢复。'; break
        }
        await delay(Math.max(0, job.nextPollAt - Date.now()), undefined, { signal: parent })
        try {
          const receipt = await this.network(scope, parent, signal => job.receiptId
            ? this.gateway().getReceipt(job.subscriptionId, job.receiptId, signal)
            : this.gateway().findReceipt(job.subscriptionId, job.clientRequestId, signal))
          if (receipt === null) throw new AppError('NOT_FOUND')
          this.acceptReceipt(job, receipt)
          await this.options.store.saveJob(scope, job)
          if (!terminal.has(job.generationStatus)) await this.save(scope, job, parent)
        } catch (error) {
          if (parent.aborted) throw parent.reason
          if (error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')) {
            job.trackingStatus = 'AUTH_REQUIRED'; job.error = '请恢复图片任务的读取授权。'; break
          }
          job.attempts++; job.nextPollAt = Date.now() + Math.min(30_000, (this.options.pollFloorMs ?? 1_000) * 2 ** Math.min(job.attempts, 5))
          if (job.attempts >= (this.options.maxAttempts ?? 8)) { job.trackingStatus = 'STOPPED'; job.error = '查询重试已达上限，可继续跟踪原请求。'; break }
          await this.options.store.saveJob(scope, job)
        }
      }
      if (terminal.has(job.generationStatus)) {
        await this.save(scope, job, parent)
        job.trackingStatus = 'STOPPED'
      }
    } catch (error) {
      job.trackingStatus = epoch !== this.epoch ? 'INTERRUPTED' : 'STOPPED'
      if (job.saveStatus === 'SAVING') job.saveStatus = 'SAVE_FAILED'
      job.error = parent.aborted ? '本地跟踪已停止，上游任务可能仍在执行。' : '本地跟踪暂不可用，可恢复原请求。'
      if (!parent.aborted) log.warn('media tracking interrupted', { taskId: job.taskId, jobId: job.jobId, authChanged: error instanceof AppError && error.code === 'AUTH_REQUIRED' })
    } finally {
      job.updatedAt = Date.now()
      await this.options.store.saveJob(scope, job)
    }
  }
  private async job(taskId: string, jobId: string) {
    mediaId.parse(jobId)
    const { scope } = await this.task(taskId)
    const job = await this.options.store.getJob(scope, taskId, jobId)
    if (!job) throw new AppError('NOT_FOUND')
    this.assert(scope)
    return { scope, job }
  }
  private async getJobView(taskId: string, jobId: string): Promise<MediaJobView> {
    const { scope, job } = await this.job(taskId, jobId)
    return this.viewJob(job, await this.options.store.listAssets(scope, taskId))
  }
  async resume(taskId: string, jobId: string): Promise<void> {
    const epoch = this.epoch
    const { scope, job } = await this.job(taskId, jobId), key = this.key(scope, jobId)
    this.assert(scope, epoch)
    if (this.activities.has(key)) return
    if (this.activities.size >= 4) throw new AppError('RATE_LIMITED')
    const controller = new AbortController()
    const promise = (async () => {
      job.trackingStatus = 'ACTIVE'; job.attempts = 0; job.nextPollAt = Date.now()
      await this.options.store.saveJob(scope, job)
      this.assert(scope, epoch); controller.signal.throwIfAborted()
      await this.track(scope, job, controller.signal)
    })()
    this.activities.set(key, { taskId, controller, promise })
    void promise.finally(() => this.releaseActivity(key, controller)).catch(() => undefined)
  }
  async retrySave(taskId: string, jobId: string): Promise<void> { await this.resume(taskId, jobId) }
  async redo(taskId: string, jobId: string): Promise<MediaJobView> {
    const { job } = await this.job(taskId, jobId)
    if (!terminal.has(job.generationStatus)) throw new AppError('INVALID_STATE', { message: '原请求尚未结束或提交状态不明，不能重做。' })
    return this.generateTaskMedia(taskId, job.input)
  }
  async cancel(taskId: string, jobId: string, cancelUpstream: boolean, binding?: { toolPolicy?: TaskToolPolicy; requestApproval: Approval }): Promise<void> {
    const { scope, job: initial } = await this.job(taskId, jobId), key = this.key(scope, jobId)
    if (cancelUpstream) {
      if (!initial.receiptId || !initial.profile.capabilities.cancel || terminal.has(initial.generationStatus)) throw new AppError('INVALID_STATE')
      const policy = binding ? binding.toolPolicy : await this.options.policy?.(taskId)
      if (policy && (policy.preset === 'read-only' || (policy.preset !== 'full-local' && !policy.allowedTools.includes('media_cancel_job')))) throw new AppError('PERMISSION_DENIED')
      if (!(policy?.preset === 'full-local' && policy.approvalMode === 'auto-approve')) {
        const approved = await this.network(scope, new AbortController().signal, () => (binding?.requestApproval ?? this.options.requestApproval)({
          taskId, runId: initial.runId, subscriptionId: initial.subscriptionId, toolName: 'media_cancel_job',
          input: { jobId, cancelUpstream: true, billing: '取消不代表退款，上游可能已产生费用。' },
        }))
        if (!approved) throw new AppError('PERMISSION_DENIED')
      }
    }
    const activity = this.activities.get(key)
    this.recoveryQueue.delete(key)
    activity?.controller.abort(); await activity?.promise
    const { job } = await this.job(taskId, jobId)
    if (cancelUpstream) {
      if (!job.receiptId || !job.profile.capabilities.cancel || terminal.has(job.generationStatus)) throw new AppError('INVALID_STATE')
      this.acceptReceipt(job, await this.network(scope, new AbortController().signal, signal => this.gateway().cancel(job.subscriptionId, job.receiptId!, signal)))
    }
    job.trackingStatus = 'STOPPED'; job.updatedAt = Date.now()
    await this.options.store.saveJob(scope, job)
  }
  async waitForRun(taskId: string, runId: string): Promise<void> {
    const { scope } = await this.task(taskId)
    const jobs = (await this.options.store.listJobs(scope, taskId)).filter(job => job.runId === runId)
    for (const job of jobs) await this.activities.get(this.key(scope, job.jobId))?.promise
    const settled = (await this.options.store.listJobs(scope, taskId)).filter(job => job.runId === runId)
    if (settled.some(job => (job.generationStatus !== 'SUCCEEDED' && job.generationStatus !== 'PARTIAL_SUCCEEDED') || job.saveStatus !== 'SAVED')) {
      throw new AppError('INVALID_STATE', { message: '图片尚未完整交付，请查看图片任务状态。' })
    }
  }
  async stopTask(taskId: string): Promise<void> {
    for (const [key, job] of this.recoveryQueue) if (job.taskId === taskId) this.recoveryQueue.delete(key)
    const matches = [...this.activities.values()].filter(activity => activity.taskId === taskId)
    for (const activity of matches) activity.controller.abort()
    await Promise.allSettled(matches.map(activity => activity.promise))
  }
  async stopAll(): Promise<void> {
    this.epoch++; this.caps.clear()
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
    for (const job of await this.options.store.listJobs(scope)) {
      this.assert(scope, epoch)
      const key = this.key(scope, job.jobId)
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
