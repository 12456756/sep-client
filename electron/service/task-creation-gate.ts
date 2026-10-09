import type { TaskOwnerScope } from '../data/scope-path'

interface ScopeCreations {
  version: number
  pending: Set<Promise<void>>
  failed: Set<string>
}

export interface TaskCreationLease {
  taskCreated(taskId: string): void
  finish(success: boolean): void
}

/** Coordinates query projections only; task execution and event delivery remain unchanged. */
export class TaskCreationGate {
  private readonly scopes = new Map<string, ScopeCreations>()

  private state(scope: TaskOwnerScope): ScopeCreations {
    const key = JSON.stringify([scope.enterpriseId, scope.memberId])
    let state = this.scopes.get(key)
    if (!state) {
      state = { version: 0, pending: new Set(), failed: new Set() }
      this.scopes.set(key, state)
    }
    return state
  }

  begin(scope: TaskOwnerScope): TaskCreationLease {
    const state = this.state(scope)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    state.pending.add(pending)
    state.version += 1
    let taskId: string | undefined
    let finished = false
    return {
      taskCreated(id) { taskId = id },
      finish(success) {
        if (finished) return
        finished = true
        if (!success && taskId) state.failed.add(taskId)
        state.pending.delete(pending)
        state.version += 1
        release()
      },
    }
  }

  async waitForIdle(scope: TaskOwnerScope): Promise<number> {
    const state = this.state(scope)
    while (state.pending.size > 0) await Promise.all([...state.pending])
    return state.version
  }

  isStable(scope: TaskOwnerScope, version: number): boolean {
    const state = this.state(scope)
    return state.pending.size === 0 && state.version === version
  }

  hasFailed(scope: TaskOwnerScope, taskId: string): boolean {
    return this.state(scope).failed.has(taskId)
  }
}
