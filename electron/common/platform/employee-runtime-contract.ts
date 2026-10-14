import { z } from 'zod'
import { skillArtifactSchema, skillArtifactAvailableSchema, skillArtifactDownloadPath } from './skill-artifact-contract'

const identifier = z.string().min(1).max(128)

// SEP client.service.getRuntime: the existing manifest v1, not the draft media protocol.
export const employeeRuntimeSkillSchema = z.object({
  capabilityId: identifier,
  name: z.string().min(1),
  description: z.string().nullable(),
  versionId: identifier,
  version: z.string().min(1),
  content: z.string().min(1),
  artifact: skillArtifactSchema.readonly().optional(),
}).superRefine((skill, ctx) => {
  if (skill.artifact && (skill.artifact.capabilityId !== skill.capabilityId || skill.artifact.versionId !== skill.versionId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifact'], message: 'Runtime skill artifact identity mismatch.' })
  }
})

export const employeeRuntimeManifestSchema = z.object({
  manifestVersion: z.literal(1),
  subscriptionId: identifier,
  templateVersion: z.string().min(1),
  employee: z.object({
    id: identifier,
    name: z.string().min(1),
    version: z.string().min(1),
    maxSteps: z.number().int().positive(),
  }),
  runtime: z.object({
    systemPrompt: z.string(),
    modelId: z.string().min(1),
    allowedModels: z.array(z.string().min(1)),
    media: z.unknown().optional(),
    skillArtifactProtocolVersion: z.literal(1).optional(),
    skills: z.array(employeeRuntimeSkillSchema).superRefine((skills, ctx) => {
      const ids = new Set<string>()
      skills.forEach((skill, index) => {
        if (ids.has(skill.capabilityId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'capabilityId'], message: 'Duplicate runtime skill.' })
        ids.add(skill.capabilityId)
      })
    }),
  }),
}).superRefine((manifest, ctx) => {
  manifest.runtime.skills.forEach((skill, index) => {
    if (skill.artifact?.status === 'AVAILABLE' && skill.artifact.downloadPath !== skillArtifactDownloadPath(manifest.subscriptionId, skill.artifact)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runtime', 'skills', index, 'artifact', 'downloadPath'], message: 'Runtime skill artifact download path mismatch.' })
    }
  })
})

export type EmployeeRuntimeSkill = z.infer<typeof employeeRuntimeSkillSchema>
export type EmployeeRuntimeManifest = z.infer<typeof employeeRuntimeManifestSchema>

/** An installed entry, including owner-local selections, not just the server's default. */
export const preparedEmployeeSkillSchema = z.object({
  capabilityId: identifier,
  versionId: z.string().min(1),
  baseSkillVersionId: identifier,
  version: z.string().min(1),
  source: z.enum(['approved', 'owner-local']),
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
  content: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1),
  artifact: skillArtifactAvailableSchema.readonly().optional(),
})

export type PreparedEmployeeSkill = z.infer<typeof preparedEmployeeSkillSchema>

export const employeeRuntimeSnapshotSchema = z.object({
  manifestVersion: z.literal(1),
  skillArtifactProtocolVersion: z.literal(1).optional(),
  subscriptionId: identifier,
  enterpriseId: identifier,
  memberId: identifier.optional(),
  employeeId: identifier,
  templateVersion: z.string().min(1),
  employeeVersion: z.string().min(1),
  maxSteps: z.number().int().positive(),
  systemPrompt: z.string(),
  modelId: z.string().min(1),
  allowedModels: z.array(z.string().min(1)).readonly(),
  approvedSkills: z.array(employeeRuntimeSkillSchema.readonly()).readonly(),
  skills: z.array(preparedEmployeeSkillSchema.readonly()).readonly(),
}).readonly()

export type EmployeeRuntimeSnapshot = z.infer<typeof employeeRuntimeSnapshotSchema>

export function parseEmployeeRuntimeManifest(value: unknown): EmployeeRuntimeManifest {
  const result = employeeRuntimeManifestSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid employee runtime manifest.')
  return result.data
}
