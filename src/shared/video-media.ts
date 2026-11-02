import { z } from 'zod'
import { mediaSpecMetadataSchema, mediaSpecsEqual, videoActualSpecSchema, videoRequestedSpecSchema, type VideoRequestedSpec } from './media-spec-contract'

/** Persist only validated public specification diagnostics, never upstream free text. */
export const videoSpecFailureSchema = z.object({
  code: z.enum(['MISSING_SPEC', 'SPEC_CONFLICT', 'UPGRADE_REQUIRED', 'PRICE_UNAVAILABLE', 'ADAPTER_UNAVAILABLE', 'ADAPTER_FIELD_UNMAPPED', 'UPSTREAM_SPEC_UNSUPPORTED', 'OUTPUT_SPEC_MISMATCH']),
  field: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/).optional(),
  source: z.enum(['client', 'sep', 'platform', 'adapter', 'pricing', 'sub2api', 'provider', 'upstream', 'authorization']).optional(),
  requestedValue: z.union([z.string().max(96), z.number().finite(), z.boolean()]).optional(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).optional(),
  alternatives: z.array(videoRequestedSpecSchema).max(8).optional(),
  submissionState: z.enum(['not_submitted', 'submitted', 'unknown']).optional(),
  billingState: z.enum(['not_reserved', 'reserved', 'settled', 'released', 'reconciling', 'unknown']).optional(),
  retryable: z.boolean().optional(),
}).strip().refine(value => value.requestedValue === undefined || !!value.field && videoRequestedSpecSchema.safeParse({ [value.field.split('.').at(-1)!]: value.requestedValue }).success)
export type VideoSpecFailure = z.infer<typeof videoSpecFailureSchema>

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

const videoCapabilitiesV1Schema = z.object({
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
const videoCapabilitiesV1RefinedSchema = videoCapabilitiesV1Schema.superRefine((value, context) => {
  if (value.supportsImageToVideo && value.maxReferenceCount < 1) context.addIssue({ code: 'custom', path: ['maxReferenceCount'], message: 'Image-to-video requires a reference slot.' })
})

const videoDefaultsSchema = z.object({
  durationSeconds: z.number().int().positive().max(600), aspectRatio: z.string().regex(/^\d+:\d+$/),
  resolution: z.enum(['480p', '720p', '1080p', '4k']), frameRate: z.number().int().positive().max(120),
  audio: z.boolean(), outputFormat: z.enum(['video/mp4', 'video/webm']),
}).strict()
const videoCapabilitiesV2Schema = videoCapabilitiesV1Schema.extend({
  audioModes: z.array(z.boolean()).min(1).max(2), defaultAudio: z.boolean(), defaults: videoDefaultsSchema,
}).strict().superRefine((value, context) => {
  if (value.supportsImageToVideo && value.maxReferenceCount < 1) context.addIssue({ code: 'custom', path: ['maxReferenceCount'], message: 'Image-to-video requires a reference slot.' })
  if (!value.audioModes.includes(value.defaultAudio) || value.defaultAudio !== value.defaults.audio) context.addIssue({ code: 'custom', path: ['defaultAudio'], message: 'Audio default must match an available mode and defaults.' })
  if (!value.durationsSeconds.includes(value.defaults.durationSeconds) || !value.aspectRatios.includes(value.defaults.aspectRatio)
    || !value.resolutions.includes(value.defaults.resolution) || !value.frameRates.includes(value.defaults.frameRate)
    || !value.outputFormats.includes(value.defaults.outputFormat)) context.addIssue({ code: 'custom', path: ['defaults'], message: 'Video defaults must be available in capabilities.' })
  if (value.supportsAudio !== value.audioModes.includes(true)) context.addIssue({ code: 'custom', path: ['audioModes'], message: 'Audio modes must agree with supportsAudio.' })
})
export const videoCapabilitiesSchema = z.union([videoCapabilitiesV1RefinedSchema, videoCapabilitiesV2Schema])
export type VideoCapabilities = Omit<z.infer<typeof videoCapabilitiesV1RefinedSchema>, 'supportsTextToVideo' | 'supportsImageToVideo' | 'supportsAudio'> & {
  supportsTextToVideo: boolean
  supportsImageToVideo: boolean
  supportsAudio: boolean
  audioModes?: boolean[]
  defaultAudio?: boolean
  defaults?: z.infer<typeof videoDefaultsSchema>
}

const videoProfileBaseSchema = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  kind: z.literal('video'),
  displayName: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(160),
  configVersion: z.string().trim().min(1).max(80),
  operations: z.array(videoOperationSchema).min(1).max(2),
  executionMode: z.literal('async-query'),
  capabilities: videoCapabilitiesV1RefinedSchema,
  enabled: z.boolean(),
  verified: z.boolean(),
}).strict()
export const videoProfileSchema = videoProfileBaseSchema.superRefine((value, context) => {
  if (value.operations.includes('image-to-video') && !value.capabilities.supportsImageToVideo) context.addIssue({ code: 'custom', path: ['capabilities', 'supportsImageToVideo'], message: 'Profile operation requires image-to-video capability.' })
  if (value.operations.includes('text-to-video') && !value.capabilities.supportsTextToVideo) context.addIssue({ code: 'custom', path: ['capabilities', 'supportsTextToVideo'], message: 'Profile operation requires text-to-video capability.' })
})
export type VideoProfile = z.infer<typeof videoProfileSchema>

