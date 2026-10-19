import { z } from 'zod'

export const videoOperationSchema = z.enum(['image-to-video', 'text-to-video'])
export type VideoOperation = z.infer<typeof videoOperationSchema>

export const videoParametersSchema = z.object({
  durationSeconds: z.number().int().positive().max(600),
  aspectRatio: z.string().regex(/^\d+:\d+$/),
  resolution: z.enum(['480p', '720p', '1080p', '4k']),
  frameRate: z.number().int().positive().max(120),
  audio: z.boolean(),
  outputFormat: z.enum(['video/mp4', 'video/webm']),
}).strict()
export type VideoParameters = z.infer<typeof videoParametersSchema>

const videoCapabilitiesBaseSchema = z.object({
  supportsTextToVideo: z.boolean().default(false),
  supportsImageToVideo: z.boolean().default(false),
  supportsAudio: z.boolean().default(false),
  durationsSeconds: z.array(z.number().int().positive().max(600)).min(1).max(32),
  aspectRatios: z.array(z.string().regex(/^\d+:\d+$/)).min(1).max(16),
  resolutions: z.array(z.enum(['480p', '720p', '1080p', '4k'])).min(1).max(8),
  frameRates: z.array(z.number().int().positive().max(120)).min(1).max(8),
  maxInputBytes: z.number().int().positive().max(100 * 1024 * 1024),
  maxReferenceCount: z.number().int().min(0).max(4),
  outputFormats: z.array(z.enum(['video/mp4', 'video/webm'])).min(1).max(4),
  supportsTaskQuery: z.literal(true),
  supportsCancel: z.boolean(),
  resultRetentionSeconds: z.number().int().positive().max(7 * 24 * 60 * 60),
}).strict()
export const videoCapabilitiesSchema = videoCapabilitiesBaseSchema.superRefine((value, context) => {
  if (value.supportsImageToVideo && value.maxReferenceCount < 1) context.addIssue({ code: 'custom', path: ['maxReferenceCount'], message: 'Image-to-video requires a reference slot.' })
})
export type VideoCapabilities = z.infer<typeof videoCapabilitiesSchema>

const videoProfileBaseSchema = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  kind: z.literal('video'),
  displayName: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(160),
  configVersion: z.string().trim().min(1).max(80),
  operations: z.array(videoOperationSchema).min(1).max(2),
  executionMode: z.literal('async-query'),
  capabilities: videoCapabilitiesSchema,
  enabled: z.boolean(),
  verified: z.boolean(),
}).strict()
export const videoProfileSchema = videoProfileBaseSchema.superRefine((value, context) => {
  if (value.operations.includes('image-to-video') && !value.capabilities.supportsImageToVideo) context.addIssue({ code: 'custom', path: ['capabilities', 'supportsImageToVideo'], message: 'Profile operation requires image-to-video capability.' })
  if (value.operations.includes('text-to-video') && !value.capabilities.supportsTextToVideo) context.addIssue({ code: 'custom', path: ['capabilities', 'supportsTextToVideo'], message: 'Profile operation requires text-to-video capability.' })
})
export type VideoProfile = z.infer<typeof videoProfileSchema>

export const videoRuntimeProfileSchema = videoProfileBaseSchema.omit({ modelId: true, enabled: true, verified: true })
export const videoRuntimeSchema = z.object({
  protocolVersion: z.literal(1),
  executionAvailable: z.boolean(),
  defaultProfileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(),
  tools: z.array(z.enum(['video_from_image', 'video_generate', 'video_get_job', 'video_cancel_job'])),
  profiles: z.array(videoRuntimeProfileSchema).max(64),
}).strict().superRefine((value, context) => {
  if (!value.executionAvailable && value.tools.length > 0) context.addIssue({ code: 'custom', path: ['tools'], message: 'Disabled video runtime cannot expose tools.' })
  if (value.executionAvailable && value.profiles.length === 0) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Executable video runtime requires a profile.' })
  if (new Set(value.profiles.map(profile => profile.profileId)).size !== value.profiles.length) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Duplicate video profiles.' })
  if (value.defaultProfileId !== null && !value.profiles.some(profile => profile.profileId === value.defaultProfileId)) context.addIssue({ code: 'custom', path: ['defaultProfileId'], message: 'Default video profile is unavailable.' })
  for (const profile of value.profiles) {
    if (profile.operations.includes('image-to-video') && !profile.capabilities.supportsImageToVideo || profile.operations.includes('text-to-video') && !profile.capabilities.supportsTextToVideo) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Video profile capability mismatch.' })
  }
  for (const tool of value.tools) {
    if (tool === 'video_from_image' && !value.profiles.some(profile => profile.operations.includes('image-to-video')) || tool === 'video_generate' && !value.profiles.some(profile => profile.operations.includes('text-to-video')) || tool === 'video_cancel_job' && !value.profiles.some(profile => profile.capabilities.supportsCancel)) context.addIssue({ code: 'custom', path: ['tools'], message: 'Video tool capability is unavailable.' })
  }
})
export type VideoRuntime = z.infer<typeof videoRuntimeSchema>

