import { z } from 'zod'

const label = z.string().trim().min(1).max(128).regex(/^[^\p{Cc}\p{Cf}]+$/u)
const profileId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(80)
const operation = z.enum(['generate', 'edit', 'text-to-video', 'image-to-video', 'video-to-video'])
const operations = z.array(operation).min(1).max(5)
const option = z.union([z.string().min(1).max(160), z.number().finite(), z.boolean()])
const mimeTypes = z.array(label).max(16)
const limit = z.number().int().nonnegative()

const parameter = z.object({
  label: z.string().min(1).max(80), type: z.enum(['string', 'integer', 'number', 'boolean']),
  support: z.enum(['supported', 'unsupported', 'unknown']), required: z.boolean(), operations,
  valuesMode: z.enum(['allowed', 'suggested', 'unknown']), values: z.array(option).min(1).max(128).optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), step: z.number().positive().optional(),
  default: option.optional(), unit: z.enum(['seconds', 'pixels', 'images']).optional(),
  source: z.enum(['profile-config', 'adapter', 'platform-policy', 'provider']),
  confidence: z.enum(['verified', 'declared', 'unknown']), observedAt: z.string().datetime({ offset: true }).nullable(),
}).strict()

const rule = { operations, code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(96), message: z.string().min(1).max(256) }
export const sepRuntimeV3ProfileMetadata = {
  modelId: z.string().min(1).max(160), modelDisplayName: z.string().min(1).max(160),
  parameters: z.record(field, parameter).refine(value => Object.keys(value).length <= 32),
  constraints: z.array(z.discriminatedUnion('type', [
    z.object({ ...rule, type: z.literal('requiredTogether'), fields: z.array(field).min(2).max(8) }).strict(),
    z.object({ ...rule, type: z.literal('requireAny'), alternatives: z.array(z.array(field).min(1).max(8)).min(2).max(8) }).strict(),
    z.object({ ...rule, type: z.literal('whenAllowed'), when: z.object({ field, equals: option }).strict(),
      field, values: z.array(option).min(1).max(128) }).strict(),
  ])).max(32),
  referenceRules: z.array(z.object({ operation, minCount: limit, maxCount: limit, maxInputBytes: limit, mimeTypes }).strict()).max(5),
  videoReferenceRules: z.array(z.object({ operation, minCount: limit, maxCount: limit, maxInputBytes: limit, mimeTypes }).strict()).max(5).optional(),
}
const metadataSchema = z.object(sepRuntimeV3ProfileMetadata)
export type SepRuntimeV3ProfileMetadata = z.infer<typeof metadataSchema>

const adapterSchema = z.object({
  id: label, version: label, available: z.boolean(), reason: label.optional(),
  operations: z.array(label).max(8), supportsTaskQuery: z.boolean(), supportsCancel: z.boolean(),
  referenceSupport: z.object({ maxCount: limit, maxInputBytes: limit, mimeTypes }).strict(),
  videoReferenceSupport: z.object({ maxCount: limit, maxInputBytes: limit, mimeTypes }).strict().optional(),
}).strict()

const wireProfile = metadataSchema.extend({
  profileId, kind: z.enum(['image', 'video']), configVersion: label.max(80), displayName: z.string().trim().min(1).max(80),
  operations: z.array(operation).max(5), executionMode: z.enum(['sync-response', 'async-query']), authorized: z.boolean(),
  adapter: adapterSchema, unavailableReason: label.nullable(), unavailableMessage: z.string().min(1).max(256).nullable(),
}).strict().superRefine((profile, ctx) => {
  const issue = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: 'Inconsistent media profile.' })
  if ((profile.unavailableReason === null) !== (profile.unavailableMessage === null)
    || profile.adapter.available !== (profile.unavailableReason === null)) issue('unavailableReason')
  const rules = profile.referenceRules
  const caps = profile.adapter.referenceSupport
  if (new Set(rules.map(entry => entry.operation)).size !== rules.length
    || profile.operations.some(op => !rules.some(entry => entry.operation === op))
    || rules.some(entry => !profile.operations.includes(entry.operation) || entry.minCount > entry.maxCount
      || entry.maxCount > caps.maxCount || entry.maxInputBytes > caps.maxInputBytes
      || entry.mimeTypes.some(mime => !caps.mimeTypes.includes(mime))
      || (entry.maxCount > 0 ? !entry.maxInputBytes || !entry.mimeTypes.length : !!entry.maxInputBytes || !!entry.mimeTypes.length))) issue('referenceRules')
  const videoRules = profile.videoReferenceRules
  const videoCaps = profile.adapter.videoReferenceSupport
  if (profile.operations.includes('video-to-video') && (!videoCaps || !videoRules?.some(rule => rule.operation === 'video-to-video' && rule.minCount >= 1))) issue('videoReferenceRules')
  if (videoRules && (!videoCaps || new Set(videoRules.map(rule => rule.operation)).size !== videoRules.length
    || profile.operations.some(op => !videoRules.some(rule => rule.operation === op))
    || videoRules.some(rule => !profile.operations.includes(rule.operation) || rule.minCount > rule.maxCount
      || rule.maxCount > videoCaps.maxCount || rule.maxInputBytes > videoCaps.maxInputBytes
      || rule.mimeTypes.some(mime => !videoCaps.mimeTypes.includes(mime))
      || (rule.operation !== 'video-to-video' && rule.maxCount !== 0)
      || (rule.maxCount > 0 ? !rule.maxInputBytes || !rule.mimeTypes.length : !!rule.maxInputBytes || !!rule.mimeTypes.length)))) issue('videoReferenceRules')
  if (rules.some(rule => rule.operation === 'video-to-video' && rule.maxCount !== 0)) issue('referenceRules')
})

export function sepRuntimeV3Schema(kind: 'image' | 'video') {
  return z.object({
    protocolVersion: z.literal(3), executionMode: z.enum(['real', 'disabled', 'mock']),
    status: z.enum(['ready', 'empty', 'disabled', 'unavailable']), executionAvailable: z.boolean(),
    defaultProfileId: profileId.nullable(), tools: z.array(label).max(8), profiles: z.array(wireProfile).max(64),
  }).strict().superRefine((runtime, ctx) => {
    const issue = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: 'Inconsistent media runtime.' })
    const supported = kind === 'image' ? ['generate', 'edit'] : ['text-to-video', 'image-to-video', 'video-to-video']
    const executable = runtime.profiles.filter(p => p.authorized && p.adapter.available
      && p.operations.some(op => supported.includes(op) && p.adapter.operations.includes(op)))
    if (new Set(runtime.profiles.map(p => p.profileId)).size !== runtime.profiles.length
      || runtime.profiles.some(p => p.kind !== kind || p.operations.some(op => !supported.includes(op)))) issue('profiles')
    if (runtime.executionAvailable !== (runtime.executionMode === 'real' && executable.length > 0)
      || runtime.executionAvailable !== (runtime.status === 'ready')) issue('executionAvailable')
    if (!runtime.executionAvailable && runtime.tools.length) issue('tools')
    if (runtime.defaultProfileId !== null && !executable.some(p => p.profileId === runtime.defaultProfileId)) issue('defaultProfileId')
  })
}

export function readSepRuntimeV3Metadata(profile: SepRuntimeV3ProfileMetadata): SepRuntimeV3ProfileMetadata {
  const { modelId, modelDisplayName, parameters, constraints, referenceRules, videoReferenceRules } = profile
  return { modelId, modelDisplayName, parameters, constraints, referenceRules, ...(videoReferenceRules ? { videoReferenceRules } : {}) }
}
