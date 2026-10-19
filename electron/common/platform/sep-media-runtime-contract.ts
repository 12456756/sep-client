import { z } from 'zod'
import type { MediaCapabilities } from '../../../src/shared/media'

export function resolveSepRealMediaSize(parameters: { aspectRatio: string; size?: string }): string {
  return parameters.size ?? (parameters.aspectRatio === '3:2' ? '1536x1024' : parameters.aspectRatio === '2:3' ? '1024x1536' : '1024x1024')
}

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

export const sepMediaRuntimeSchema = z.union([realMediaRuntimeSchema, executableEmployeeMediaRuntimeSchema, configurationMediaRuntimeSchema])

export function toLocalMediaCapabilities(value: unknown): MediaCapabilities {
  const runtime = parseSepMediaRuntime(value)
  if ('mock' in runtime || runtime.executionAvailable) return {
    protocolVersion: 1 as const,
    tools: ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'],
    profiles: runtime.profiles.map(profile => ({
      profileId: profile.profileId, kind: 'image' as const, displayName: profile.displayName,
      configVersion: profile.configVersion, operations: profile.operations, executionMode: profile.executionMode,
      capabilities: { referenceImage: profile.capabilities.supportsReferenceImage, cancel: true, recoverByRequestId: true },
      allowedAspectRatios: profile.capabilities.sizes.map(size => {
        const [width, height] = size.split('x').map(Number)
        const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
        const divisor = gcd(width!, height!)
        return `${width! / divisor}:${height! / divisor}`
      }),
      allowedSizes: profile.capabilities.sizes, maxCount: Math.min(4, profile.capabilities.maxOutputs),
    })),
  }
  return { protocolVersion: 1 as const, tools: [] as const, profiles: [] as const }
}

export function parseSepMediaRuntime(value: unknown): z.infer<typeof sepMediaRuntimeSchema> {
  const result = sepMediaRuntimeSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid or unsupported SEP media runtime.')
  return result.data
}