const videoRequestBaseSchema = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  configVersion: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  operation: videoOperationSchema,
  referenceIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).max(4),
  creativeBrief: z.string().trim().min(1).max(4000),
  parameters: videoParametersSchema,
}).strict()
function refineVideoRequest(value: z.infer<typeof videoRequestBaseSchema>, context: z.RefinementCtx): void {
  if (value.operation === 'image-to-video' && value.referenceIds.length !== 1) context.addIssue({ code: 'custom', path: ['referenceIds'], message: 'Image-to-video requires exactly one reference.' })
  if (value.operation === 'text-to-video' && value.referenceIds.length !== 0) context.addIssue({ code: 'custom', path: ['referenceIds'], message: 'Text-to-video does not accept references in v1.' })
}
export const videoRequestSchema = videoRequestBaseSchema.superRefine(refineVideoRequest)
export const videoRequestWithIdentitySchema = videoRequestBaseSchema.extend({
  clientRequestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  quoteId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
}).superRefine(refineVideoRequest)
export type VideoRequest = z.infer<typeof videoRequestWithIdentitySchema>

export const videoOutputSchema = z.object({
  outputId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  kind: z.literal('video'),
  mimeType: z.enum(['video/mp4', 'video/webm']),
  byteLength: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  durationSeconds: z.number().positive().max(600),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  frameRate: z.number().positive().max(120),
  thumbnailOutputId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict()
export type VideoOutput = z.infer<typeof videoOutputSchema>

export const videoReceiptSchema = z.object({
  mock: z.literal(true),
  receiptId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  clientRequestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  configVersion: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  operation: videoOperationSchema,
  status: z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED', 'SUBMISSION_UNKNOWN']),
  pollAfterMs: z.number().int().nonnegative().nullable(),
  outputs: z.array(videoOutputSchema).max(4),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
  errorCode: z.string().nullable(),
  recovery: z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict(),
}).strict().superRefine((value, context) => {
  const delivered = value.status === 'SUCCEEDED' || value.status === 'PARTIAL_SUCCEEDED'
  const terminal = delivered || ['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(value.status)
  if (new Set(value.outputs.map(output => output.outputId)).size !== value.outputs.length || delivered && value.outputs.length === 0 || value.recovery.canDownload && !delivered || terminal && (value.pollAfterMs !== null || value.recovery.canQuery)) {
    context.addIssue({ code: 'custom', message: 'Inconsistent video receipt state.' })
  }
})
export type VideoReceipt = z.infer<typeof videoReceiptSchema>

export interface VideoQuote {
  quoteId: string
  requestHash: string
  expiresAt: number
  status: 'quoted' | 'unavailable'
  amount: string | null
  currency: string | null
}

export interface VideoGatewayPort {
  quote(request: z.infer<typeof videoRequestSchema>, signal: AbortSignal): Promise<VideoQuote>
  submit(request: VideoRequest, signal: AbortSignal): Promise<VideoReceipt>
  findReceipt(clientRequestId: string, signal: AbortSignal): Promise<VideoReceipt | null>
  getReceipt(receiptId: string, signal: AbortSignal): Promise<VideoReceipt>
  content(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
}


export const videoQuoteResponseSchema = z.object({
  mock: z.literal(true),
  quoteId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expiresAt: z.string().datetime({ offset: true }),
  semanticSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  pricingStatus: z.literal('quoted'),
  amountCny: z.literal('0.000000'),
  pricingVersion: z.literal('mock-video-v1'),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
}).strict()

export const videoReferenceSchema = z.object({
  mock: z.literal(true),
  referenceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expiresAt: z.string().datetime({ offset: true }),
  mimeType: z.literal('image/png'),
  byteLength: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
}).strict()

export const videoProfilesResponseSchema = z.object({
  mock: z.literal(true),
  protocolVersion: z.literal(1),
  persistence: z.enum(['memory', 'database']),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
  profiles: z.array(videoRuntimeProfileSchema).min(1).max(64),
}).strict()
