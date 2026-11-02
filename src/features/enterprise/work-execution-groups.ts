import type { WorkItem } from './types'

export interface WorkExecutionGroup {
  work: WorkItem
  executions: WorkItem[]
}

/** Only explicit lineage groups tasks; equal titles never merge unrelated work. */
export function groupWorkExecutions(works: readonly WorkItem[]): WorkExecutionGroup[] {
  const groups = new Map<string, WorkItem[]>()
  for (const work of works) {
    const key = work.executionGroup?.rootTaskId ?? work.id
    const entries = groups.get(key) ?? []
    entries.push(work)
    groups.set(key, entries)
  }
  return [...groups].map(([rootTaskId, entries]) => {
    const executions = [...entries].sort((a, b) => (b.executionGroup?.number ?? 1) - (a.executionGroup?.number ?? 1) || b.createdAt - a.createdAt)
    const root = entries.find(item => item.id === rootTaskId) ?? executions.at(-1)!
    const representative = executions.find(item => item.isActive) ?? executions[0]!
    return { executions, work: { ...representative, id: rootTaskId, recordKey: root.recordKey,
      title: root.title, pinnedAt: root.pinnedAt, updatedAt: Math.max(...entries.map(item => item.updatedAt)) } }
  })
}

export function resolveExecutionSelection(group: WorkExecutionGroup, executionTaskId?: string): { detail: WorkItem | null } {
  return { detail: executionTaskId ? group.executions.find(item => item.id === executionTaskId) ?? null
    : group.executions.length === 1 ? group.executions[0]! : null }
}
