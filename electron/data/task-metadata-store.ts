/**
 * electron/data/task-metadata-store.ts — 任务元数据的读写
 *
 * 元数据决定一个任务是对话还是安排，以及参与过哪些员工。
 * 路径走 `scope-path.ts`、写走 `atomic-file.ts`。
 */
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'

export type TaskKind = 'conversation' | 'arrangement'

export interface TaskMetadata {
  version: 1
  taskId: string
  kind: TaskKind
  participantSubscriptionIds: string[]
  currentSubscriptionId: string | null
  createdAt: number
}

const KINDS: readonly TaskKind[] = ['conversation', 'arrangement']

function parseMetadata(value: unknown, taskId: string): TaskMetadata | null {
  const metadata = value as TaskMetadata | null
  if (
    metadata?.version !== 1 ||
    metadata.taskId !== taskId ||
    !KINDS.includes(metadata.kind) ||
    !Array.isArray(metadata.participantSubscriptionIds)
  ) return null
  return { ...metadata, participantSubscriptionIds: [...metadata.participantSubscriptionIds] }
}

export class TaskMetadataStore {
  private readonly paths: ScopePath

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async save(scope: TaskOwnerScope, metadata: TaskMetadata): Promise<void> {
    await writeJsonAtomic(this.paths.metadataFile(scope, metadata.taskId), metadata)
  }

  async load(scope: TaskOwnerScope, taskId: string): Promise<TaskMetadata | null> {
    return readJsonWithBackup(
      this.paths.metadataFile(scope, taskId),
      value => parseMetadata(value, taskId),
    )
  }
}


