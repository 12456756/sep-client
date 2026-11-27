import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { videoBillingPending, videoReceiptSchema, videoSpecFailureSchema, videoRequestSchema, type VideoGatewayPort, type VideoReceipt } from '../../src/shared/video-media'
import { receiptMatchesRequest, videoSubmissionRejected, videoLocalIdSchema, videoScopeSchema, videoStoredQuoteSchema,
  type LocalVideoJob, type VideoAssetState, type VideoScope, type VideoStorePort } from '../domain/video-media'
import { abortableVideo } from '../data/video-files'
import { WriteChain } from '../data/write-chain'
import { AppError } from '../errors/app-error'
import { safeMediaUpstreamError } from '../common/media-upstream-error'
import { mediaJobFailure } from '../errors/media-job-error'
import { appendMediaDiagnosticError } from '../errors/arrangement-diagnostic'
import { VideoRequestError } from '../errors/video-request-error'
import { transportKind } from '../errors/operation-feedback'
import { mediaToolFailureFrom } from '../errors/media-tool-error'
import { isMediaSpecError, mediaSpecsEqual } from '../../src/shared/media-spec-contract'
import { logger } from '../common/logger'
import { mediaRetryDeferred } from '../domain/media-retry-gate'
import { mediaCooldownError, mediaRateLimit } from '../errors/media-rate-limit'
import type { VideoTrackingSelection } from './video-tracker'
import { mediaGenerationState } from '../../src/shared/media-execution'
import { mediaSubmissionRejected, mediaFailureNeedsBillingQuery } from '../../src/shared/media-failure'
import { safeMediaExecutionFields } from '../common/media-execution'
import { retryRateLimited, waitForRetry } from '../common/rate-limit-retry'
import { mediaSubmissionRecovery } from '../common/media-recovery'

