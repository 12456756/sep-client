import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import type { TaskOwnerScope } from './scope-path'

export interface LocalSkillVersion {
  versionId: string
  subscriptionId: string
  employeeId: string
  capabilityId: string
  baseSkillVersionId: string
  version: string
  content: string
  sha256: string
  state: 'DRAFT' | 'SELECTED'
  updatedAt: number
}

export interface SkillSelection { capabilityId: string; versionId: string }

function safe(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid skill identifier.')
  return value
}

export class SkillVersionStore {
  constructor(private readonly rootDir: string) {}
  private dir(scope: TaskOwnerScope, subscriptionId: string, capabilityId: string): string {
    return resolve(this.rootDir, safe(scope.enterpriseId), safe(scope.memberId), safe(subscriptionId), safe(capabilityId))
  }
  private versionFile(scope: TaskOwnerScope, value: LocalSkillVersion): string {
    return join(this.dir(scope, value.subscriptionId, value.capabilityId), 'versions', `${safe(value.versionId)}.json`)
  }
  private selectionFile(scope: TaskOwnerScope, subscriptionId: string): string {
    return join(resolve(this.rootDir, safe(scope.enterpriseId), safe(scope.memberId), safe(subscriptionId)), 'selection.json')
  }
  async save(scope: TaskOwnerScope, input: Omit<LocalSkillVersion, 'versionId'|'sha256'|'updatedAt'|'state'> & { versionId?: string }): Promise<LocalSkillVersion> {
    const value: LocalSkillVersion = { ...input, versionId: input.versionId ?? `local-${randomUUID()}`, sha256: createHash('sha256').update(input.content, 'utf8').digest('hex'), state: 'DRAFT', updatedAt: Date.now() }
    await mkdir(join(this.dir(scope, value.subscriptionId, value.capabilityId), 'versions'), { recursive: true })
    await writeJsonAtomic(this.versionFile(scope, value), value)
    return value
  }
  async load(scope: TaskOwnerScope, subscriptionId: string, capabilityId: string, versionId: string): Promise<LocalSkillVersion | null> {
    return readJsonWithBackup(this.versionFile(scope, { subscriptionId, capabilityId, versionId } as LocalSkillVersion), value => {
      const item = value as LocalSkillVersion
      return item?.versionId === versionId && item.subscriptionId === subscriptionId && item.capabilityId === capabilityId && typeof item.content === 'string' ? { ...item } : null
    })
  }
  async select(scope: TaskOwnerScope, subscriptionId: string, capabilityId: string, versionId: string): Promise<void> {
    const current = await this.load(scope, subscriptionId, capabilityId, versionId)
    if (!current) throw new Error('Skill version not found.')
    await writeJsonAtomic(this.selectionFile(scope, subscriptionId), { capabilityId, versionId })
  }
  async selected(scope: TaskOwnerScope, subscriptionId: string, capabilityId: string): Promise<string | null> {
    const value = await readJsonWithBackup(this.selectionFile(scope, subscriptionId), input => {
      const item = input as SkillSelection
      return item?.capabilityId === capabilityId && typeof item.versionId === 'string' ? item.versionId : null
    })
    return value
  }
  async materialize(scope: TaskOwnerScope, version: LocalSkillVersion): Promise<string> {
    const path = join(this.dir(scope, version.subscriptionId, version.capabilityId), 'selected', version.versionId)
    await mkdir(path, { recursive: true })
    await writeJsonAtomic(join(path, 'manifest.json'), { ...version, content: undefined })
    await writeFile(join(path, 'SKILL.md'), version.content, { encoding: 'utf8', mode: 0o600 })
    return path
  }
}

