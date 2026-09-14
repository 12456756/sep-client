import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SkillVersionStore } from '../../data/skill-version-store'
import { getEmployeeSkills, getPackageInfo, previewSkill, type EmployeeSkill } from '../../common/platform/platform-api'

export interface SkillPackageRequest {
  enterpriseId: string
  subscriptionId: string
  employeeId: string
  memberId?: string
  templateVersion: string
  accessToken: string
}

export interface SkillPackageResult {
  packageVersion: string
  skillPaths: string[]
}

const APPROVED = new Set(['PLATFORM_APPROVED', 'APPROVED', 'PUBLISHED'])
const VERSION = /^\d+\.\d+\.\d+$/

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid subscription runtime identifier.')
  return value
}

export class SkillPackageStore {
  private readonly cache = new Map<string, Promise<SkillPackageResult>>()

  constructor(private readonly rootDir: string, private readonly versions?: SkillVersionStore) {}

  prepare(input: SkillPackageRequest): Promise<SkillPackageResult> {
    const key = `${input.enterpriseId}:${input.subscriptionId}:${input.templateVersion}`
    const existing = this.cache.get(key)
    if (existing) return existing
    const operation = this.install(input)
    this.cache.set(key, operation)
    return operation.catch(error => {
      if (this.cache.get(key) === operation) this.cache.delete(key)
      throw error
    })
  }

  invalidate(subscriptionId?: string): void {
    if (!subscriptionId) this.cache.clear()
    else for (const key of this.cache.keys()) if (key.includes(`:${subscriptionId}:`)) this.cache.delete(key)
  }

  private async install(input: SkillPackageRequest): Promise<SkillPackageResult> {
    if (!VERSION.test(input.templateVersion)) throw new Error('The employee package version is invalid.')
    const packageInfo = await getPackageInfo(input.subscriptionId, input.accessToken)
    if (packageInfo.version !== input.templateVersion) throw new Error('The employee package version does not match the subscription.')
    const base = resolve(this.rootDir, safeSegment(input.enterpriseId), safeSegment(input.subscriptionId), safeSegment(packageInfo.version))
    const skillRoot = join(base, 'skills')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(base, 'package-manifest.json'), JSON.stringify({ version: packageInfo.version, packageRef: packageInfo.packageRef, sha256: packageInfo.sha256, installedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 })
    const skillsResponse = await getEmployeeSkills(input.employeeId, input.accessToken)
    if (skillsResponse.subscriptionId !== input.subscriptionId) throw new Error('The employee skills response does not match the subscription.')
    const paths: string[] = []
    for (const skill of skillsResponse.skills) {
      if (!skill || typeof skill !== 'object' || !APPROVED.has(skill.currentVersion.status) || !skill.currentVersion.version) continue
      const local = input.memberId && this.versions ? await this.versions.selected({ enterpriseId: input.enterpriseId, memberId: input.memberId }, input.subscriptionId, skill.capability.id) : null
      const localVersion = local && input.memberId && this.versions ? await this.versions.load({ enterpriseId: input.enterpriseId, memberId: input.memberId }, input.subscriptionId, skill.capability.id, local) : null
      const content = localVersion?.content ?? await this.resolveSkillContent(skill, input.accessToken)
      if (!content) continue
      const skillName = safeSegment(skill.capability.id || skill.capability.name || `skill-${paths.length + 1}`)
      const target = join(skillRoot, skillName)
      const temporary = `${target}.staging`
      await mkdir(temporary, { recursive: true })
      await writeFile(join(temporary, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 })
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify({ id: skill.capability.id, version: skill.currentVersion.version, sha256: createHash('sha256').update(content).digest('hex') }), { encoding: 'utf8', mode: 0o600 })
      await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
      paths.push(target)
    }
    return { packageVersion: packageInfo.version, skillPaths: paths }
  }

  private async resolveSkillContent(skill: EmployeeSkill, accessToken: string): Promise<string | null> {
    if (!skill.currentVersion.id) return null
    const preview = await previewSkill(skill.currentVersion.id, accessToken)
    return preview.content.trim() ? preview.content : null
  }
}

