import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ApprovedSkillReadPath, ToolPolicy } from '../../pi-extension/guard'
import type { EmployeeRuntimeConfig } from './run-types'

/** Grant reads from the authorized run snapshot, never from arbitrary loader paths. */
export function withApprovedSkillReadPaths(
  policy: ToolPolicy | undefined, employee: EmployeeRuntimeConfig,
): ToolPolicy | undefined {
  if (!policy) return undefined
  const paths: ApprovedSkillReadPath[] = []
  const snapshot = employee.runtimeSnapshot
  if (snapshot?.subscriptionId === employee.subscriptionId) {
    for (const skill of snapshot.skills) {
      const approved = snapshot.approvedSkills.find(item => item.capabilityId === skill.capabilityId)
      if (skill.source !== 'approved' || !approved || skill.baseSkillVersionId !== approved.versionId
        || skill.version !== approved.version || !employee.additionalSkillPaths?.includes(skill.path)
        || !isAbsolute(skill.path)) continue
      const artifact = skill.artifact
      if (snapshot.skillArtifactProtocolVersion === 1) {
        if (!artifact || approved.artifact?.status !== 'AVAILABLE' || !isDeepStrictEqual(artifact, approved.artifact)
          || skill.sha256 !== artifact.entrySha256) continue
      } else if (artifact) continue
      try {
        // PreparedEmployeeSkill.path and additionalSkillPaths are entry directories.
        const installedEntry = join(skill.path, 'SKILL.md')
        if (!lstatSync(skill.path).isDirectory() || !lstatSync(installedEntry).isFile()
          || createHash('sha256').update(readFileSync(installedEntry)).digest('hex') !== skill.sha256) continue
        const entryPath = realpathSync(installedEntry)
        if (join(realpathSync(skill.path), 'SKILL.md') !== entryPath) continue
        let packageRoot: string | undefined
        if (artifact?.format === 'zip') {
          const parts = artifact.entryPath.split('/')
          if (parts.at(-1) !== 'SKILL.md' || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) continue
          let root = skill.path
          for (const _part of parts.slice(0, -1)) root = dirname(root)
          packageRoot = realpathSync(root)
          // Symlinks inside the package cannot relocate its approved entry.
          if (resolve(packageRoot, ...parts) !== entryPath) continue
        }
        paths.push(Object.freeze({ entryPath, ...(packageRoot ? { packageRoot } : {}) }))
      } catch {
        // Missing/replaced files fail closed; never fall back to the profile root.
      }
    }
  }
  return { ...policy, approvedSkillPaths: Object.freeze(paths) }
}
