import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { videoOutputSchema, videoReceiptSchema, videoSpecFailureSchema, videoRequestWithIdentitySchema } from '../../src/shared/video-media'
import type { VideoOutput, VideoReceipt } from '../../src/shared/video-media'
import { isVideoSubmissionRejectionCode } from '../../src/shared/video-errors'
import { mediaSpecMetadataSchema, mediaSpecsEqual, videoRequestedSpecSchema, type VideoActualSpec } from '../../src/shared/media-spec-contract'

export const videoLocalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const scopeSegment = z.string().min(1).max(256).refine(value => !/[\\/]/.test(value) && value !== '.' && value !== '..')
export const videoScopeSchema = z.object({ enterpriseId: scopeSegment, memberId: scopeSegment, subscriptionId: scopeSegment }).strict()
export type VideoScope = z.infer<typeof videoScopeSchema>

// requestHash is the server's semanticSha256 (including remote reference hashes).
// It is opaque locally: never derive it from JSON.stringify(request).
export const videoStoredQuoteSchema = z.object({
  quoteId: videoLocalIdSchema, requestHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  expiresAt: z.number().int().nonnegative(), status: z.enum(['quoted', 'unavailable']),
  amount: z.string().max(128).nullable(), currency: z.string().max(32).nullable(),
  amountUsd: z.string().regex(/^\d+(?:\.\d+)?$/).optional(), pricingVersion: z.string().min(1).max(256).optional(),
  usdToCnyRate: z.number().finite().positive().optional(),
  funding: z.object({ creditCny: z.string(), memberWalletCny: z.string(), personalCny: z.string() }).strict().optional(),
  protocolVersion: z.literal(3).optional(), specRevision: mediaSpecMetadataSchema.shape.specRevision.optional(), effectiveSpec: videoRequestedSpecSchema.optional(),
}).strict()
export const videoSaveStatusSchema = z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING'])
export const localVideoJobSchema = z.object({
  version: z.literal(1), scope: videoScopeSchema, taskId: videoLocalIdSchema, jobId: videoLocalIdSchema,
  runId: videoLocalIdSchema.optional(),
  executionMode: z.enum(['mock', 'real']).optional(),
  request: videoRequestWithIdentitySchema, quote: videoStoredQuoteSchema,
  submission: z.enum(['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED']), receipt: videoReceiptSchema.nullable(),
  trackingStatus: z.enum(['ACTIVE', 'INTERRUPTED', 'AUTH_REQUIRED', 'STOPPED']), saveStatus: videoSaveStatusSchema,
  lastQueriedAt: z.number().int().nonnegative().optional(),
  /** Elapsed time from job creation to first observed provider success; includes queue time. */
  providerWaitMs: z.number().int().nonnegative().optional(),
  /** Duration of the most recent complete save round across all outputs. */
  downloadMs: z.number().int().nonnegative().optional(),
  specFailure: videoSpecFailureSchema.optional(),
  error: z.string().max(256).nullable(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((job, context) => {
  if (job.request.quoteId !== job.quote.quoteId || job.quote.status !== 'quoted' || job.updatedAt < job.createdAt ||
    (job.submission === 'RECEIPTED') !== (job.receipt !== null) ||
    (job.saveStatus === 'SAVED' && !job.receipt?.outputs.length)) {
    context.addIssue({ code: 'custom', message: 'Inconsistent local video job.' })
  }
  if (job.receipt && !receiptMatchesRequest(job, job.receipt)) context.addIssue({ code: 'custom', message: 'Video receipt does not match the frozen request.' })
  if ((job.executionMode ?? 'mock') === 'real' ? job.quote.currency !== 'CNY' || !/^\d+\.\d{6}$/.test(job.quote.amount ?? '') : job.quote.currency !== 'MOCK' || !/^0(?:\.0+)?$/.test(job.quote.amount ?? '')) context.addIssue({ code: 'custom', message: 'Video quote does not match the frozen execution mode.' })
  if (job.receipt && new Set(job.receipt.outputs.map(output => output.outputId)).size !== job.receipt.outputs.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate video output identity.' })
  }
})
export type LocalVideoJob = z.infer<typeof localVideoJobSchema>

export function videoSubmissionRejected(job: LocalVideoJob): boolean {
  return job.submission === 'MAYBE_SENT' && job.receipt === null && job.trackingStatus === 'STOPPED' &&
    isVideoSubmissionRejectionCode(job.error)
}

export function receiptMatchesRequest(job: Pick<LocalVideoJob, 'request' | 'executionMode'>, receipt: VideoReceipt): boolean {
  return receipt.mock === ((job.executionMode ?? 'mock') === 'mock') && receipt.clientRequestId === job.request.clientRequestId && receipt.profileId === job.request.profileId &&
    receipt.configVersion === job.request.configVersion && receipt.operation === job.request.operation &&
    (job.request.protocolVersion !== 3 || receipt.protocolVersion === 3 && receipt.specRevision === job.request.specRevision && receipt.effectiveSpec !== undefined && mediaSpecsEqual(job.request.requestedSpec!, receipt.effectiveSpec))
}

export const localVideoAssetSchema = z.object({
  version: z.literal(1), scope: videoScopeSchema, taskId: videoLocalIdSchema, jobId: videoLocalIdSchema,
  localAssetId: z.string().regex(/^vout_[a-f0-9]{64}$/), receiptId: videoLocalIdSchema, output: videoOutputSchema,
  relativePath: z.string().min(1).max(256), status: z.literal('SAVED'), createdAt: z.number().int().nonnegative(),
}).strict()
export type LocalVideoAsset = z.infer<typeof localVideoAssetSchema>
export type VideoAssetState = Omit<LocalVideoAsset, 'status'> & { status: 'SAVED' | 'MISSING' }

export function assertVideoJobUpdate(previous: LocalVideoJob, next: LocalVideoJob): void {
  const stable = ['version', 'scope', 'taskId', 'jobId', 'runId', 'executionMode', 'request', 'quote', 'createdAt'] as const
  if (stable.some(key => !isDeepStrictEqual(previous[key], next[key])) || next.updatedAt < previous.updatedAt ||
    ['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED'].indexOf(next.submission) < ['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED'].indexOf(previous.submission)) {
    throw new Error('Frozen video identity or submission state cannot change.')
  }
  if (!previous.receipt) return
  const receipt = next.receipt
  if (!receipt || receipt.receiptId !== previous.receipt.receiptId) throw new Error('Original video receipt cannot change.')
  const terminal = ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']
  const before = previous.receipt.status
  if ((terminal.includes(before) && receipt.status !== before &&
      !(receipt.status === 'RESULT_EXPIRED' && ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(before))) ||
    (before === 'RUNNING' && ['QUEUED', 'SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(receipt.status)) ||
    (before === 'QUEUED' && ['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(receipt.status))) throw new Error('Video generation state cannot regress.')
  for (const output of previous.receipt.outputs) {
    const candidate = receipt.outputs.find(item => item.outputId === output.outputId)
    // Retention metadata may be refreshed; the actual content identity is immutable.
    if (!candidate || !isDeepStrictEqual({ ...candidate, expiresAt: null }, { ...output, expiresAt: null })) {
      throw new Error('Original video output identity cannot change.')
    }
  }
}

export interface VideoStorePort {
  createJob(scope: VideoScope, job: LocalVideoJob): Promise<void>
  getJob(scope: VideoScope, taskId: string, jobId: string): Promise<LocalVideoJob | null>
  listJobs(scope: VideoScope): Promise<LocalVideoJob[]>
  updateJob(scope: VideoScope, taskId: string, jobId: string, update: (job: LocalVideoJob) => LocalVideoJob): Promise<LocalVideoJob>
  getAsset(scope: VideoScope, taskId: string, jobId: string, outputId: string): Promise<VideoAssetState | null>
  repairCorruptOutput(scope: VideoScope, taskId: string, jobId: string, outputId: string, signal: AbortSignal): Promise<VideoAssetState>
  listAssets(scope: VideoScope, taskId: string): Promise<VideoAssetState[]>
  readAsset(scope: VideoScope, taskId: string, jobId: string, outputId: string): Promise<Uint8Array>
  saveOutput(scope: VideoScope, taskId: string, jobId: string, output: VideoOutput, stream: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<LocalVideoAsset>
}

/** Receipt measurements describe the delivered artifact; unknown fields never imply acceptance. */
export function videoSpecAcceptance(job: Pick<LocalVideoJob, 'request' | 'receipt'>): {
  actualSpec?: VideoActualSpec
  acceptance: 'matched' | 'mismatched' | 'unknown'
} {
  if (job.request.protocolVersion !== 3 || !job.receipt) return { acceptance: 'unknown' }
  const receipt = job.receipt
  const measured = receipt.actualSpec
  const reportedSpec = measured && 'mimeType' in measured ? {
    durationSeconds: measured.durationSeconds, width: measured.width, height: measured.height,
    frameRate: measured.frameRate, outputFormat: measured.mimeType,
    ...(measured.hasAudio === null ? {} : { audio: measured.hasAudio }),
  } : measured ?? {}
  const measuredSpecs = receipt.outputs.length ? receipt.outputs.map(output => ({
    ...reportedSpec,
    width: output.width, height: output.height, durationSeconds: output.durationSeconds,
    frameRate: output.frameRate, outputFormat: output.mimeType,
    aspectRatio: `${output.width}:${output.height}`,
  })) : [reportedSpec]
  const requested = job.request.requestedSpec ?? {}
  const entries = Object.entries(requested).filter(([, value]) => value !== undefined)
  const differs = measuredSpecs.some(spec => entries.some(([key, value]) => {
    const measured = spec[key as keyof typeof spec]
    return measured !== undefined && !mediaSpecsEqual({ [key]: value }, { [key]: measured })
  }))
  const complete = entries.length > 0 && measuredSpecs.every(spec =>
    entries.every(([key]) => spec[key as keyof typeof spec] !== undefined))
  // A single summary is truthful only when every delivered artifact has the same measured specification.
  const actualSpec = measuredSpecs.every(spec => mediaSpecsEqual(measuredSpecs[0], spec)) ? measuredSpecs[0] : undefined
  return { ...(actualSpec && Object.keys(actualSpec).length ? { actualSpec } : {}), acceptance:
    differs || job.receipt.acceptance === 'mismatched' ? 'mismatched' : complete ? 'matched' : 'unknown' }
}
