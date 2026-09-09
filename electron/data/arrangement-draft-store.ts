import { mkdir, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { TaskOwnerScope } from './scope-path'
import { ScopePath, isSafeId } from './scope-path'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'
import {
  validateArrangementDraft,
  type ArrangementDraft,
} from '../domain/arrangement-plan'
import { TaskPersistenceError } from './task-store'
import { AppError } from '../errors/app-error'

export interface ArrangementDraftStorePort {
  list(scope: TaskOwnerScope): Promise<ArrangementDraft[]>
  get(scope: TaskOwnerScope, draftId: string): Promise<ArrangementDraft | null>
  create(scope: TaskOwnerScope, input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>): Promise<ArrangementDraft>
  update(scope: TaskOwnerScope, draftId: string, expectedRevision: number, patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>): Promise<ArrangementDraft>
  delete(scope: TaskOwnerScope, draftId: string): Promise<boolean>
}

function cloneDraft(draft: ArrangementDraft): ArrangementDraft {
  return structuredClone(draft)
}

function parseDraft(value: unknown, scope: TaskOwnerScope, draftId: string): ArrangementDraft | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Partial<ArrangementDraft>
  if (
    draft.schemaVersion !== 1 ||
    draft.id !== draftId ||
    !draft.owner || draft.owner.memberId !== scope.memberId || draft.owner.enterpriseId !== scope.enterpriseId ||
    typeof draft.revision !== 'number' || !Number.isInteger(draft.revision) || draft.revision < 1 ||
    typeof draft.title !== 'string' || typeof draft.goal !== 'string' ||
    !Array.isArray(draft.confirmedInputs) || !draft.confirmedInputs.every(item => typeof item === 'string') ||
    !Array.isArray(draft.sharedSkillIds) || !draft.sharedSkillIds.every(item => typeof item === 'string') ||
    !Array.isArray(draft.nodes) || !draft.workspace || draft.workspace.mode !== 'shared' ||
    !draft.permissions || typeof draft.createdAt !== 'number' || typeof draft.updatedAt !== 'number'
  ) return null
  const result = cloneDraft(draft as ArrangementDraft)
  try {
    validateArrangementDraft(result)
  } catch {
    return null
  }
  return result
}

export class ArrangementDraftStore implements ArrangementDraftStorePort {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async list(scope: TaskOwnerScope): Promise<ArrangementDraft[]> {
    let entries
    try {
      entries = await readdir(this.paths.arrangementDraftsRoot(scope), { withFileTypes: true })
    } catch {
      return []
    }
    const drafts = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && isSafeId(entry.name.slice(0, -5)))
      .map(entry => this.get(scope, entry.name.slice(0, -5))))
    return drafts
      .filter((draft): draft is ArrangementDraft => draft !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async get(scope: TaskOwnerScope, draftId: string): Promise<ArrangementDraft | null> {
    const file = this.paths.arrangementDraftFile(scope, draftId)
    return readJsonWithBackup(file, value => parseDraft(value, scope, draftId))
  }

  async create(
    scope: TaskOwnerScope,
    input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): Promise<ArrangementDraft> {
    const now = Date.now()
    const draft: ArrangementDraft = {
      ...structuredClone(input),
      id: `draft-${randomUUID()}`,
      schemaVersion: 1,
      revision: 1,
      owner: { ...scope },
      createdAt: now,
      updatedAt: now,
    }
    validateArrangementDraft(draft)
    await this.write(scope, draft)
    return cloneDraft(draft)
  }

  async update(
    scope: TaskOwnerScope,
    draftId: string,
    expectedRevision: number,
    patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): Promise<ArrangementDraft> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const current = await this.get(scope, draftId)
      if (!current) throw new TaskPersistenceError('Arrangement draft not found.')
      if (current.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
      const next: ArrangementDraft = {
        ...structuredClone(patch),
        id: current.id,
        schemaVersion: 1,
        revision: current.revision + 1,
        owner: { ...scope },
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      }
      validateArrangementDraft(next)
      await this.writeUnlocked(scope, next)
      return cloneDraft(next)
    })
  }

  async delete(scope: TaskOwnerScope, draftId: string): Promise<boolean> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const current = await this.get(scope, draftId)
      if (!current) return false
      await rm(this.paths.arrangementDraftFile(scope, draftId), { force: true })
      await rm(`${this.paths.arrangementDraftFile(scope, draftId)}.bak`, { force: true })
      return true
    })
  }

  private async write(scope: TaskOwnerScope, draft: ArrangementDraft): Promise<void> {
    await this.writes.run(this.paths.scopeKey(scope), () => this.writeUnlocked(scope, draft))
  }

  private async writeUnlocked(scope: TaskOwnerScope, draft: ArrangementDraft): Promise<void> {
    try {
      await mkdir(this.paths.arrangementDraftsRoot(scope), { recursive: true })
      await writeJsonAtomic(this.paths.arrangementDraftFile(scope, draft.id), draft)
    } catch (error) {
      throw new TaskPersistenceError(error instanceof Error ? error.message : 'Arrangement draft could not be persisted.')
    }
  }
}
