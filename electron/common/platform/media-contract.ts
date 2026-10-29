import { z } from 'zod'
import { imageRequestedSpecSchema, mediaParameterSourcesSchema, mediaSpecsEqual, omitUndefinedMediaFields } from '../../../src/shared/media-spec-contract'
import type { MediaCapabilities, MediaGenerationInput } from '../../../src/shared/media'
import { toLocalMediaCapabilities } from './sep-media-runtime-contract'
import { AppError } from '../../errors/app-error'

export const mediaId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const opaqueId = z.string().min(1).max(256)
export const imageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])
export const mediaParametersSchema = z.object({
  aspectRatio: z.string().min(1).max(32), count: z.number().int().min(1).max(16),
  size: z.string().min(1).max(64).optional(), quality: z.string().min(1).max(64).optional(),
}).strict()
export const mediaGenerationInputSchema = z.object({
  profileId: opaqueId, operation: z.enum(['generate', 'edit']),
  localAssetIds: z.array(mediaId).max(16), creativeBrief: z.string().trim().min(1).max(20_000),
  parameters: z.union([mediaParametersSchema, imageRequestedSpecSchema]),
  protocolVersion: z.literal(3).optional(), requestedSpec: imageRequestedSpecSchema.optional(),
  parameterSources: mediaParameterSourcesSchema.optional(), specRevision: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (value.protocolVersion === 3) {
    if (!value.requestedSpec || !value.parameterSources || !value.specRevision) context.addIssue({ code: 'custom', message: 'V3 specification metadata is required.' })
    else if (!mediaSpecsEqual(value.parameters, value.requestedSpec)) context.addIssue({ code: 'custom', path: ['parameters'], message: 'Parameters conflict with requested specification.' })
    else if (Object.keys(value.parameterSources).some(key => value.requestedSpec![key as keyof typeof value.requestedSpec] === undefined)
      || Object.entries(value.requestedSpec).some(([key, item]) => item !== undefined && value.parameterSources![key as keyof typeof value.parameterSources] === undefined)) {
      context.addIssue({ code: 'custom', path: ['parameterSources'], message: 'Every specified field must have exactly one source.' })
    }
  } else if (!mediaParametersSchema.safeParse(value.parameters).success || value.requestedSpec !== undefined || value.parameterSources !== undefined || value.specRevision !== undefined) {
    context.addIssue({ code: 'custom', message: 'Invalid legacy specification.' })
  }
}).transform(value => value.protocolVersion === 3 ? {
  ...value, parameters: omitUndefinedMediaFields(value.parameters), requestedSpec: omitUndefinedMediaFields(value.requestedSpec!),
  parameterSources: omitUndefinedMediaFields(value.parameterSources!),
} : value)
export const mediaProfileSchema = z.object({
  profileId: opaqueId, kind: z.literal('image'), displayName: z.string().min(1).max(200),
  configVersion: opaqueId, operations: z.array(z.enum(['generate', 'edit'])).min(1).max(2),
  executionMode: z.enum(['async-query', 'sync-response']),
  capabilities: z.object({ referenceImage: z.boolean(), cancel: z.boolean(), recoverByRequestId: z.boolean() }).strict(),
  allowedAspectRatios: z.array(z.string().min(1).max(32)).max(32),
  allowedSizes: z.array(z.string().min(1).max(64)).max(32).optional(),
  allowedQualities: z.array(z.string().min(1).max(64)).max(32).optional(),
  defaultSize: z.string().min(1).max(64).optional(),
  defaultQuality: z.string().min(1).max(64).optional(),
  maxCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  maxCountSource: z.literal('local-output-safety').optional(),
}).strict().superRefine((profile, context) => {
  if (profile.defaultSize !== undefined && !profile.allowedSizes?.includes(profile.defaultSize)) context.addIssue({ code: 'custom', path: ['defaultSize'], message: 'Default size must be allowed.' })
  if (profile.defaultQuality !== undefined && !profile.allowedQualities?.includes(profile.defaultQuality)) context.addIssue({ code: 'custom', path: ['defaultQuality'], message: 'Default quality must be allowed.' })
})
export const mediaCapabilitiesSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(3)]),
  defaultProfileId: opaqueId.nullable().optional(),
  tools: z.array(z.enum(['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'])).max(4),
  profiles: z.array(mediaProfileSchema).max(64),
}).strict()
export const mediaOutputSchema = z.object({
  outputId: opaqueId, mime: imageMimeSchema,
  size: z.number().int().positive().max(32 * 1024 * 1024).nullable(),
  width: z.number().int().positive().max(32_768).nullable(), height: z.number().int().positive().max(32_768).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), expiresAt: z.number().int().nonnegative().nullable(),
}).strict()
export const mediaRecoverySchema = z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict()
export const mediaOutputErrorsSchema = z.array(z.object({ index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), code: mediaId }).strict())
export const mediaReceiptSchema = z.object({
  receiptId: opaqueId, clientRequestId: mediaId, profileId: opaqueId, configVersion: opaqueId,
  status: z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']),
  pollAfterMs: z.number().int().nonnegative().max(86_400_000).nullable(), outputs: z.array(mediaOutputSchema),
  actualSpec: imageRequestedSpecSchema.optional(),
  billingStatus: z.string().min(1).max(64),
  recovery: mediaRecoverySchema.optional(), errorCode: mediaId.nullable().optional(), outputErrors: mediaOutputErrorsSchema.optional(),
}).strict()

/** Internal port format; HTTP adapters must validate and translate their wire contracts. */
export const mediaQuoteSchema = z.object({
  effectiveSpec: imageRequestedSpecSchema.optional(),
  quoteId: opaqueId, requestHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive(),
  status: z.enum(['quoted', 'unavailable']), amount: z.string().regex(/^\d+(?:\.\d+)?$/).max(100).nullable(),
  currency: z.string().min(1).max(32).nullable(), authorized: z.boolean(), budgetAuthorized: z.boolean(), allowUnknownCost: z.boolean(),
}).strict().refine(value => value.status !== 'quoted' || (value.amount !== null && value.currency !== null), 'A quoted price requires an amount and currency.')

export function parseMediaCapabilities(value: unknown): MediaCapabilities {
  if (typeof value === 'object' && value !== null && 'executionAvailable' in value) {
    return toLocalMediaCapabilities(value)
  }
  if (typeof value === 'object' && value !== null && 'mock' in value) {
    return toLocalMediaCapabilities(value)
  }
  return mediaCapabilitiesSchema.parse(value)
}

export function parseMediaInput(value: unknown): MediaGenerationInput {
  if (typeof value === 'object' && value !== null && 'parameters' in value && typeof value.parameters === 'object' && value.parameters !== null
    && (!('protocolVersion' in value) || value.protocolVersion !== 3)) {
    for (const field of ['aspectRatio', 'count'] as const) {
      if (!(field in value.parameters)) throw new AppError('MISSING_SPEC', { details: { field } })
    }
  }
  return mediaGenerationInputSchema.parse(value)
}
