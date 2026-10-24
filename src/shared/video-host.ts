import { z } from 'zod'
import { videoParametersSchema, videoOperationSchema, type VideoOutput, type VideoRuntime, type VideoReceipt } from './video-media'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const videoGenerationInputSchema = z.object({
  profileId: id,
  operation: videoOperationSchema,
  localAssetIds: z.array(id).max(4),
  creativeBrief: z.string().trim().min(1).max(4000),
  parameters: videoParametersSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.localAssetIds).size !== value.localAssetIds.length ||
    (value.operation === 'image-to-video' ? value.localAssetIds.length !== 1 : value.localAssetIds.length !== 0)) {
    context.addIssue({ code: 'custom', path: ['localAssetIds'], message: 'Video reference selection is invalid.' })
  }
})
export type VideoGenerationInput = z.infer<typeof videoGenerationInputSchema>

/** Model requests describe intent; the host resolves the current authorized configuration. */
export const videoToolGenerationInputSchema = z.object({
  creativeBrief: z.string().trim().min(1).max(4000),
  localAssetIds: z.array(id).max(1).default([]),
  parameters: videoParametersSchema.partial().optional(),
  // Retain previously persisted tool calls without requiring new calls to know these fields.
  profileId: id.optional(),
  operation: videoOperationSchema.optional(),
}).strict().refine(value => new Set(value.localAssetIds).size === value.localAssetIds.length)

export const videoToolJobInputSchema = z.object({ jobId: id.optional() }).strict()

/** No disk paths, remote reference IDs, prompts, quotes or upstream metadata. */
export interface VideoJobView {
  jobId: string
  taskId: string
  profileId: string
  operation: VideoGenerationInput['operation']
  parameters: VideoGenerationInput['parameters']
  generationStatus: string
  trackingStatus: 'ACTIVE' | 'INTERRUPTED' | 'AUTH_REQUIRED' | 'STOPPED'
  saveStatus: 'PENDING' | 'SAVING' | 'SAVED' | 'SAVE_FAILED' | 'MISSING'
  billingStatus: VideoReceipt['billingStatus']
  amountCny?: string
  actualCostCny?: string
  amountUsd?: string
  createdAt: number
  updatedAt: number
  lastQueriedAt?: number
  /** Submission-to-observed-provider-terminal duration; includes queue time. */
  providerWaitMs?: number
  /** Duration of the most recent complete save round across all outputs. */
  downloadMs?: number
  error: string | null
  outputs: VideoOutput[]
  /** Verified local outputs; supports partial save without hiding existing files. */
  savedOutputIds?: string[]
}

export interface VideoTaskView {
  mock: boolean
  runtime: VideoRuntime
  jobs: VideoJobView[]
}
