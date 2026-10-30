import { z } from 'zod'
import { videoParametersSchema, videoOperationSchema, type VideoOutput, type VideoRuntime, type VideoReceipt, type VideoSpecFailure } from './video-media'
import { mediaSpecMetadataSchema, mediaSpecsEqual, videoRequestedSpecSchema, type VideoRequestedSpec, type MediaParameterSources } from './media-spec-contract'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const profileId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
export const videoGenerationInputSchema = z.object({
  profileId,
  operation: videoOperationSchema,
  localAssetIds: z.array(id).max(4),
  creativeBrief: z.string().trim().min(1).max(4000),
  parameters: videoRequestedSpecSchema,
  protocolVersion: z.literal(3).optional(), requestedSpec: videoRequestedSpecSchema.optional(),
  specRevision: mediaSpecMetadataSchema.shape.specRevision.optional(), parameterSources: mediaSpecMetadataSchema.shape.parameterSources.optional(),
}).strict().superRefine((value, context) => {
  if (value.protocolVersion === 3 ? !value.requestedSpec || value.specRevision === undefined || !value.parameterSources || !mediaSpecsEqual(value.parameters, value.requestedSpec)
    : !videoParametersSchema.safeParse(value.parameters).success || value.requestedSpec !== undefined || value.specRevision !== undefined || value.parameterSources !== undefined) {
    context.addIssue({ code: 'custom', path: ['parameters'], message: 'Video specification version is incomplete or contradictory.' })
  }
  if (new Set(value.localAssetIds).size !== value.localAssetIds.length ||
    (value.operation === 'image-to-video' ? value.localAssetIds.length !== 1 : value.localAssetIds.length !== 0)) {
    context.addIssue({ code: 'custom', path: ['localAssetIds'], message: 'Video reference selection is invalid.' })
  }
})
export type VideoGenerationInput = z.infer<typeof videoGenerationInputSchema>

/** Model requests describe intent; the host resolves the current authorized configuration. */
export const videoToolGenerationInputSchema = z.object({
  requirementId: z.string().trim().min(1).max(128).optional(),
  creativeBrief: z.string().trim().min(1).max(4000),
  localAssetIds: z.array(id).max(1).default([]),
  parameters: videoRequestedSpecSchema.optional(),
  protocolVersion: z.literal(3).optional(), requestedSpec: videoRequestedSpecSchema.optional(),
  specRevision: mediaSpecMetadataSchema.shape.specRevision.optional(), parameterSources: mediaSpecMetadataSchema.shape.parameterSources.optional(),
  // Retain previously persisted tool calls without requiring new calls to know these fields.
  profileId: profileId.optional(),
  operation: videoOperationSchema.optional(),
}).strict().refine(value => new Set(value.localAssetIds).size === value.localAssetIds.length)
  .refine(value => value.parameters === undefined || value.protocolVersion === 3 || videoParametersSchema.partial().safeParse(value.parameters).success,
    'Legacy video parameters are invalid.')
  .refine(value => !value.parameters || !value.requestedSpec || mediaSpecsEqual(value.parameters, value.requestedSpec), 'Video specifications conflict.')

export const videoToolJobInputSchema = z.object({ jobId: id.optional() }).strict()

/** No disk paths, remote reference IDs, prompts, quotes or upstream metadata. */
export interface VideoJobView {
  jobId: string
  taskId: string
  profileId: string
  operation: VideoGenerationInput['operation']
  parameters: VideoGenerationInput['parameters']
  protocolVersion?: 3
  specRevision?: number
  requestedSpec?: VideoRequestedSpec
  effectiveSpec?: VideoRequestedSpec
  actualSpec?: VideoRequestedSpec
  parameterSources?: MediaParameterSources
  acceptance?: 'matched' | 'mismatched' | 'unknown'
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
  specFailure?: VideoSpecFailure
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
