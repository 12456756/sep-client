import { z } from 'zod'
import type { MediaCapabilities } from '../../../src/shared/media'
import { imageAspectRatio } from '../../../src/shared/media-spec'


// Mirrors SEP backend/src/shared/media.dto.ts configuration-stage runtime v1.
const sepMediaRuntimeProfileSchema = z.object({
  profileId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  kind: z.literal('image'),
  displayName: z.string().trim().min(1).max(80),
  configVersion: z.string().trim().min(1).max(80),
  operations: z.array(z.enum(['generate', 'edit'])).min(1).max(2),
  executionMode: z.enum(['async-query', 'sync-response']),
  capabilities: z.object({
    supportsReferenceImage: z.boolean().default(false),
    maxOutputs: z.number().int().min(1).max(8).default(1),
    sizes: z.array(z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/)).min(1).max(32),
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
  }).strict(),
}).strict()

const sepMediaRuntimeV2ProfileSchema = sepMediaRuntimeProfileSchema.extend({
  capabilities: sepMediaRuntimeProfileSchema.shape.capabilities.extend({
    qualities: z.array(z.enum(['low', 'medium', 'high'])).min(1).max(3),
    defaultQuality: z.enum(['low', 'medium', 'high']),
    defaultSize: z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/),
  }).strict().superRefine((capabilities, context) => {
    if (!capabilities.qualities.includes(capabilities.defaultQuality)) context.addIssue({ code: 'custom', path: ['defaultQuality'], message: 'Default image quality must be available.' })
    if (!capabilities.sizes.includes(capabilities.defaultSize)) context.addIssue({ code: 'custom', path: ['defaultSize'], message: 'Default image size must be available.' })
  }),
}).strict()

const realMediaRuntimeSchema = z.object({
  mock: z.literal(false), protocolVersion: z.literal(1), persistence: z.literal('database'),
  tools: z.array(z.enum(['image_generate', 'image_edit'])).min(1).max(2),
  profiles: z.array(sepMediaRuntimeProfileSchema).max(64),
}).strict().refine(value => new Set(value.tools).size === value.tools.length)

const executableEmployeeMediaRuntimeSchema = z.object({
  protocolVersion: z.literal(1), executionAvailable: z.literal(true), defaultProfileId: z.string().nullable(),
  tools: z.array(z.enum(['image_generate', 'image_edit'])).min(1).max(2), profiles: z.array(sepMediaRuntimeProfileSchema).max(64),
}).strict().refine(value => new Set(value.tools).size === value.tools.length)

const configurationMediaRuntimeSchema = z.object({
  protocolVersion: z.literal(1),
  executionAvailable: z.boolean(),
  defaultProfileId: z.string().nullable(),
  tools: z.array(z.string()),
  profiles: z.array(sepMediaRuntimeProfileSchema),
}).strict().refine(value => !value.executionAvailable && value.tools.length === 0,
  'Only the implemented configuration-stage SEP media contract is supported.')

const executableEmployeeMediaRuntimeV2Schema = z.object({
  protocolVersion: z.literal(2), executionAvailable: z.boolean(), defaultProfileId: z.string().nullable(),
  tools: z.array(z.enum(['image_generate', 'image_edit'])).max(2), profiles: z.array(sepMediaRuntimeV2ProfileSchema).max(64),
}).strict().superRefine((value, context) => {
  if (!value.executionAvailable && value.tools.length > 0) context.addIssue({ code: 'custom', path: ['tools'], message: 'Disabled runtime cannot expose tools.' })
  if (value.defaultProfileId !== null && !value.profiles.some(profile => profile.profileId === value.defaultProfileId)) context.addIssue({ code: 'custom', path: ['defaultProfileId'], message: 'Default profile is unavailable.' })
  for (const profile of value.profiles) {
    if (profile.operations.includes('edit') && !profile.capabilities.supportsReferenceImage) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Edit operation requires reference-image support.' })
  }
})