export const videoRuntimeProfileSchema = videoProfileBaseSchema.omit({ modelId: true, enabled: true, verified: true })
const videoRuntimeV1Schema = z.object({
  protocolVersion: z.literal(1),
  executionMode: z.enum(['mock', 'real']).optional(),
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
const videoRuntimeV2ProfileSchema = videoProfileBaseSchema.omit({ modelId: true, enabled: true, verified: true }).extend({
  capabilities: videoCapabilitiesV2Schema,
}).strict().superRefine((value, context) => {
  if (value.operations.includes('image-to-video') && !value.capabilities.supportsImageToVideo) context.addIssue({ code: 'custom', path: ['capabilities', 'supportsImageToVideo'], message: 'Profile operation requires image-to-video capability.' })
  if (value.operations.includes('text-to-video') && !value.capabilities.supportsTextToVideo) context.addIssue({ code: 'custom', path: ['capabilities', 'supportsTextToVideo'], message: 'Profile operation requires text-to-video capability.' })
})
const videoRuntimeV2Schema = z.object({
  protocolVersion: z.literal(2), executionMode: z.enum(['mock', 'real']).optional(), executionAvailable: z.boolean(),
  defaultProfileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(),
  tools: z.array(z.enum(['video_from_image', 'video_generate', 'video_get_job', 'video_cancel_job'])),
  profiles: z.array(videoRuntimeV2ProfileSchema).max(64),
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
const videoCapabilitiesV3Schema = videoCapabilitiesV1Schema.omit({ durationsSeconds: true, aspectRatios: true, resolutions: true, frameRates: true, outputFormats: true, supportsTaskQuery: true }).extend({
  durationsSeconds: z.array(z.number().finite().positive()).max(32),
  aspectRatios: z.array(z.string().regex(/^[1-9]\d*:[1-9]\d*$/).max(32)).max(32),
  resolutions: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)).max(32),
  frameRates: z.array(z.number().finite().positive()).max(32),
  outputFormats: z.array(z.string().regex(/^video\/[a-zA-Z0-9][a-zA-Z0-9.+-]*$/).max(96)).max(32),
  supportsTaskQuery: z.boolean(),
  audioModes: z.array(z.boolean()).max(2).optional(),
}).strict()
const videoRuntimeV3ProfileSchema = videoRuntimeProfileSchema.extend({
  capabilities: videoCapabilitiesV3Schema,
  adapterId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
  adapterVersion: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
  capabilityHints: z.object({ source: z.enum(['provider', 'adapter', 'observed', 'unknown']),
    observedAt: z.string().datetime({ offset: true }).optional(), confidence: z.enum(['verified', 'reported', 'unknown']),
  }).strict().optional(),
}).strict()
const videoRuntimeV3Schema = z.object({
  protocolVersion: z.literal(3), executionMode: z.enum(['mock', 'real', 'disabled']), executionAvailable: z.boolean(),
  defaultProfileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(),
  tools: z.array(z.enum(['video_from_image', 'video_generate', 'video_get_job', 'video_cancel_job'])).max(4),
  profiles: z.array(videoRuntimeV3ProfileSchema).max(64),
}).strict().superRefine((value, context) => {
  if (!value.executionAvailable && value.tools.length || value.executionAvailable && !value.profiles.length ||
    new Set(value.profiles.map(profile => profile.profileId)).size !== value.profiles.length ||
    value.defaultProfileId !== null && !value.profiles.some(profile => profile.profileId === value.defaultProfileId)) context.addIssue({ code: 'custom', message: 'Inconsistent video runtime authorization.' })
  for (const tool of value.tools) {
    if (tool === 'video_generate' && !value.profiles.some(profile => profile.operations.includes('text-to-video')) ||
      tool === 'video_from_image' && !value.profiles.some(profile => profile.operations.includes('image-to-video')) ||
      tool === 'video_cancel_job' && !value.profiles.some(profile => profile.capabilities.supportsCancel)) context.addIssue({ code: 'custom', path: ['tools'], message: 'Video operation is unavailable.' })
  }
})
const mediaV3HintSchema = z.object({ field: z.string().trim().min(1).max(128), values: z.array(z.union([z.string().trim().min(1).max(128), z.number().finite(), z.boolean()])).max(128), source: z.string().trim().min(1).max(256), observedAt: z.string().datetime({ offset: true }).nullable(), confidence: z.enum(['verified', 'declared', 'unknown']) }).strict()
const mediaV3AdapterSchema = z.object({ id: z.string().trim().min(1).max(128), version: z.string().trim().min(1).max(128), available: z.boolean(), reason: z.string().trim().min(1).max(128).optional(), operations: z.array(z.string().trim().min(1).max(128)).max(8), referenceSupport: z.object({ maxCount: z.number().int().nonnegative(), maxInputBytes: z.number().int().positive(), mimeTypes: z.array(z.string().trim().min(1).max(128)).max(16) }).strict(), supportsTaskQuery: z.boolean(), supportsCancel: z.boolean() }).strict()
const sepVideoRuntimeV3ProfileSchema = z.object({ profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/), configVersion: z.string().trim().min(1).max(80), kind: z.literal('video'), displayName: z.string().trim().min(1).max(80), operations: z.array(z.string().trim().min(1).max(128)).min(1).max(8), executionMode: z.enum(['sync-response', 'async-query']), authorized: z.boolean(), adapter: mediaV3AdapterSchema, capabilityHints: z.array(mediaV3HintSchema).max(32), unavailableReason: z.string().trim().min(1).max(128).optional() }).strict()
const normalizedVideoRuntimeV3ProfileSchema = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/), configVersion: z.string().trim().min(1).max(80),
  kind: z.literal('video'), displayName: z.string().trim().min(1).max(80),
  operations: z.array(videoOperationSchema).max(2), executionMode: z.literal('async-query'),
  capabilities: videoCapabilitiesV3Schema,
  adapterId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
  adapterVersion: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
  capabilityHints: z.array(mediaV3HintSchema).max(32),
}).strict()
const normalizedSepVideoRuntimeV3Schema = z.object({ protocolVersion: z.literal(3), executionMode: z.enum(['mock', 'real', 'disabled']), executionAvailable: z.boolean(), defaultProfileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).nullable(), tools: z.array(z.enum(['video_from_image', 'video_generate', 'video_get_job', 'video_cancel_job'])).max(4), profiles: z.array(sepVideoRuntimeV3ProfileSchema).max(64) }).strict().transform(runtime => ({
  ...runtime,
  profiles: runtime.profiles.map(profile => {
    const operations = profile.operations.filter(operation => profile.authorized && profile.adapter.available && profile.adapter.supportsTaskQuery && !profile.unavailableReason && profile.adapter.operations.includes(operation))
    const audioHint = profile.capabilityHints.find(hint => hint.field === 'audio')
    const audioModes = audioHint?.values.filter((value): value is boolean => typeof value === 'boolean') ?? []
    return { profileId: profile.profileId, kind: 'video' as const, displayName: profile.displayName, configVersion: profile.configVersion,
      operations: operations.filter((operation): operation is 'image-to-video' | 'text-to-video' => operation === 'image-to-video' || operation === 'text-to-video'), executionMode: 'async-query' as const,
      capabilities: { supportsTextToVideo: operations.includes('text-to-video'), supportsImageToVideo: operations.includes('image-to-video'), supportsAudio: audioModes.includes(true), durationsSeconds: [], aspectRatios: [], resolutions: [], frameRates: [], maxInputBytes: profile.adapter.referenceSupport.maxInputBytes, maxReferenceCount: profile.adapter.referenceSupport.maxCount, outputFormats: [], supportsTaskQuery: true as const, supportsCancel: profile.adapter.supportsCancel, resultRetentionSeconds: 24 * 60 * 60, ...(audioHint ? { audioModes } : {}) },
      adapterId: profile.adapter.id, adapterVersion: profile.adapter.version, capabilityHints: profile.capabilityHints,
    }
  }),
}))
const normalizedInternalVideoRuntimeV3Schema = z.object({
  protocolVersion: z.literal(3), executionMode: z.enum(['mock', 'real', 'disabled']), executionAvailable: z.boolean(),
  defaultProfileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).nullable(),
  tools: z.array(z.enum(['video_from_image', 'video_generate', 'video_get_job', 'video_cancel_job'])).max(4),
  profiles: z.array(normalizedVideoRuntimeV3ProfileSchema).max(64),
}).strict()
export const videoRuntimeSchema = z.union([videoRuntimeV1Schema, videoRuntimeV2Schema, videoRuntimeV3Schema, normalizedSepVideoRuntimeV3Schema, normalizedInternalVideoRuntimeV3Schema])
export type VideoRuntimeProfile = Omit<z.infer<typeof videoRuntimeProfileSchema>, 'capabilities'> & { capabilities: Omit<VideoCapabilities, 'resolutions' | 'outputFormats' | 'supportsTaskQuery'> & { resolutions: string[]; outputFormats: string[]; supportsTaskQuery: boolean }; adapterId?: string; adapterVersion?: string; capabilityHints?: z.infer<typeof mediaV3HintSchema>[] | z.infer<typeof videoRuntimeV3ProfileSchema>['capabilityHints'] }
export interface VideoRuntime {
  protocolVersion: 1 | 2 | 3
  executionMode?: 'mock' | 'real' | 'disabled'
  executionAvailable: boolean
  defaultProfileId: string | null
  tools: Array<'video_from_image' | 'video_generate' | 'video_get_job' | 'video_cancel_job'>
  profiles: VideoRuntimeProfile[]
}

