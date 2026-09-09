import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import type { WorkflowRunnerState } from '../runtime/workflow-runner'

export interface WorkflowCheckpoint {
  version: 1
  taskId: string
  owner: TaskOwnerScope
  planHash: string
  activeRunId: string | null
  state: WorkflowRunnerState
  updatedAt: number
}

export interface WorkflowCheckpointStorePort {
  save(scope: TaskOwnerScope, checkpoint: WorkflowCheckpoint): Promise<void>
  get(scope: TaskOwnerScope, taskId: string): Promise<WorkflowCheckpoint | null>
}

function parseCheckpoint(value: unknown, scope: TaskOwnerScope, taskId: string): WorkflowCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const checkpoint = value as Partial<WorkflowCheckpoint> & { owner?: Partial<TaskOwnerScope> }
  if (
    checkpoint.version !== 1 || checkpoint.taskId !== taskId || typeof checkpoint.planHash !== 'string' ||
    !checkpoint.owner || checkpoint.owner.memberId !== scope.memberId || checkpoint.owner.enterpriseId !== scope.enterpriseId ||
    (checkpoint.activeRunId !== null && typeof checkpoint.activeRunId !== 'string') ||
    !checkpoint.state || typeof checkpoint.state !== 'object' || typeof checkpoint.updatedAt !== 'number'
  ) return null
  const state = checkpoint.state as WorkflowRunnerState
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

export class WorkflowCheckpointStore implements WorkflowCheckpointStorePort {
  private readonly paths: ScopePath

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async save(scope: TaskOwnerScope, checkpoint: WorkflowCheckpoint): Promise<void> {
    await writeJsonAtomic(this.paths.workflowCheckpointFile(scope, checkpoint.taskId), checkpoint)
  }

  async get(scope: TaskOwnerScope, taskId: string): Promise<WorkflowCheckpoint | null> {
    return readJsonWithBackup(this.paths.workflowCheckpointFile(scope, taskId), value => parseCheckpoint(value, scope, taskId))
  }
}
