import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { videoOutputSchema, videoReceiptSchema, videoRequestWithIdentitySchema } from '../../src/shared/video-media'
import type { VideoOutput, VideoReceipt } from '../../src/shared/video-media'

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
}).strict()
export const videoSaveStatusSchema = z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING'])
export const localVideoJobSchema = z.object({
  version: z.literal(1), scope: videoScopeSchema, taskId: videoLocalIdSchema, jobId: videoLocalIdSchema,
  request: videoRequestWithIdentitySchema, quote: videoStoredQuoteSchema,
  submission: z.enum(['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED']), receipt: videoReceiptSchema.nullable(),
  trackingStatus: z.enum(['ACTIVE', 'INTERRUPTED', 'AUTH_REQUIRED', 'STOPPED']), saveStatus: videoSaveStatusSchema,
  error: z.string().max(256).nullable(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((job, context) => {
  if (job.request.quoteId !== job.quote.quoteId || job.quote.status !== 'quoted' || job.updatedAt < job.createdAt ||
    (job.submission === 'RECEIPTED') !== (job.receipt !== null) ||
    (job.saveStatus === 'SAVED' && !job.receipt?.outputs.length)) {
    context.addIssue({ code: 'custom', message: 'Inconsistent local video job.' })
  }
  if (job.receipt && !receiptMatchesRequest(job, job.receipt)) context.addIssue({ code: 'custom', message: 'Video receipt does not match the frozen request.' })
  if (job.receipt && new Set(job.receipt.outputs.map(output => output.outputId)).size !== job.receipt.outputs.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate video output identity.' })
  }
})
export type LocalVideoJob = z.infer<typeof localVideoJobSchema>

export function receiptMatchesRequest(job: Pick<LocalVideoJob, 'request'>, receipt: VideoReceipt): boolean {
  return receipt.clientRequestId === job.request.clientRequestId && receipt.profileId === job.request.profileId &&
    receipt.configVersion === job.request.configVersion && receipt.operation === job.request.operation
}

export const localVideoAssetSchema = z.object({
  version: z.literal(1), scope: videoScopeSchema, taskId: videoLocalIdSchema, jobId: videoLocalIdSchema,
  localAssetId: z.string().regex(/^vout_[a-f0-9]{64}$/), receiptId: videoLocalIdSchema, output: videoOutputSchema,
  relativePath: z.string().min(1).max(256), status: z.literal('SAVED'), createdAt: z.number().int().nonnegative(),
}).strict()
export type LocalVideoAsset = z.infer<typeof localVideoAssetSchema>
export type VideoAssetState = Omit<LocalVideoAsset, 'status'> & { status: 'SAVED' | 'MISSING' }

export function assertVideoJobUpdate(previous: LocalVideoJob, next: LocalVideoJob): void {
  const stable = ['version', 'scope', 'taskId', 'jobId', 'request', 'quote', 'createdAt'] as const
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
