import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ScopePath, assertSafeId, type TaskOwnerScope } from './scope-path'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'

const recordSchema = z.object({
  draftId: z.string(), revision: z.number().int().positive(), taskId: z.string(),
  idempotencyKey: z.string(), state: z.enum(['preparing', 'committed']),
}).strict()
export type ArrangementConfirmation = z.infer<typeof recordSchema>
export interface ArrangementConfirmationStorePort {
  get(scope: TaskOwnerScope, draftId: string, revision: number): Promise<ArrangementConfirmation | null>
  save(scope: TaskOwnerScope, record: ArrangementConfirmation): Promise<void>
}

/** Reserved task IDs make a partially completed confirmation retryable after restart. */
export class ArrangementConfirmationStore implements ArrangementConfirmationStorePort {
  private readonly paths: ScopePath
  constructor(userDataDir: string) { this.paths = new ScopePath(userDataDir) }
  private root(scope: TaskOwnerScope): string { return join(this.paths.ownerRoot(scope), 'arrangement-confirmations') }
  private file(scope: TaskOwnerScope, draftId: string, revision: number): string {
    assertSafeId(draftId, 'draftId')
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('INVALID_REVISION')
    return join(this.root(scope), `${draftId}-${revision}.json`)
  }
  get(scope: TaskOwnerScope, draftId: string, revision: number): Promise<ArrangementConfirmation | null> {
    return readJsonWithBackup(this.file(scope, draftId, revision), value => {
      const parsed = recordSchema.safeParse(value)
      return parsed.success && parsed.data.draftId === draftId && parsed.data.revision === revision ? parsed.data : null
    })
  }
  async save(scope: TaskOwnerScope, record: ArrangementConfirmation): Promise<void> {
    assertSafeId(record.taskId, 'taskId')
    recordSchema.parse(record)
    await mkdir(this.root(scope), { recursive: true })
    await writeJsonAtomic(this.file(scope, record.draftId, record.revision), record)
  }
}
