import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import * as manifest from '../../../resources/office/manifest.json'
import { applicationResourcesDirectory } from '../../data/application-resources'
import { assertSkillPathParents } from './skill-package-zip'
import { validatedSkillMarkdown } from './skill-package-parser'

export interface PreparedCommonSkill {
  id: string
  source: 'common'
  version: string
  name: string
  path: string
  sha256: string
}
export interface CommonSkillsResult {
  skills: PreparedCommonSkill[]
  office?: { executable: string; sha256: string }
  unavailable: string[]
}
export const OFFICE_SKILL_SHA256 = 'a41eb86a29609f21c4bc8b4d8bb8d1135d5af246d6ebbcb23ec917c61708bc76'

/** Host-owned catalog only. Employee-provided text cannot add binaries or capabilities. */
export function prepareCommonSkills(
  root = applicationResourcesDirectory(), platform: string = process.platform, arch: string = process.arch,
): CommonSkillsResult {
  try {
    const asset = manifest.assets[`${platform}-${arch}` as keyof typeof manifest.assets]
    if (!asset) throw new Error('OfficeCLI is not bundled for this platform.')
    const path = join(root, 'common-skills', 'officecli')
    const entry = join(path, 'SKILL.md')
    const executable = join(root, 'office', asset.file)
    for (const file of [entry, executable]) {
      assertSkillPathParents(file)
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid bundled Office file.')
    }
    const bytes = readFileSync(entry)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== OFFICE_SKILL_SHA256) throw new Error('Bundled Office skill checksum mismatch.')
    const parsed = validatedSkillMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (parsed.metadata.name !== 'officecli' || lstatSync(executable).size !== asset.size
      || createHash('sha256').update(readFileSync(executable)).digest('hex') !== asset.sha256) throw new Error('Bundled Office executable checksum mismatch.')
    return { skills: [{ id: 'officecli', source: 'common', version: manifest.version,
      name: parsed.metadata.name, path: realpathSync(path), sha256 }],
      office: { executable: realpathSync(executable), sha256: asset.sha256 }, unavailable: [] }
  } catch (error) {
    return { skills: [], unavailable: [error instanceof Error && !('code' in error)
      ? error.message : 'Bundled Office resources are missing or unreadable.'] }
  }
}
