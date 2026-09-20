import { canUseSkillVersion } from '../../common/platform/skill-version-policy'
import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SkillVersionStore } from '../../data/skill-version-store'
import { getEmployeeSkills, previewSkill, type EmployeeSkill, type SkillVersion } from '../../common/platform/platform-api'

export interface SkillStoreRequest {
  enterpriseId: string
  subscriptionId: string
  employeeId: string
  memberId?: string
  accessToken: string
}

export interface SkillStoreResult {
  skillPaths: string[]
}

function safeSegment(value: string): string {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid subscription runtime identifier.')
  return value
}

export class SkillStore {
  constructor(private readonly rootDir: string, private readonly versions?: SkillVersionStore) {}

  prepare(input: SkillStoreRequest): Promise<SkillStoreResult> {
    // Refresh platform skill metadata on every authorization; no skill update event exists.
    return this.install(input)
  }

  invalidate(_subscriptionId?: string): void {
    // Kept for the provisioner contract; installed local versions remain immutable.
  }

  private async install(input: SkillStoreRequest): Promise<SkillStoreResult> {
    const skillsResponse = await getEmployeeSkills(input.employeeId, input.accessToken)
    const skillVersions = skillsResponse.skills.map(skill => skill.currentVersion.version).filter(Boolean).sort()
    const latestSkillVersion = skillVersions.at(-1) ?? 'unknown'
    const base = resolve(
      this.rootDir,
      safeSegment(input.enterpriseId),
      safeSegment(input.memberId ?? 'anonymous'),
      safeSegment(input.subscriptionId),
      'skills',
    )
    const skillRoot = base
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(base, 'skill-manifest.json'), JSON.stringify({ subscriptionId: input.subscriptionId, version: latestSkillVersion, installedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 })
    if (skillsResponse.subscriptionId !== input.subscriptionId) throw new Error('The employee skills response does not match the subscription.')
    const paths: string[] = []
    for (const skill of skillsResponse.skills) {
      if (!skill || typeof skill !== 'object' || !skill.currentVersion.version) continue
      const scope = input.memberId ? { enterpriseId: input.enterpriseId, memberId: input.memberId } : null
      const selected = scope && this.versions ? await this.versions.selected(scope, input.subscriptionId, skill.capability.id) : null
      const selectedVersion = selected && scope && this.versions
        ? await this.versions.load(scope, input.subscriptionId, skill.capability.id, selected)
        : null
      const isOwnerLocalVersion = Boolean(input.memberId && selectedVersion?.localSubmissionId)
      if (!canUseSkillVersion(skill.currentVersion, input.memberId ?? '') && !isOwnerLocalVersion) continue
      const platformVersionId = `platform-${skill.currentVersion.id}`
      const cachedPlatform = scope && this.versions
        ? await this.versions.load(scope, input.subscriptionId, skill.capability.id, platformVersionId)
        : null
      const platformContent = cachedPlatform?.content.trim()
        ? cachedPlatform.content
        : isOwnerLocalVersion
          ? null
          : await this.resolveSkillContent(skill, input.accessToken)
      const platform = scope && this.versions && platformContent !== null
        ? cachedPlatform ?? await this.versions.savePlatform(scope, {
          subscriptionId: input.subscriptionId,
          employeeId: input.employeeId,
          capabilityId: skill.capability.id,
          baseSkillVersionId: skill.currentVersion.id,
          version: skill.currentVersion.version,
          content: platformContent,
        })
        : null
      if (scope && this.versions && platform && !selected) await this.versions.select(scope, input.subscriptionId, skill.capability.id, platform.versionId)
      const activeVersionId = selected ?? platform?.versionId ?? null
      const activeVersion = selectedVersion ?? (activeVersionId && scope && this.versions
        ? await this.versions.load(scope, input.subscriptionId, skill.capability.id, activeVersionId)
        : null)
      const availableVersions: SkillVersion[] = [skill.currentVersion, ...skill.versions]
      const selectedMetadata = activeVersion
        ? availableVersions.find(version => version.id === activeVersion.baseSkillVersionId)
        : null
      if (selected && (!activeVersion || (!isOwnerLocalVersion && (
        selected !== `platform-${activeVersion.baseSkillVersionId}` ||
        !selectedMetadata ||
        !canUseSkillVersion(selectedMetadata, input.memberId ?? '')
      )))) {
        throw new Error('Selected skill version is not approved or is no longer available.')
      }
      // Personal versions track their public ancestor; a personal version ID is not a public update.
      let baseline = selectedMetadata
      const seen = new Set<string>()
      while (baseline?.scope === 'PERSONAL' && baseline.parentVersionId && !seen.has(baseline.id)) {
        seen.add(baseline.id)
        const parentId = baseline.parentVersionId
        baseline = availableVersions.find(version => version.id === parentId)
        if (!baseline) break
      }
      const publicBaseId = baseline?.id ?? selectedMetadata?.parentVersionId ?? selectedVersion?.baseSkillVersionId
      if (scope && this.versions && platform && activeVersion && publicBaseId !== platform.baseSkillVersionId) {
        await this.versions.markPending(scope, input.subscriptionId, skill.capability.id, platform.versionId)
      }
      const content = selected ? activeVersion?.content : platform?.content ?? platformContent
      if (!content) continue
      const skillName = safeSegment(skill.capability.id || skill.capability.name || `skill-${paths.length + 1}`)
      const target = join(skillRoot, skillName)
      const temporary = `${target}.staging`
      await mkdir(temporary, { recursive: true })
      await writeFile(join(temporary, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 })
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify({ id: skill.capability.id, version: activeVersion?.version ?? platform?.version ?? skill.currentVersion.version, sha256: createHash('sha256').update(content).digest('hex') }), { encoding: 'utf8', mode: 0o600 })
      await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
      paths.push(target)
    }
    return { skillPaths: paths }
  }

  private async resolveSkillContent(skill: EmployeeSkill, accessToken: string): Promise<string | null> {
    if (!skill.currentVersion.id) return null
    const preview = await previewSkill(skill.currentVersion.id, accessToken)
    return preview.content.trim() ? preview.content : null
  }
}