const mediaProfileIdV3 = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
const mediaLabelV3 = z.string().trim().min(1).max(128).regex(/^[^\p{Cc}\p{Cf}]+$/u)
const mediaCapabilityHintV3 = z.object({ field: mediaLabelV3, values: z.array(z.union([mediaLabelV3, z.number().finite(), z.boolean()])).max(128), source: mediaLabelV3.max(256), observedAt: z.string().datetime({ offset: true }).nullable(), confidence: z.enum(['verified', 'declared', 'unknown']) }).strict()
const mediaAdapterV3 = z.object({ id: mediaLabelV3, version: mediaLabelV3, available: z.boolean(), reason: mediaLabelV3.optional(), operations: z.array(mediaLabelV3).max(8), referenceSupport: z.object({ maxCount: z.number().int().nonnegative().safe(), maxInputBytes: z.number().int().positive().safe(), mimeTypes: z.array(mediaLabelV3).max(16) }).strict(), supportsTaskQuery: z.boolean(), supportsCancel: z.boolean() }).strict()
const sepMediaRuntimeV3ProfileSchema = z.object({ profileId: mediaProfileIdV3, kind: z.literal('image'), displayName: z.string().trim().min(1).max(80), configVersion: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u), operations: z.array(mediaLabelV3).min(1).max(8), executionMode: z.enum(['sync-response', 'async-query']), authorized: z.boolean(), adapter: mediaAdapterV3, capabilityHints: z.array(mediaCapabilityHintV3).max(32), unavailableReason: mediaLabelV3.optional() }).strict()
const legacyMediaRuntimeV3ProfileSchema = sepMediaRuntimeProfileSchema.extend({ capabilities: z.object({ supportsReferenceImage: z.boolean(), sizes: z.array(z.string()).optional(), maxOutputs: z.number().int().positive().optional(), qualities: z.array(z.string()).optional(), maxWidth: z.number().int().positive().optional(), maxHeight: z.number().int().positive().optional() }).strict() }).strict()
const legacyExecutableEmployeeMediaRuntimeV3Schema = z.object({ protocolVersion: z.literal(3), executionAvailable: z.boolean(), defaultProfileId: z.string().nullable(), tools: z.array(z.enum(['image_generate', 'image_edit'])).max(2), profiles: z.array(legacyMediaRuntimeV3ProfileSchema).max(64) }).strict().superRefine((value, context) => {
  if (!value.executionAvailable && value.tools.length) context.addIssue({ code: 'custom', path: ['tools'], message: 'Disabled runtime cannot expose tools.' })
  if (value.defaultProfileId !== null && !value.profiles.some(profile => profile.profileId === value.defaultProfileId)) context.addIssue({ code: 'custom', path: ['defaultProfileId'], message: 'Default profile is unavailable.' })
})
const executableEmployeeMediaRuntimeV3Schema = z.object({ protocolVersion: z.literal(3), executionMode: z.enum(['real', 'disabled', 'mock']), executionAvailable: z.boolean(), defaultProfileId: mediaProfileIdV3.nullable(), tools: z.array(mediaLabelV3).max(8), profiles: z.array(sepMediaRuntimeV3ProfileSchema).max(64) }).strict().superRefine((value, context) => {
  if (!value.executionAvailable && value.tools.length) context.addIssue({ code: 'custom', path: ['tools'], message: 'Disabled runtime cannot expose tools.' })
  if (new Set(value.profiles.map(profile => profile.profileId)).size !== value.profiles.length) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Duplicate profiles.' })
  if (value.defaultProfileId !== null && !value.profiles.some(profile => profile.profileId === value.defaultProfileId)) context.addIssue({ code: 'custom', path: ['defaultProfileId'], message: 'Default profile is unavailable.' })
  const executable = value.profiles.some(profile => profile.authorized && profile.adapter.available && !profile.unavailableReason && profile.operations.some(operation => profile.adapter.operations.includes(operation)))
  if (value.executionAvailable && (value.executionMode !== 'real' || !executable)) context.addIssue({ code: 'custom', path: ['executionAvailable'], message: 'Missing executable authorized adapter.' })
})

export const sepMediaRuntimeSchema = z.union([realMediaRuntimeSchema, executableEmployeeMediaRuntimeSchema, configurationMediaRuntimeSchema, executableEmployeeMediaRuntimeV2Schema, executableEmployeeMediaRuntimeV3Schema, legacyExecutableEmployeeMediaRuntimeV3Schema])

