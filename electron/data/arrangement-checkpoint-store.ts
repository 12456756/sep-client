import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import type { ArrangementExecutionState } from '../domain/arrangement-execution'

/** 已确认编排的可恢复进度快照；文件读写细节留在本存储适配器内。 */
export interface ArrangementCheckpoint {
  version: 1
  taskId: string
  owner: TaskOwnerScope
  planHash: string
  activeRunId: string | null
  state: ArrangementExecutionState
  updatedAt: number
}

export interface ArrangementCheckpointStorePort {
  save(scope: TaskOwnerScope, checkpoint: ArrangementCheckpoint): Promise<void>
  get(scope: TaskOwnerScope, taskId: string): Promise<ArrangementCheckpoint | null>
}

function parseCheckpoint(value: unknown, scope: TaskOwnerScope, taskId: string): ArrangementCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const checkpoint = value as Partial<ArrangementCheckpoint> & { owner?: Partial<TaskOwnerScope> }
  if (
    checkpoint.version !== 1 || checkpoint.taskId !== taskId || typeof checkpoint.planHash !== 'string' ||
    !checkpoint.owner || checkpoint.owner.memberId !== scope.memberId || checkpoint.owner.enterpriseId !== scope.enterpriseId ||
    (checkpoint.activeRunId !== null && typeof checkpoint.activeRunId !== 'string') ||
    !checkpoint.state || typeof checkpoint.state !== 'object' || typeof checkpoint.updatedAt !== 'number'
  ) return null
  const state = checkpoint.state as ArrangementExecutionState
  if (!Array.isArray(state.nodes) || typeof state.status !== 'string') return null
  return {
    version: 1,
    taskId,
    owner: { ...scope },
    planHash: checkpoint.planHash,
    activeRunId: checkpoint.activeRunId ?? null,
    state: structuredClone(state),
    updatedAt: checkpoint.updatedAt,
  }
}

export class ArrangementCheckpointStore implements ArrangementCheckpointStorePort {
  private readonly paths: ScopePath

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async save(scope: TaskOwnerScope, checkpoint: ArrangementCheckpoint): Promise<void> {
    await writeJsonAtomic(this.paths.arrangementCheckpointFile(scope, checkpoint.taskId), checkpoint)
  }

  async get(scope: TaskOwnerScope, taskId: string): Promise<ArrangementCheckpoint | null> {
    return readJsonWithBackup(this.paths.arrangementCheckpointFile(scope, taskId), value => parseCheckpoint(value, scope, taskId))
  }
}


