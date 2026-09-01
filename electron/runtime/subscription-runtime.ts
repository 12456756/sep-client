import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getEmployeeSkills, getPackageInfo, type EmployeeSkill } from '../auth/auth-api'
import { config } from '../infrastructure/config'

export interface SubscriptionRuntimeInput {
  enterpriseId: string
  subscriptionId: string
  employeeId: string
  templateVersion: string
  accessToken: string
}

export interface SubscriptionRuntimeResult {
  packageVersion: string
  skillPaths: string[]
}

const APPROVED = new Set(['PLATFORM_APPROVED', 'APPROVED', 'PUBLISHED'])
const VERSION = /^\d+\.\d+\.\d+$/

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid subscription runtime identifier.')
  return value
}

export class SubscriptionRuntime {
  private readonly cache = new Map<string, Promise<SubscriptionRuntimeResult>>()

  constructor(private readonly rootDir: string) {}

  prepare(input: SubscriptionRuntimeInput): Promise<SubscriptionRuntimeResult> {
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

  private async install(input: SubscriptionRuntimeInput): Promise<SubscriptionRuntimeResult> {
    if (!VERSION.test(input.templateVersion)) throw new Error('The employee package version is invalid.')
    const packageInfo = await getPackageInfo(input.subscriptionId, input.accessToken)
    if (packageInfo.version !== input.templateVersion) throw new Error('The employee package version does not match the subscription.')
    const base = resolve(this.rootDir, safeSegment(input.enterpriseId), safeSegment(input.subscriptionId), safeSegment(packageInfo.version))
    const skillRoot = join(base, 'skills')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(base, 'package-manifest.json'), JSON.stringify({ version: packageInfo.version, packageRef: packageInfo.packageRef, sha256: packageInfo.sha256, installedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 })
    const skills = await getEmployeeSkills(input.employeeId, input.accessToken)
    const paths: string[] = []
    for (const skill of skills) {
      if (!skill || typeof skill !== 'object' || !APPROVED.has(skill.status) || !skill.currentVersion) continue
      const content = await this.resolveSkillContent(skill, input.accessToken)
      if (!content) continue
      const skillName = safeSegment(skill.id || skill.name || `skill-${paths.length + 1}`)
      const target = join(skillRoot, skillName)
      const temporary = `${target}.staging`
      await mkdir(temporary, { recursive: true })
      await writeFile(join(temporary, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 })
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify({ id: skill.id, version: skill.currentVersion, sha256: createHash('sha256').update(content).digest('hex') }), { encoding: 'utf8', mode: 0o600 })
      await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
      paths.push(target)
    }
    return { packageVersion: packageInfo.version, skillPaths: paths }
  }

  private async resolveSkillContent(skill: EmployeeSkill, accessToken: string): Promise<string | null> {
    if (typeof skill.content === 'string' && skill.content.trim()) return skill.content
    if (!skill.versionId) return null
    const response = await fetch(`${config.SEP_API_BASE_URL}/enterprise/skill-versions/${encodeURIComponent(skill.versionId)}/preview`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return null
    const payload = await response.json() as unknown
    if (typeof payload === 'string') return payload
    if (payload && typeof payload === 'object' && typeof (payload as { content?: unknown }).content === 'string') return (payload as { content: string }).content
    return null
  }
}