export function toLocalMediaCapabilities(value: unknown): MediaCapabilities {
  const runtime = parseSepMediaRuntime(value)
  if (runtime.protocolVersion === 3) {
    if (runtime.profiles.length === 0 || 'capabilities' in runtime.profiles[0]!) {
      const legacyRuntime = runtime as z.infer<typeof legacyExecutableEmployeeMediaRuntimeV3Schema>
      const profiles: MediaCapabilities['profiles'] = legacyRuntime.profiles.map(profile => ({
        profileId: profile.profileId, kind: 'image' as const, displayName: profile.displayName, configVersion: profile.configVersion,
        operations: profile.operations.filter(operation => legacyRuntime.tools.includes(operation === 'edit' ? 'image_edit' : 'image_generate')) as Array<'generate' | 'edit'>,
        executionMode: profile.executionMode, capabilities: { referenceImage: profile.capabilities.supportsReferenceImage, cancel: true, recoverByRequestId: true }, allowedAspectRatios: [],
        ...(profile.capabilities.sizes !== undefined ? { allowedSizes: profile.capabilities.sizes } : {}), ...(profile.capabilities.qualities !== undefined ? { allowedQualities: profile.capabilities.qualities } : {}),
      })).filter(profile => profile.operations.length > 0)
      return { protocolVersion: 3, defaultProfileId: profiles.some(profile => profile.profileId === legacyRuntime.defaultProfileId) ? legacyRuntime.defaultProfileId : null, tools: legacyRuntime.executionAvailable && profiles.length ? ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'] : [], profiles }
    }
    const v3Runtime = runtime as z.infer<typeof executableEmployeeMediaRuntimeV3Schema>
    const profiles: MediaCapabilities['profiles'] = v3Runtime.profiles.map(profile => ({
      profileId: profile.profileId, kind: 'image' as const, displayName: profile.displayName, configVersion: profile.configVersion,
      operations: profile.operations.filter((operation): operation is 'generate' | 'edit' =>
        (operation === 'generate' || operation === 'edit')
        && v3Runtime.tools.includes(operation === 'edit' ? 'image_edit' : 'image_generate')
        && profile.authorized && profile.adapter.available && !profile.unavailableReason && profile.adapter.operations.includes(operation)),
      executionMode: profile.executionMode,
      capabilities: { referenceImage: profile.adapter.referenceSupport.maxCount > 0, cancel: profile.adapter.supportsCancel, recoverByRequestId: profile.adapter.supportsTaskQuery },
      allowedAspectRatios: [],
      adapter: profile.adapter, authorized: profile.authorized, ...(profile.unavailableReason ? { unavailableReason: profile.unavailableReason } : {}), capabilityHints: profile.capabilityHints,
    })).filter(profile => profile.operations.length > 0)
    return {
      protocolVersion: 3, defaultProfileId: profiles.some(profile => profile.profileId === v3Runtime.defaultProfileId) ? v3Runtime.defaultProfileId : null,
      tools: v3Runtime.executionAvailable && profiles.length ? ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'] : [],
      profiles,
    }
  }
  if ('mock' in runtime || runtime.executionAvailable) return {
    protocolVersion: 1 as const,
    ...('defaultProfileId' in runtime ? { defaultProfileId: runtime.defaultProfileId } : {}),
    tools: ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'],
    profiles: runtime.profiles.map(profile => ({
      profileId: profile.profileId, kind: 'image' as const, displayName: profile.displayName,
      configVersion: profile.configVersion, operations: profile.operations, executionMode: profile.executionMode,
      capabilities: { referenceImage: profile.capabilities.supportsReferenceImage, cancel: true, recoverByRequestId: true },
      allowedAspectRatios: profile.capabilities.sizes.map(size => imageAspectRatio(size)!).filter(Boolean),
      // The local gateway receipt and output-error contracts currently cap a request at four.
      allowedSizes: profile.capabilities.sizes, maxCount: Math.min(4, profile.capabilities.maxOutputs),
      ...('qualities' in profile.capabilities ? { allowedQualities: profile.capabilities.qualities, defaultQuality: profile.capabilities.defaultQuality, defaultSize: profile.capabilities.defaultSize } : {}),
    })),
  }
  return { protocolVersion: 1 as const, tools: [] as const, profiles: [] as const }
}

export function parseSepMediaRuntime(value: unknown): z.infer<typeof sepMediaRuntimeSchema> {
  const result = sepMediaRuntimeSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid or unsupported SEP media runtime.')
  return result.data
}

export function resolveSepRealMediaSize(parameters: { aspectRatio: string; size?: string }): string {
  const defaults: Record<string, string> = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' }
  if (parameters.size !== undefined) {
    if (imageAspectRatio(parameters.size) !== parameters.aspectRatio) throw new Error('Image size and aspect ratio do not match.')
    return parameters.size
  }
  const size = defaults[parameters.aspectRatio]
  if (!size) throw new Error('Image aspect ratio is unsupported.')
  return size
}
