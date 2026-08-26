import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodeTaskScopeSegment, type TaskOwnerScope } from './task-store'

export type TaskKind = 'conversation' | 'workflow'

export interface TaskMetadata {
  version: 1
  taskId: string
  kind: TaskKind
  participantEmployeeIds: string[]
  currentEmployeeId: string | null
  createdAt: number
}

export class TaskMetadataStore {
  constructor(private readonly userDataDir: string) {}

  private file(scope: TaskOwnerScope, taskId: string): string {
    return join(this.userDataDir, 'task-data', 'v3', encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId'), encodeTaskScopeSegment(scope.memberId, 'memberId'), 'tasks', taskId, 'metadata.json')
  }

  async save(scope: TaskOwnerScope, metadata: TaskMetadata): Promise<void> {
    const file = this.file(scope, metadata.taskId)
    const temporary = `${file}.${randomUUID()}.tmp`
    await mkdir(join(file, '..'), { recursive: true })
    try {
      await writeFile(temporary, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async load(scope: TaskOwnerScope, taskId: string): Promise<TaskMetadata | null> {
    try {
      const metadata = JSON.parse(await readFile(this.file(scope, taskId), 'utf8')) as TaskMetadata
      if (metadata?.version !== 1 || metadata.taskId !== taskId || !['conversation', 'workflow'].includes(metadata.kind)) return null
      return { ...metadata, participantEmployeeIds: [...metadata.participantEmployeeIds] }
    } catch { return null }
  }
}