type VideoInput = z.infer<typeof videoRequestSchema>
export interface VideoServiceOptions {
  onRecoveryWait?: (jobId: string, operation: string, retryAt?: number) => void
  onOutputSaved?: (scope: VideoScope, taskId: string, jobId: string, outputId: string, when: number, startedAt: number) => void
  /** One immutable authenticated scope and one gateway bound to that subscription. */
  scope: VideoScope
  executionMode?: 'mock' | 'real'
  gateway: VideoGatewayPort
  store: VideoStorePort
  now?: () => number
  retryFloorMs?: number
  operationTimeoutMs?: number
}
const activities = new WriteChain()
const generating = new Set(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'])
const terminal = new Set(['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'])
function tracking(receipt: VideoReceipt): boolean {
  if (receipt.receiptVersion === 2 && receipt.clientActions) return receipt.clientActions.shouldPoll && receipt.recovery.canQuery
  return generating.has(receipt.status) || !receipt.mock && videoBillingPending(receipt.billingStatus) && receipt.recovery.canQuery
}
function interrupted(error: unknown, fallback: string): Pick<LocalVideoJob, 'trackingStatus' | 'error'> {
  const authorization = error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')
  const transport = transportKind(error)
  return { trackingStatus: authorization ? 'AUTH_REQUIRED' : 'INTERRUPTED', error: transport === 'timeout' ? 'NETWORK_TIMEOUT' : transport === 'network' ? 'NETWORK_ERROR' : error instanceof AppError ? error.code : fallback }
}

/** Explicit one-step polling. No timers, IPC, runtime registration or real gateway selection. */
export class VideoService {
  private readonly scope: VideoScope
  private readonly gateway: VideoGatewayPort
  private readonly store: VideoStorePort
  private readonly now: () => number
  private readonly mode: 'mock' | 'real'
  private readonly retryFloorMs: number
  private readonly shutdown = new AbortController()
  private readonly onOutputSaved: VideoServiceOptions['onOutputSaved']
  private readonly onRecoveryWait: VideoServiceOptions['onRecoveryWait']
  private readonly operationTimeoutMs: number
  private rateLimitRecoveryAt = 0

  recoveredFromRateLimitAt(): number { return this.rateLimitRecoveryAt }

  constructor(options: VideoServiceOptions) {
    this.scope = videoScopeSchema.parse(options.scope)
    this.gateway = options.gateway
    this.store = options.store
    this.now = options.now ?? Date.now
    this.mode = options.executionMode ?? 'mock'
    this.retryFloorMs = options.retryFloorMs ?? 1_000
    this.onOutputSaved = options.onOutputSaved
    this.onRecoveryWait = options.onRecoveryWait
    this.operationTimeoutMs = options.operationTimeoutMs ?? (this.mode === 'real' ? 360_000 : 60_000)
  }
  private async network<T>(call: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, job?: LocalVideoJob, submitting = false, querying = false): Promise<T> {
    const notBefore = Math.max(job?.rateLimitRetryAt ?? 0, querying ? job?.nextPollAt ?? 0 : 0)
    if (job && notBefore > 0) {
      this.onRecoveryWait?.(job.jobId, 'submission', notBefore)
      await waitForRetry(Math.max(0, notBefore - this.now()), this.signal(parent))
      this.onRecoveryWait?.(job.jobId, 'submission')
      this.rateLimitRecoveryAt = this.now()
      await this.store.updateJob(this.scope, job.taskId, job.jobId, previous => ({ ...previous, rateLimitRetryAt: undefined,
        ...(querying ? { nextPollAt: undefined } : {}) }))
    }
    return retryRateLimited(call, { signal: this.signal(parent), timeoutMs: this.operationTimeoutMs, preserveWaitOnAbort: true,
      shouldRetry: job ? submitting ? error => !mediaSubmissionRecovery(error, job.request.clientRequestId, this.now()) : () => false : undefined,
      onWait: job ? async wait => {
        this.onRecoveryWait?.(job.jobId, 'submission', wait?.retryAt)
        if (wait === undefined) this.rateLimitRecoveryAt = this.now()
        await this.store.updateJob(this.scope, job.taskId, job.jobId, previous => ({ ...previous, rateLimitRetryAt: wait?.retryAt }))
      } : undefined })
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
  private update(job: LocalVideoJob, fields: Partial<Pick<LocalVideoJob, 'failure' | 'submissionFailure' | 'diagnosticErrors' | 'specFailure' | 'submission' | 'receipt' | 'trackingStatus' | 'saveStatus' | 'error' | 'lastQueriedAt' | 'providerWaitMs' | 'downloadMs' | 'queryRateLimit' | 'downloadRateLimit' | 'recoveryReceiptId' | 'rateLimitRetryAt' | 'nextPollAt'>>): Promise<LocalVideoJob> {
    return this.store.updateJob(this.scope, job.taskId, job.jobId, previous => ({ ...previous, ...fields, updatedAt: Math.max(this.now(), previous.updatedAt) }))
  }

  /** Quote, then durably freeze identity and parameters before any submit call. */
  async prepare(taskId: string, value: VideoInput, parent?: AbortSignal, runId?: string, previousUnconfirmedJobIds: readonly string[] = [], localReferenceIds?: readonly string[]): Promise<LocalVideoJob> {
    videoLocalIdSchema.parse(taskId)
    if (runId !== undefined) videoLocalIdSchema.parse(runId)
    const signal = this.signal(parent)
    signal.throwIfAborted()
    const input = videoRequestSchema.parse(value)
    const quote = videoStoredQuoteSchema.parse(await this.network(bounded => this.gateway.quote(structuredClone(input), bounded), signal))
    signal.throwIfAborted()
    if (quote.status !== 'quoted' || quote.expiresAt <= this.now()) throw new Error('Video quote is unavailable or expired.')
    if (input.protocolVersion === 3 && (quote.protocolVersion !== 3 || quote.specRevision !== input.specRevision || !quote.effectiveSpec || !mediaSpecsEqual(input.requestedSpec!, quote.effectiveSpec))) {
      throw new AppError('SPEC_CONFLICT', { details: { field: 'effectiveSpec', source: 'platform', stage: 'video-quote' } })
    }
    const now = this.now()
    const job: LocalVideoJob = {
      version: 1, executionMode: this.mode, scope: { ...this.scope }, taskId, jobId: `video_${randomUUID()}`,
      ...(runId ? { runId } : {}),
      ...(localReferenceIds ? { localReferenceIds: [...localReferenceIds] } : {}),
      ...(previousUnconfirmedJobIds.length ? { previousUnconfirmedJobIds: [...previousUnconfirmedJobIds] } : {}),
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
        receipt = await this.network(bounded => this.gateway.submit(structuredClone(job.request), bounded), signal, job, true)
      } catch (error) {
        const failure = mediaJobFailure(error, 'video-submit')
        const diagnosticErrors = appendMediaDiagnosticError(job.diagnosticErrors, 'video-submit', error, this.now())
        const recovery = mediaSubmissionRecovery(error, job.request.clientRequestId, this.now())
        if (recovery) {
          this.onRecoveryWait?.(job.jobId, 'submission', recovery.retryAt)
          return this.update(job, { recoveryReceiptId: recovery.receiptId, rateLimitRetryAt: recovery.retryAt,
            trackingStatus: 'ACTIVE', error: recovery.retryAt === undefined ? failure.code : null, failure, diagnosticErrors })
        }
        if (mediaSubmissionRejected(failure) || error instanceof VideoRequestError && error.definitelyRejected) {
          return this.update(job, { trackingStatus: mediaFailureNeedsBillingQuery(failure) ? 'ACTIVE' : 'STOPPED',
            error: failure.businessCode ?? failure.code, failure, submissionFailure: failure, diagnosticErrors })
        }
        // Persist uncertainty, never label a lost response as failure/success or re-submit.
        const specDiagnostic = error instanceof AppError && isMediaSpecError(error.code) ? videoSpecFailureSchema.safeParse(mediaToolFailureFrom(error).error) : undefined
        const specFailure = specDiagnostic?.success ? specDiagnostic.data : undefined
        return this.update(job, { ...interrupted(error, 'SUBMISSION_UNKNOWN'), failure, diagnosticErrors,
          queryRateLimit: mediaRateLimit(error, this.now(), this.retryFloorMs), ...(specFailure ? { specFailure } : {}) })
      }
      // Keep persistence errors separate from network uncertainty: a confirmed
      // receipt write failure must propagate; disk still says MAYBE_SENT.
      job = await this.accept(job, receipt)
      return this.save(job, signal)
    })
  }

  private async accept(job: LocalVideoJob, value: VideoReceipt): Promise<LocalVideoJob> {
    const parsed = videoReceiptSchema.parse(value)
    const receipt = { ...parsed, ...safeMediaExecutionFields(parsed),
      ...(parsed.upstreamError ? { upstreamError: safeMediaUpstreamError(parsed.upstreamError) } : {}) }
    if (!receiptMatchesRequest(job, receipt) || (job.receipt && job.receipt.receiptId !== receipt.receiptId)
      || job.recoveryReceiptId !== undefined && job.recoveryReceiptId !== receipt.receiptId) throw new Error('Video receipt differs from original request.')
    return this.store.updateJob(this.scope, job.taskId, job.jobId, previous => {
      if (!receiptMatchesRequest(previous, receipt) || (previous.receipt && previous.receipt.receiptId !== receipt.receiptId)) throw new Error('Video receipt differs from original request.')
      if (previous.receipt?.receiptVersion === 2 && receipt.receiptVersion !== 2) return previous
      if (receipt.execution && ['unobserved', 'not_applicable'].includes(receipt.execution.submissionStatus)) {
        if (!previous.receipt?.execution) return previous
        return { ...previous, receipt: { ...previous.receipt, execution: { ...previous.receipt.execution,
          ...(receipt.execution.operationError ? { operationError: receipt.execution.operationError } : {}) } },
          updatedAt: Math.max(this.now(), previous.updatedAt) }
      }
      const status = mediaGenerationState(receipt.status, receipt)
      if (videoSubmissionRejected(previous) && !['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(status)) return previous
      if (previous.receipt && terminal.has(mediaGenerationState(previous.receipt.status, previous.receipt)) && !terminal.has(status)) return previous
      const isTerminal = terminal.has(status)
      const prior = previous.receipt
      const sameGeneration = prior && terminal.has(prior.status) && (prior.status === receipt.status || receipt.status === 'RESULT_EXPIRED')
      const next = sameGeneration ? { ...receipt, outputErrors: receipt.outputErrors ?? prior.outputErrors,
        upstreamError: receipt.upstreamError ?? (receipt.receiptVersion === 2 ? undefined : prior.upstreamError) } : receipt
      const unknown = status === 'SUBMISSION_UNKNOWN'
      this.onRecoveryWait?.(job.jobId, 'query')
      const submissionFailure = unknown ? previous.submissionFailure ?? (previous.failure?.stage === 'video-submit' ? previous.failure : undefined) : undefined
      const saveFailure = sameGeneration && previous.failure?.stage === 'video-save' && previous.saveStatus === 'SAVE_FAILED' ? previous.failure : undefined
      return { ...previous, receipt: next, rateLimitRetryAt: undefined,
        nextPollAt: tracking(receipt) && receipt.pollAfterMs !== null ? this.now() + receipt.pollAfterMs : undefined, specFailure: unknown ? previous.specFailure : undefined, failure: saveFailure, submissionFailure,
        queryRateLimit: undefined,
        submission: 'RECEIPTED', trackingStatus: tracking(receipt) ? 'ACTIVE' : 'STOPPED', error: receipt.errorCode,
        ...(isTerminal && previous.providerWaitMs === undefined ? { providerWaitMs: Math.max(0, this.now() - previous.createdAt) } : {}),
        updatedAt: Math.max(this.now(), previous.updatedAt) }
    })
  }

  private async save(job: LocalVideoJob, signal: AbortSignal, repair = false, automatic = true): Promise<LocalVideoJob> {
    if (!job.receipt?.outputs.length) return job
    const saveStartedAt = this.now()
    const receipt = job.receipt
    try {
      const assets = await Promise.all(receipt.outputs.map(output => this.store.getAsset(this.scope, job.taskId, job.jobId, output.outputId)))
      if (assets.every(asset => asset?.status === 'SAVED')) {
        return this.update(job, { saveStatus: 'SAVED', failure: undefined, error: receipt.errorCode, trackingStatus: tracking(receipt) ? 'ACTIVE' : 'STOPPED', downloadMs: job.downloadMs, downloadRateLimit: undefined })
      }
    } catch {
      // Continue with normal materialization and preserve existing corruption handling.
    }
    if (mediaRetryDeferred(job.downloadRateLimit, this.now(), automatic)) {
      if (!automatic && job.downloadRateLimit) throw mediaCooldownError(job.downloadRateLimit.retryAt, this.now())
      return job
    }
    job = await this.update(job, { saveStatus: 'SAVING' })
    this.onRecoveryWait?.(job.jobId, 'download')
    let failed = false
    let downloadRateLimit: LocalVideoJob['downloadRateLimit']
    let failure: LocalVideoJob['failure']
    let interruption: Pick<LocalVideoJob, 'trackingStatus' | 'error'> | null = null
    let diagnosticErrors = job.diagnosticErrors
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
        await this.network(async bounded => {
          const gateway = this.gateway
          const source = (async function* () {
            const content = await abortableVideo(gateway.content(receipt.receiptId, output.outputId, bounded), bounded)
            yield* content
          })()
          const saved = await this.store.saveOutput(this.scope, job.taskId, job.jobId, output, source, bounded)
          this.onOutputSaved?.(this.scope, job.taskId, job.jobId, output.outputId, saved.createdAt, job.createdAt)
        }, signal, job)
      } catch (error) {
        failed = true
        failure = mediaJobFailure(error, 'video-save')
        downloadRateLimit = mediaRateLimit(error, this.now(), this.retryFloorMs)
        if (downloadRateLimit?.automatic) this.onRecoveryWait?.(job.jobId, 'download', downloadRateLimit.retryAt)
        diagnosticErrors = appendMediaDiagnosticError(diagnosticErrors, 'video-save', error, this.now())
        logger.child('video-service').warn('original video download failed', { taskId: job.taskId, jobId: job.jobId, outputId: output.outputId,
          ...failure })
        if (error instanceof AppError) interruption = interrupted(error, 'VIDEO_SAVE_FAILED')
        if (interruption?.trackingStatus === 'AUTH_REQUIRED' || downloadRateLimit) break
      }
    }
    // Includes the final manifest write: failures propagate, never return SAVED.
    return this.update(job, { saveStatus: failed ? 'SAVE_FAILED' : 'SAVED', downloadMs: Math.max(0, this.now() - saveStartedAt),
      failure, diagnosticErrors, downloadRateLimit,
      error: failed ? 'VIDEO_SAVE_FAILED' : receipt.errorCode,
      ...(!failed ? { trackingStatus: tracking(receipt) ? 'ACTIVE' as const : 'STOPPED' as const } : {}), ...(interruption ?? {}) })
  }

  /** One find/get only. A missing/unknown receipt NEVER authorizes a submit. */
  async resume(taskId: string, jobId: string, parent?: AbortSignal): Promise<LocalVideoJob> {
    return this.resumeOriginal(taskId, jobId, parent, false)
  }

  async resumeTracked(taskId: string, jobId: string, parent: AbortSignal, select: VideoTrackingSelection): Promise<LocalVideoJob> {
    return this.resumeOriginal(taskId, jobId, parent, true, select)
  }

  private async resumeOriginal(taskId: string, jobId: string, parent: AbortSignal | undefined, automatic: boolean, select?: VideoTrackingSelection): Promise<LocalVideoJob> {
    return this.locked(taskId, jobId, async () => {
      const signal = this.signal(parent)
      signal.throwIfAborted()
      let job = await this.load(taskId, jobId)
      if (job.queryRateLimit?.automatic) this.onRecoveryWait?.(job.jobId, 'query', job.queryRateLimit.retryAt)
      if (job.downloadRateLimit?.automatic) this.onRecoveryWait?.(job.jobId, 'download', job.downloadRateLimit.retryAt)
      if (videoSubmissionRejected(job) && !mediaFailureNeedsBillingQuery(job.submissionFailure ?? job.failure)) return job
      // Recheck under the activity lock: another recovery may just have lost auth.
      if (automatic && job.trackingStatus === 'AUTH_REQUIRED') return job
      if (job.submission === 'NOT_SENT') return this.update(job, { trackingStatus: 'STOPPED', error: 'NOT_SUBMITTED' })
      const actions = select?.(job) ?? { query: true, download: true }
      if (actions.query && (!job.receipt || (tracking(job.receipt) && job.receipt.recovery.canQuery))) {
        if (mediaRetryDeferred(job.queryRateLimit, this.now(), automatic)) {
          if (!automatic && job.queryRateLimit) throw mediaCooldownError(job.queryRateLimit.retryAt, this.now())
          return actions.download ? this.save(job, signal) : job
        }
        let receipt: VideoReceipt | null
        const queriedAt = this.now()
        job = await this.update(job, { lastQueriedAt: queriedAt })
        try {
          receipt = await this.network(bounded => (job.receipt?.receiptId ?? job.recoveryReceiptId)
            ? this.gateway.getReceipt((job.receipt?.receiptId ?? job.recoveryReceiptId)!, bounded)
            : this.gateway.findReceipt(job.request.clientRequestId, bounded), signal, job, false, true)
        } catch (error) {
          const gate = mediaRateLimit(error, this.now(), this.retryFloorMs)
          if (gate?.automatic) this.onRecoveryWait?.(job.jobId, 'query', gate.retryAt)
          const queryFailure = { ...interrupted(error, 'VIDEO_QUERY_INTERRUPTED'),
            ...(gate?.automatic === false ? { trackingStatus: 'STOPPED' as const } : {}), queryRateLimit: gate, failure: mediaJobFailure(error, 'video-query'),
            diagnosticErrors: appendMediaDiagnosticError(job.diagnosticErrors, 'video-query', error, queriedAt),
            submissionFailure: job.submissionFailure ?? (job.failure?.stage === 'video-submit' ? job.failure : undefined), lastQueriedAt: queriedAt }
          job = await this.update(job, queryFailure)
          if (!select || !actions.download || job.saveStatus === 'SAVED' || !job.receipt?.outputs.length || job.trackingStatus === 'AUTH_REQUIRED') return job
          const saved = await this.save(job, signal)
          if (saved.trackingStatus === 'AUTH_REQUIRED') return saved
          return this.update(saved, { trackingStatus: queryFailure.trackingStatus, error: queryFailure.error,
            failure: saved.saveStatus === 'SAVE_FAILED' ? saved.failure ?? queryFailure.failure : queryFailure.failure })
        }
        if (!receipt) return this.update(job, { trackingStatus: 'INTERRUPTED', error: job.error ?? 'SUBMISSION_UNKNOWN', lastQueriedAt: queriedAt })
        signal.throwIfAborted()
        job = await this.accept(job, receipt)
        job = await this.update(job, { lastQueriedAt: queriedAt })
      }
      return actions.download ? this.save(job, signal) : job
    })
  }

  /** Retry only original downloads; no quote, submit or replacement receipt. */
  async retrySave(taskId: string, jobId: string, parent?: AbortSignal, automatic = false): Promise<LocalVideoJob> {
    return this.locked(taskId, jobId, async () => {
      const signal = this.signal(parent)
      signal.throwIfAborted()
      return this.save(await this.load(taskId, jobId), signal, true, automatic)
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

  /** Read-only snapshot for delivery polling; it never waits on a job activity lock. */
  async listJobsSnapshot(taskId?: string): Promise<LocalVideoJob[]> {
    return (await this.store.listJobs(this.scope)).filter(job => (job.executionMode ?? 'mock') === this.mode && (taskId === undefined || job.taskId === taskId))
  }
  async listAssets(taskId: string): Promise<VideoAssetState[]> { return this.store.listAssets(this.scope, taskId) }

  /** Abort only local work; upstream jobs remain queryable after reconstruction. */
  close(): void { this.shutdown.abort(new Error('Video service closed.')) }
}
