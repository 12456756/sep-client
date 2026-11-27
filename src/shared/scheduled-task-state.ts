import type { ScheduledDefinition, ScheduledOccurrence, ScheduledRunStatus } from './scheduled-tasks'

export const scheduledTaskGroups = ['enabled', 'disabled', 'history'] as const
export type ScheduledTaskGroup = typeof scheduledTaskGroups[number]
export const scheduledTaskGroupLabels = { disabled: '未启用', enabled: '已启用', history: '历史记录' } satisfies Record<ScheduledTaskGroup, string>
export const scheduledTaskStateLabels = { draft: '待生成计划', pending: '待启用', paused: '已暂停', enabled: '已启用', ended: '已结束', deleted: '已删除' } as const
export type ScheduledTaskState =
  | { group: 'disabled'; state: 'draft' | 'pending' | 'paused' }
  | { group: 'enabled'; state: 'enabled' }
  | { group: 'enabled'; state: 'executing'; runStatus: ScheduledRunStatus }
  | { group: 'history'; state: 'ended' | 'deleted' }

export const terminalScheduledRuns: ReadonlySet<ScheduledRunStatus> = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'missed'])

export function indexScheduledRuns<T extends { definitionId: string }>(occurrences: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const run of occurrences) {
    const runs = index.get(run.definitionId)
    if (runs) runs.push(run)
    else index.set(run.definitionId, [run])
  }
  return index
}

type StateRun = Pick<ScheduledOccurrence, 'status' | 'scheduledAt'>

export function scheduledTaskState(item: ScheduledDefinition, runs: readonly StateRun[]): ScheduledTaskState {
  if (item.deleted) return { group: 'history', state: 'deleted' }
  if (item.enabled) return { group: 'enabled', state: 'enabled' }
  if (item.pausedAt != null) return { group: 'disabled', state: 'paused' }

  const unfinished = runs.filter(run => !terminalScheduledRuns.has(run.status))
    .reduce<StateRun | undefined>((latest, run) => !latest || run.scheduledAt > latest.scheduledAt ? run : latest, undefined)
  if (unfinished) return { group: 'enabled', state: 'executing', runStatus: unfinished.status }

  // The one-off scheduler disables the definition on dispatch. Only a run for
  // its current time can end that arrangement; old runs survive a reschedule.
  const once = (item.input.recurrence?.frequency ?? 'once') === 'once'
  if (once && runs.some(run => run.scheduledAt === item.input.scheduledAt)) return { group: 'history', state: 'ended' }
  return { group: 'disabled', state: item.plan ? 'pending' : 'draft' }
}

export interface ScheduledTaskEntry { definition: ScheduledDefinition; status: ScheduledTaskState }

export function groupScheduledTasks(definitions: readonly ScheduledDefinition[], runs: ReadonlyMap<string, readonly StateRun[]>): Record<ScheduledTaskGroup, ScheduledTaskEntry[]> {
  const groups: Record<ScheduledTaskGroup, ScheduledTaskEntry[]> = { disabled: [], enabled: [], history: [] }
  for (const definition of definitions) {
    const status = scheduledTaskState(definition, runs.get(definition.id) ?? [])
    groups[status.group].push({ definition, status })
  }
  const priority = (entry: ScheduledTaskEntry) => entry.status.state === 'pending' ? 0 : entry.status.state === 'draft' ? 1 : 2
  const latest = (a: ScheduledTaskEntry, b: ScheduledTaskEntry) => b.definition.updatedAt - a.definition.updatedAt || a.definition.id.localeCompare(b.definition.id)
  groups.disabled.sort((a, b) => priority(a) - priority(b) || latest(a, b))
  groups.enabled.sort(latest)
  groups.history.sort(latest)
  return groups
}
