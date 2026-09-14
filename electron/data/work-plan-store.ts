import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import type { WorkPlan } from '../domain/arrangement-plan'
import { TaskPersistenceError } from './task-store'

export interface WorkPlanStorePort {
  save(scope: TaskOwnerScope, plan: WorkPlan): Promise<void>
  get(scope: TaskOwnerScope, taskId: string): Promise<WorkPlan | null>
}

function parsePlan(value: unknown, scope: TaskOwnerScope, taskId: string): WorkPlan | null {
  if (!value || typeof value !== 'object') return null
  const plan = value as Partial<WorkPlan>
  if (
    plan.schemaVersion !== 1 || plan.id !== taskId ||
    !plan.owner || plan.owner.memberId !== scope.memberId || plan.owner.enterpriseId !== scope.enterpriseId ||
    !plan.sourceDraftId || typeof plan.sourceDraftRevision !== 'number' ||
    (plan.mode !== 'conversation' && plan.mode !== 'auto' && plan.mode !== 'manual') ||
    typeof plan.title !== 'string' || typeof plan.goal !== 'string' ||
    !Array.isArray(plan.nodes) || !plan.workspace || plan.workspace.mode !== 'shared' ||
    !plan.permissions || typeof plan.planHash !== 'string' || typeof plan.createdAt !== 'number'
  ) return null
  return structuredClone(plan as WorkPlan)
}

export class WorkPlanStore implements WorkPlanStorePort {
  private readonly paths: ScopePath

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async save(scope: TaskOwnerScope, plan: WorkPlan): Promise<void> {
    try {
      await writeJsonAtomic(this.paths.workPlanFile(scope, plan.id), plan)
    } catch (error) {
      throw new TaskPersistenceError(error instanceof Error ? error.message : 'Work plan could not be persisted.')
    }
  }

  async get(scope: TaskOwnerScope, taskId: string): Promise<WorkPlan | null> {
    return readJsonWithBackup(this.paths.workPlanFile(scope, taskId), value => parsePlan(value, scope, taskId))
  }
}


