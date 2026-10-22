import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { videoBillingPending, videoReceiptSchema, videoRequestSchema, type VideoGatewayPort, type VideoReceipt } from '../../src/shared/video-media'
import { receiptMatchesRequest, videoSubmissionRejected, videoLocalIdSchema, videoScopeSchema, videoStoredQuoteSchema,
  type LocalVideoJob, type VideoAssetState, type VideoScope, type VideoStorePort } from '../domain/video-media'
import { abortableVideo } from '../data/video-files'
import { WriteChain } from '../data/write-chain'
import { AppError } from '../errors/app-error'
import { VideoRequestError } from '../errors/video-request-error'
import { videoErrorMessage } from '../../src/shared/video-errors'

type VideoInput = z.infer<typeof videoRequestSchema>
export interface VideoServiceOptions {
  /** One immutable authenticated scope and one gateway bound to that subscription. */
  scope: VideoScope
  executionMode?: 'mock' | 'real'
  gateway: VideoGatewayPort
  store: VideoStorePort
  now?: () => number
}
const activities = new WriteChain()
const generating = new Set(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'])
function tracking(receipt: VideoReceipt): boolean {
  return generating.has(receipt.status) || !receipt.mock && videoBillingPending(receipt.billingStatus) && receipt.recovery.canQuery
}
function interrupted(error: unknown, fallback: string): Pick<LocalVideoJob, 'trackingStatus' | 'error'> {
  const authorization = error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')
  return { trackingStatus: authorization ? 'AUTH_REQUIRED' : 'INTERRUPTED', error: error instanceof AppError ? error.code : fallback }
}

/** Explicit one-step polling. No timers, IPC, runtime registration or real gateway selection. */
export class VideoService {
  private readonly scope: VideoScope
  private readonly gateway: VideoGatewayPort
  private readonly store: VideoStorePort
  private readonly now: () => number
  private readonly mode: 'mock' | 'real'
  private readonly shutdown = new AbortController()

  constructor(options: VideoServiceOptions) {
    this.scope = videoScopeSchema.parse(options.scope)
    this.gateway = options.gateway
    this.store = options.store
    this.now = options.now ?? Date.now
    this.mode = options.executionMode ?? 'mock'
  }
  private signal(parent?: AbortSignal): AbortSignal {
    return parent ? AbortSignal.any([parent, this.shutdown.signal]) : this.shutdown.signal
  }
  private locked<T>(taskId: string, jobId: string, operation: () => Promise<T>): Promise<T> {
    videoLocalIdSchema.parse(taskId); videoLocalIdSchema.parse(jobId)
    return activities.run(JSON.stringify([this.scope, taskId, jobId]), operation)
  }
  private async load(taskId: string, jobId: string): Promise<LocalVideoJob> {
    const job = await this.store.getJob(this.scope, taskId, jobId)
    if (!job) throw new Error('Video job does not exist in the active scope.')
    if ((job.executionMode ?? 'mock') !== this.mode) throw new AppError('PERMISSION_DENIED')
    return job
  }
  private update(job: LocalVideoJob, fields: Partial<Pick<LocalVideoJob, 'submission' | 'receipt' | 'trackingStatus' | 'saveStatus' | 'error'>>): Promise<LocalVideoJob> {
    return this.store.updateJob(this.scope, job.taskId, job.jobId, previous => ({ ...previous, ...fields, updatedAt: Math.max(this.now(), previous.updatedAt) }))
  }

  /** Quote, then durably freeze identity and parameters before any submit call. */
  async prepare(taskId: string, value: VideoInput, parent?: AbortSignal): Promise<LocalVideoJob> {
    videoLocalIdSchema.parse(taskId)
    const signal = this.signal(parent)
    signal.throwIfAborted()
    const input = videoRequestSchema.parse(value)
    const quote = videoStoredQuoteSchema.parse(await abortableVideo(this.gateway.quote(structuredClone(input), signal), signal))
    signal.throwIfAborted()
    if (quote.status !== 'quoted' || quote.expiresAt <= this.now()) throw new Error('Video quote is unavailable or expired.')
    const now = this.now()
    const job: LocalVideoJob = {
      version: 1, executionMode: this.mode, scope: { ...this.scope }, taskId, jobId: `video_${randomUUID()}`,
      request: { ...input, clientRequestId: `video_request_${randomUUID()}`, quoteId: quote.quoteId }, quote,
      submission: 'NOT_SENT', receipt: null, trackingStatus: 'ACTIVE', saveStatus: 'PENDING', error: null, createdAt: now, updatedAt: now,
    }
    await this.store.createJob(this.scope, job)
    return structuredClone(job)
  }

  async generate(taskId: string, value: VideoInput, parent?: AbortSignal): Promise<LocalVideoJob> {
    const job = await this.prepare(taskId, value, parent)
    return this.submit(taskId, job.jobId, parent)
  }

  /** Explicit first submission only; recovery never calls this method. */
  async submit(taskId: string, jobId: string, parent?: AbortSignal): Promise<LocalVideoJob> {
    return this.locked(taskId, jobId, async () => {
      const signal = this.signal(parent)
      signal.throwIfAborted()
      await this.load(taskId, jobId)
      let job = await this.store.updateJob(this.scope, taskId, jobId, previous => {
        signal.throwIfAborted()
        if (previous.submission !== 'NOT_SENT') throw new Error('Video may already be submitted; query the original request.')
        if (previous.quote.expiresAt <= this.now()) throw new Error('Frozen video quote expired; this job was not submitted.')
        return { ...previous, submission: 'MAYBE_SENT', updatedAt: Math.max(this.now(), previous.updatedAt) }
      })
      let receipt: VideoReceipt
      try {
        signal.throwIfAborted()
        receipt = await abortableVideo(this.gateway.submit(structuredClone(job.request), signal), signal)
      } catch (error) {
        if (error instanceof VideoRequestError && error.definitelyRejected) {
          return this.update(job, { trackingStatus: 'STOPPED', error: error.businessCode })
        }
        // Persist uncertainty, never label a lost response as failure/success or re-submit.
        return this.update(job, interrupted(error, 'SUBMISSION_UNKNOWN'))
      }
      // Keep persistence errors separate from network uncertainty: a confirmed
      // receipt write failure must propagate; disk still says MAYBE_SENT.
      job = await this.accept(job, receipt)
      return this.save(job, signal)
    })
  }

  private async accept(job: LocalVideoJob, value: VideoReceipt): Promise<LocalVideoJob> {
    const receipt = videoReceiptSchema.parse(value)
    if (!receiptMatchesRequest(job, receipt) || (job.receipt && job.receipt.receiptId !== receipt.receiptId)) throw new Error('Video receipt differs from original request.')
    return this.update(job, { receipt, submission: 'RECEIPTED', trackingStatus: tracking(receipt) ? 'ACTIVE' : 'STOPPED', error: receipt.errorCode })
  }

  private async save(job: LocalVideoJob, signal: AbortSignal, repair = false): Promise<LocalVideoJob> {
    if (!job.receipt?.outputs.length) return job
    const receipt = job.receipt
    job = await this.update(job, { saveStatus: 'SAVING' })
    let failed = false
    let interruption: Pick<LocalVideoJob, 'trackingStatus' | 'error'> | null = null
    for (const output of receipt.outputs) {
      try {
        signal.throwIfAborted()
        let asset: VideoAssetState | null
        try { asset = await this.store.getAsset(this.scope, job.taskId, job.jobId, output.outputId) } catch (error) {
          if (!repair || !receipt.recovery.canDownload || (output.expiresAt && Date.parse(output.expiresAt) <= this.now())) throw error
          asset = await this.store.repairCorruptOutput(this.scope, job.taskId, job.jobId, output.outputId, signal)
        }
        if (asset?.status === 'SAVED') continue
        if (!receipt.recovery.canDownload || (output.expiresAt && Date.parse(output.expiresAt) <= this.now())) throw new Error('Original video output is unavailable.')
        // Lazily open content only if the store actually needs bytes; concurrent
        // stores or commit recovery can deduplicate without another download.
        const gateway = this.gateway
        const source = (async function* () {
          const content = await abortableVideo(gateway.content(receipt.receiptId, output.outputId, signal), signal)
          yield* content
        })()
        await this.store.saveOutput(this.scope, job.taskId, job.jobId, output, source, signal)
      } catch (error) {
        failed = true
        if (error instanceof AppError) interruption = interrupted(error, 'VIDEO_SAVE_FAILED')
        if (interruption?.trackingStatus === 'AUTH_REQUIRED') break
      }
    }
    // Includes the final manifest write: failures propagate, never return SAVED.
    return this.update(job, { saveStatus: failed ? 'SAVE_FAILED' : 'SAVED',
      error: failed ? 'VIDEO_SAVE_FAILED' : receipt.errorCode,
      ...(!failed ? { trackingStatus: tracking(receipt) ? 'ACTIVE' as const : 'STOPPED' as const } : {}), ...(interruption ?? {}) })
  }

  /** One find/get only. A missing/unknown receipt NEVER authorizes a submit. */
  async resume(taskId: string, jobId: string, parent?: AbortSignal): Promise<LocalVideoJob> {
    return activities.run(JSON.stringify(['video-recovery', this.scope]), () => this.resumeOriginal(taskId, jobId, parent, false))
  }

  private async resumeOriginal(taskId: string, jobId: string, parent: AbortSignal | undefined, automatic: boolean): Promise<LocalVideoJob> {
    return this.locked(taskId, jobId, async () => {
      const signal = this.signal(parent)
      signal.throwIfAborted()
      let job = await this.load(taskId, jobId)
      if (videoSubmissionRejected(job)) return job
      // Recheck under the activity lock: another recovery may just have lost auth.
      if (automatic && job.trackingStatus === 'AUTH_REQUIRED') return job
      if (job.submission === 'NOT_SENT') return this.update(job, { trackingStatus: 'STOPPED', error: 'NOT_SUBMITTED' })
      if (!job.receipt || (tracking(job.receipt) && job.receipt.recovery.canQuery)) {
        let receipt: VideoReceipt | null
        try {
          receipt = job.receipt
            ? await abortableVideo(this.gateway.getReceipt(job.receipt.receiptId, signal), signal)
            : await abortableVideo(this.gateway.findReceipt(job.request.clientRequestId, signal), signal)
        } catch (error) {
          return this.update(job, interrupted(error, 'VIDEO_QUERY_INTERRUPTED'))
        }
        if (!receipt) return this.update(job, { trackingStatus: 'INTERRUPTED', error: videoErrorMessage(job.error) ? job.error : 'SUBMISSION_UNKNOWN' })
        signal.throwIfAborted()
        job = await this.accept(job, receipt)
      }
      return this.save(job, signal)
    })
  }

  /** Retry only original downloads; no quote, submit or replacement receipt. */
  async retrySave(taskId: string, jobId: string, parent?: AbortSignal): Promise<LocalVideoJob> {
    return this.locked(taskId, jobId, async () => {
      const signal = this.signal(parent)
      signal.throwIfAborted()
      return this.save(await this.load(taskId, jobId), signal, true)
    })
  }

  /** Rebuild from disk; caller schedules subsequent polls using receipt.pollAfterMs. */
  async recover(parent?: AbortSignal): Promise<LocalVideoJob[]> {
    return activities.run(JSON.stringify(['video-recovery', this.scope]), async () => {
      const signal = this.signal(parent)
      const jobs = (await this.store.listJobs(this.scope)).filter(job => (job.executionMode ?? 'mock') === this.mode)
      // Authorization belongs to the authenticated scope, not just one job.
      // Keep this pause durable across reconstruction and overlapping recovery.
      if (jobs.some(job => job.trackingStatus === 'AUTH_REQUIRED')) return jobs
      const restored: LocalVideoJob[] = []
      for (const job of jobs) {
        signal.throwIfAborted()
        const current = await this.resumeOriginal(job.taskId, job.jobId, signal, true)
        restored.push(current)
        if (current.trackingStatus === 'AUTH_REQUIRED') {
          const paused = (await this.store.listJobs(this.scope)).filter(job => (job.executionMode ?? 'mock') === this.mode)
          for (const candidate of paused) {
            if (candidate.trackingStatus === 'ACTIVE' || candidate.trackingStatus === 'INTERRUPTED' || candidate.saveStatus === 'SAVE_FAILED') {
              await this.update(candidate, { trackingStatus: 'AUTH_REQUIRED', error: current.error })
            }
          }
          return (await this.store.listJobs(this.scope)).filter(job => (job.executionMode ?? 'mock') === this.mode)
        }
      }
      return restored
    })
  }

  async listJobs(): Promise<LocalVideoJob[]> {
    const jobs = (await this.store.listJobs(this.scope)).filter(job => (job.executionMode ?? 'mock') === this.mode)
    const result: LocalVideoJob[] = []
    for (const job of jobs) {
      result.push(await this.locked(job.taskId, job.jobId, async () => {
        const current = await this.load(job.taskId, job.jobId)
        if (current.saveStatus === 'SAVED') {
          try {
            const assets = await Promise.all((current.receipt?.outputs ?? []).map(output => this.store.getAsset(this.scope, current.taskId, current.jobId, output.outputId)))
            if (assets.some(asset => asset?.status !== 'SAVED')) return this.update(current, { saveStatus: 'MISSING', error: 'VIDEO_LOCAL_OUTPUT_MISSING' })
          } catch {
            return this.update(current, { saveStatus: 'SAVE_FAILED', error: 'VIDEO_LOCAL_OUTPUT_INVALID' })
          }
        }
        return current
      }))
    }
    return result
  }
  async listAssets(taskId: string): Promise<VideoAssetState[]> { return this.store.listAssets(this.scope, taskId) }

  /** Abort only local work; upstream jobs remain queryable after reconstruction. */
  close(): void { this.shutdown.abort(new Error('Video service closed.')) }
}
