import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WriteChain } from './write-chain'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import type { TaskOwnerScope } from './scope-path'

export interface LocalSkillVersion {
  versionId: string
  subscriptionId: string
  employeeId: string
  capabilityId: string
  localSubmissionId?: string
  baseSkillVersionId: string
  version: string
  content: string
  sha256: string
  state: 'DRAFT' | 'SELECTED'
  updatedAt: number
}

export interface SkillSelection { versionId: string; pendingVersionId?: string }
export type SkillSelections = Record<string, SkillSelection>

function safe(value: string): string {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid skill identifier.')
  return value
}

export class SkillVersionStore {
  private readonly writes = new WriteChain()
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
  async savePlatform(scope: TaskOwnerScope, input: Omit<LocalSkillVersion, 'versionId'|'sha256'|'updatedAt'|'state'>): Promise<LocalSkillVersion> {
    return this.save(scope, { ...input, versionId: `platform-${input.baseSkillVersionId}` })
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
    await this.writes.run(this.selectionFile(scope, subscriptionId), async () => {
      const selections = await this.selections(scope, subscriptionId)
      await writeJsonAtomic(this.selectionFile(scope, subscriptionId), { ...selections, [capabilityId]: { versionId } })
    })
  }
  async selected(scope: TaskOwnerScope, subscriptionId: string, capabilityId: string): Promise<string | null> {
    const value = await this.selections(scope, subscriptionId)
    return value[capabilityId]?.versionId ?? null
  }
  async selections(scope: TaskOwnerScope, subscriptionId: string): Promise<SkillSelections> {
    return (await readJsonWithBackup(this.selectionFile(scope, subscriptionId), input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
        const item = value as Partial<SkillSelection>
        return typeof item?.versionId === 'string' ? [[key, { versionId: item.versionId, ...(typeof item.pendingVersionId === 'string' ? { pendingVersionId: item.pendingVersionId } : {}) }]] : []
      }))
    })) ?? {}
  }
  async markPending(scope: TaskOwnerScope, subscriptionId: string, capabilityId: string, versionId: string): Promise<void> {
    await this.writes.run(this.selectionFile(scope, subscriptionId), async () => {
      const selections = await this.selections(scope, subscriptionId)
      const current = selections[capabilityId]
      if (!current) return
      await writeJsonAtomic(this.selectionFile(scope, subscriptionId), { ...selections, [capabilityId]: { ...current, pendingVersionId: versionId } })
    })
  }
  async materialize(scope: TaskOwnerScope, version: LocalSkillVersion): Promise<string> {
    const path = join(this.dir(scope, version.subscriptionId, version.capabilityId), 'selected', version.versionId)
    await mkdir(path, { recursive: true })
    await writeJsonAtomic(join(path, 'manifest.json'), { ...version, content: undefined })
    await writeFile(join(path, 'SKILL.md'), version.content, { encoding: 'utf8', mode: 0o600 })
    return path
  }
}