export function videoAllowedAudioModes(runtime: Pick<VideoRuntime, 'protocolVersion' | 'executionMode'>,
  profile: { capabilities: Pick<VideoCapabilities, 'supportsAudio'> & { audioModes?: boolean[] } }): boolean[] {
  if (runtime.protocolVersion === 2 || runtime.protocolVersion === 3) return profile.capabilities.audioModes ? [...new Set(profile.capabilities.audioModes)] : []
  if (runtime.executionMode === 'real') return [true]
  return profile.capabilities.supportsAudio ? [false, true] : [false]
}

const videoRequestBaseSchema = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  configVersion: z.string().trim().min(1).max(128).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  operation: videoOperationSchema,
  referenceIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).max(4),
  creativeBrief: z.string().trim().min(1).max(4000),
  parameters: videoRequestedSpecSchema,
  protocolVersion: z.literal(3).optional(),
  requestedSpec: videoRequestedSpecSchema.optional(),
  parameterSources: mediaSpecMetadataSchema.shape.parameterSources.optional(),
  specRevision: mediaSpecMetadataSchema.shape.specRevision.optional(),
}).strict()
function refineVideoRequest(value: z.infer<typeof videoRequestBaseSchema>, context: z.RefinementCtx): void {
  if (value.protocolVersion === 3) {
    if (!value.requestedSpec || !value.parameterSources || value.specRevision === undefined || !mediaSpecsEqual(value.parameters, value.requestedSpec)) context.addIssue({ code: 'custom', path: ['requestedSpec'], message: 'Versioned video specifications must match the frozen parameters.' })
    if (value.parameterSources && Object.keys(value.parameterSources).some(key => value.requestedSpec?.[key as keyof typeof value.requestedSpec] === undefined)) context.addIssue({ code: 'custom', path: ['parameterSources'], message: 'Specification sources must describe present video fields.' })
  } else if (!videoParametersSchema.safeParse(value.parameters).success || value.requestedSpec !== undefined || value.parameterSources !== undefined || value.specRevision !== undefined) {
    context.addIssue({ code: 'custom', path: ['parameters'], message: 'Legacy requests require complete legacy specifications.' })
  }
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
  mimeType: z.string().max(96).regex(/^video\/[a-zA-Z0-9][a-zA-Z0-9.+-]*$/),
  byteLength: z.number().int().positive().max(256 * 1024 * 1024),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  durationSeconds: z.number().finite().positive(),
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  frameRate: z.number().finite().positive(),
  thumbnailOutputId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict()
export type VideoOutput = z.infer<typeof videoOutputSchema>

const videoReceiptBaseSchema = z.object({
  receiptId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  clientRequestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  configVersion: z.string().trim().min(1).max(128).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  operation: videoOperationSchema,
  status: z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED', 'SUBMISSION_UNKNOWN']),
  pollAfterMs: z.number().int().nonnegative().nullable(),
  outputs: z.array(videoOutputSchema).max(4),
  errorCode: z.string().nullable(),
  recovery: z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict(),
  protocolVersion: z.literal(3).optional(),
  specRevision: mediaSpecMetadataSchema.shape.specRevision.optional(),
  actualSpec: z.union([videoActualSpecSchema, z.object({
    durationSeconds: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
    frameRate: z.number().positive(), mimeType: z.string().min(1).max(128), hasAudio: z.boolean().nullable(),
    source: z.literal('measured'),
  }).strict()]).optional(),
  effectiveSpec: videoRequestedSpecSchema.optional(),
  acceptance: z.enum(['matched', 'mismatched', 'unknown']).optional(),
  semanticHashVersion: z.literal(3).optional(),
  billingDimensions: z.object({
    model: z.string().min(1).max(160), operation: videoOperationSchema,
    durationSeconds: z.number().int().positive(), resolution: z.string().min(1).max(64),
  }).strict().optional(),
  deliveryStatus: z.enum(['matched', 'mismatched', 'unknown']).optional(),
}).strict()
const decimalCny = z.string().regex(/^\d+\.\d{6}$/)
const decimalUsd = z.string().regex(/^\d+(?:\.\d{1,12})?$/)
export const videoRealBillingStatusSchema = z.enum(['NOT_RESERVED', 'RESERVED', 'SETTLED', 'RELEASED', 'RECONCILING'])
export const videoBillingStatusSchema = z.union([z.literal('MOCK_NOT_CHARGED'), videoRealBillingStatusSchema])
export const videoMockReceiptSchema = videoReceiptBaseSchema.extend({ mock: z.literal(true), billingStatus: z.literal('MOCK_NOT_CHARGED') }).strict()
export const videoRealReceiptSchema = videoReceiptBaseSchema.extend({
  mock: z.literal(false), billingStatus: videoRealBillingStatusSchema,
  amountCny: decimalCny.optional(), actualCostCny: decimalCny.optional(), amountUsd: decimalUsd.optional(),
}).strict()
export const videoReceiptSchema = z.discriminatedUnion('mock', [videoMockReceiptSchema, videoRealReceiptSchema]).superRefine((value, context) => {
  const delivered = value.status === 'SUCCEEDED' || value.status === 'PARTIAL_SUCCEEDED'
  const terminal = delivered || ['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(value.status)
  const billingPending = !value.mock && videoBillingPending(value.billingStatus)
  if (new Set(value.outputs.map(output => output.outputId)).size !== value.outputs.length || delivered && value.outputs.length === 0 || value.recovery.canDownload && !delivered ||
    terminal && (value.pollAfterMs !== null || value.recovery.canQuery !== billingPending) ||
    !value.mock && (!terminal && !value.recovery.canQuery || value.recovery.canCancel)) {
    context.addIssue({ code: 'custom', message: 'Inconsistent video receipt state.' })
  }
  if (value.acceptance !== undefined && value.deliveryStatus !== undefined && value.acceptance !== value.deliveryStatus) context.addIssue({ code: 'custom', message: 'Receipt acceptance does not match delivery status.' })
})
export type VideoReceipt = z.infer<typeof videoReceiptSchema>

export function videoBillingPending(status: VideoReceipt['billingStatus']): boolean {
  return status === 'RESERVED' || status === 'RECONCILING'
}

export interface VideoQuote {
  quoteId: string
  requestHash: string
  expiresAt: number
  status: 'quoted' | 'unavailable'
  amount: string | null
  currency: string | null
  amountUsd?: string
  pricingVersion?: string
  usdToCnyRate?: number
  funding?: { creditCny: string; memberWalletCny: string; personalCny: string }
  protocolVersion?: 3
  specRevision?: number
  effectiveSpec?: VideoRequestedSpec
}

export interface VideoGatewayPort {
  quote(request: z.infer<typeof videoRequestSchema>, signal: AbortSignal): Promise<VideoQuote>
  submit(request: VideoRequest, signal: AbortSignal): Promise<VideoReceipt>
  findReceipt(clientRequestId: string, signal: AbortSignal): Promise<VideoReceipt | null>
  getReceipt(receiptId: string, signal: AbortSignal): Promise<VideoReceipt>
  content(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
}


export const videoMockQuoteResponseSchema = z.object({
  mock: z.literal(true),
  quoteId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expiresAt: z.string().datetime({ offset: true }),
  semanticSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  pricingStatus: z.literal('quoted'),
  amountCny: z.literal('0.000000'),
  pricingVersion: z.literal('mock-video-v1'),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
}).strict()
export const videoRealQuoteResponseSchema = videoMockQuoteResponseSchema.omit({ mock: true, amountCny: true, pricingVersion: true, billingStatus: true }).extend({
  mock: z.literal(false), amountCny: decimalCny, amountUsd: decimalUsd, pricingVersion: z.string().min(1).max(128),
  usdToCnyRate: z.number().finite().positive(), funding: z.object({ creditCny: decimalCny, memberWalletCny: decimalCny, personalCny: decimalCny }).strict(),
  billingStatus: z.literal('NOT_RESERVED'),
  protocolVersion: z.literal(3).optional(), semanticHashVersion: z.literal(3).optional(), specRevision: mediaSpecMetadataSchema.shape.specRevision.optional(), effectiveSpec: videoRequestedSpecSchema.optional(),
  billingDimensions: z.object({
    model: z.string().min(1).max(160), operation: videoOperationSchema,
    durationSeconds: z.number().int().positive(), resolution: z.string().min(1).max(64),
  }).strict().optional(),
}).strict()
export const videoQuoteResponseSchema = z.discriminatedUnion('mock', [videoMockQuoteResponseSchema, videoRealQuoteResponseSchema])

export const videoMockReferenceSchema = z.object({
  mock: z.literal(true),
  referenceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expiresAt: z.string().datetime({ offset: true }),
  mimeType: z.literal('image/png'),
  byteLength: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
}).strict()
export const videoRealReferenceSchema = videoMockReferenceSchema.extend({ mock: z.literal(false) }).strict()
export const videoReferenceSchema = z.discriminatedUnion('mock', [videoMockReferenceSchema, videoRealReferenceSchema])

export const videoMockProfilesResponseSchema = z.object({
  mock: z.literal(true),
  protocolVersion: z.literal(1),
  persistence: z.enum(['memory', 'database']),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
  profiles: z.array(videoRuntimeProfileSchema).min(1).max(64),
}).strict()
export const videoRealProfilesResponseSchema = videoMockProfilesResponseSchema.extend({
  mock: z.literal(false), persistence: z.literal('database'), billingStatus: z.literal('NOT_RESERVED'),
}).strict()
export const videoProfilesResponseSchema = z.discriminatedUnion('mock', [videoMockProfilesResponseSchema, videoRealProfilesResponseSchema])

/** Unknown containers remain opaque exports and never acquire an executable extension. */
export function videoOutputExtension(mime: string): string {
  return ({ 'video/mp4': 'mp4', 'video/webm': 'webm' } as Record<string, string>)[mime] ?? 'bin'
}
