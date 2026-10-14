import { z } from 'zod'

export const skillArtifactProtocolVersion = 1 as const
export const maxSkillArtifactBytes = 20 * 1024 * 1024
export const skillArtifactSha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
export const skillArtifactNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const artifactIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)

export const skillArtifactFrontmatterSchema = z.object({
  name: skillArtifactNameSchema,
  description: z.string().min(1).max(1024).refine(value => value.trim().length > 0),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
}).passthrough()

const identity = {
  protocolVersion: z.literal(skillArtifactProtocolVersion),
  capabilityId: artifactIdSchema,
  versionId: artifactIdSchema,
  approvedContentSha256: skillArtifactSha256Schema,
}

export const skillArtifactBlockedReasonSchema = z.enum([
  'INVALID_ENTRY', 'PACKAGE_REQUIRED', 'PACKAGE_UNAVAILABLE', 'PACKAGE_CONTENT_MISMATCH',
])

// Keep descriptor validation aligned with SEP shared/client-skill-artifact.dto.ts.
export const skillArtifactAvailableSchema = z.object({
  ...identity,
  status: z.literal('AVAILABLE'),
  format: z.enum(['single-file', 'zip']),
  installationDirectory: skillArtifactNameSchema,
  entryPath: z.string().max(1024).refine(value => {
    const parts = value.split('/')
    return parts.at(-1) === 'SKILL.md'
      && parts.every(part => part.length > 0 && part !== '.' && part !== '..')
      && !/[\\:]/.test(value)
      && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  }, 'Invalid skill artifact entry path.'),
  entrySha256: skillArtifactSha256Schema,
  artifactSha256: skillArtifactSha256Schema,
  byteLength: z.number().int().positive().max(maxSkillArtifactBytes),
  fileCount: z.number().int().positive().max(500),
  downloadPath: z.string().regex(/^\/client\/subscriptions\/[a-zA-Z0-9_-]{1,128}\/skills\/[a-zA-Z0-9_-]{1,128}\/versions\/[a-zA-Z0-9_-]{1,128}\/artifact$/),
}).strict()

export const skillArtifactBlockedSchema = z.object({
  ...identity,
  status: z.literal('BLOCKED'),
  reason: skillArtifactBlockedReasonSchema,
}).strict()

export const skillArtifactSchema = z.discriminatedUnion('status', [
  skillArtifactAvailableSchema, skillArtifactBlockedSchema,
])

export const skillArtifactParamsSchema = z.object({
  subscriptionId: artifactIdSchema,
  capabilityId: artifactIdSchema,
  versionId: artifactIdSchema,
}).strict()

export type SkillArtifactAvailable = z.infer<typeof skillArtifactAvailableSchema>
export type AvailableDescriptor = SkillArtifactAvailable
export type BlockedDescriptor = z.infer<typeof skillArtifactBlockedSchema>
export type SkillArtifactDescriptor = z.infer<typeof skillArtifactSchema>
export type SkillArtifactBlockedReason = z.infer<typeof skillArtifactBlockedReasonSchema>

export function skillArtifactDownloadPath(subscriptionId: string, artifact: Pick<SkillArtifactDescriptor, 'capabilityId' | 'versionId'>): string {
  return `/client/subscriptions/${subscriptionId}/skills/${artifact.capabilityId}/versions/${artifact.versionId}/artifact`
}
