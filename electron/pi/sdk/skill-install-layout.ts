import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { preparedEmployeeSkillSchema, type PreparedEmployeeSkill } from '../../common/platform/employee-runtime-contract'
import type { SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'

const identifier = z.string().min(1).max(128)
export const skillCacheIdentitySchema = z.object({
  layoutVersion: z.literal(2),
  enterpriseId: identifier,
  memberId: identifier.nullable(),
  subscriptionId: identifier,
  employeeId: identifier,
}).strict()

export type SkillCacheIdentity = z.infer<typeof skillCacheIdentitySchema>
type InstallationVersion = Pick<PreparedEmployeeSkill, 'capabilityId' | 'versionId' | 'version' | 'source' | 'sha256' | 'artifact'>

export function skillInstallationKey(identity: SkillCacheIdentity, skill: InstallationVersion): string {
  return createHash('sha256').update(JSON.stringify([
    'skills-v2', identity.enterpriseId, identity.memberId, identity.subscriptionId, identity.employeeId,
    skill.capabilityId, skill.versionId, skill.version, skill.source, skill.sha256,
    skill.artifact ? [skill.artifact.artifactSha256, skill.artifact.entryPath, skill.artifact.installationDirectory] : null,
  ])).digest('hex')
}

export function skillArtifactCacheKey(identity: SkillCacheIdentity, artifact: SkillArtifactAvailable): string {
  return createHash('sha256').update(JSON.stringify([
    'artifacts-v2', identity.enterpriseId, identity.memberId, identity.subscriptionId, identity.employeeId,
    artifact.capabilityId, artifact.versionId, artifact.artifactSha256,
  ])).digest('hex')
}

const installationManifestSchema = preparedEmployeeSkillSchema.extend({ cacheIdentity: skillCacheIdentitySchema })

export function isCompactSkillPath(entryFile: string): boolean {
  for (let current = resolve(entryFile); ; current = dirname(current)) {
    if (basename(dirname(current)) === 'skills-v2' && /^[a-f0-9]{64}$/.test(basename(current))) return true
    if (dirname(current) === current) return false
  }
}

/** Validate flattened installations without changing legacy snapshot/loader support. */
export function verifySkillInstallationIdentity(entryFile: string, manifestBytes: Buffer, entryBytes: Buffer): void {
  const manifest = installationManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)))
  let packageRoot = dirname(entryFile)
  if (manifest.artifact) {
    for (const _part of manifest.artifact.entryPath.split('/').slice(0, -1)) packageRoot = dirname(packageRoot)
  }
  const installation = dirname(packageRoot)
  const expected = join(dirname(installation), skillInstallationKey(manifest.cacheIdentity, manifest), manifest.name)
  const expectedEntry = manifest.artifact ? join(expected, manifest.artifact.entryPath) : join(expected, 'SKILL.md')
  if (basename(dirname(installation)) !== 'skills-v2'
    || createHash('sha256').update(entryBytes).digest('hex') !== manifest.sha256
    || resolve(packageRoot) !== resolve(expected) || resolve(entryFile) !== resolve(expectedEntry)
    || resolve(manifest.path) !== resolve(dirname(entryFile))) {
    throw new Error('Employee skill installation identity mismatch.')
  }
}
