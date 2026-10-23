import type { ClientTask, WorkTypeReadResult } from '../../shared/types'

type ReadType = (task: ClientTask) => Promise<WorkTypeReadResult>
type ApplyType = (taskId: string, value: WorkTypeReadResult) => void

function fingerprint(task: ClientTask): string {
  return `${task.status}:${task.activeRunId ?? ''}:${task.completedAt ?? ''}:${task.startedAt ?? task.createdAt}`
}

function mergeWorkType(current: WorkTypeReadResult | undefined, incoming: WorkTypeReadResult | undefined): WorkTypeReadResult | undefined {
  // Classification is immutable; a failed read cannot revoke a confirmed type.
  if (incoming?.state === 'resolved') return incoming
  return current?.state === 'resolved' ? current : incoming ?? current
}

/** Deduplicates classification reads and prevents stale scope results from re-entering the renderer. */
export class TaskReadCache {
  private readonly values = new Map<string, WorkTypeReadResult>()
  private readonly pending = new Map<string, object>()
  private readonly attempted = new Map<string, string>()
  private retained = new Set<string>()
  private disposed = false

  constructor(private readonly read: ReadType, private readonly apply: ApplyType) {}

  ensure(task: ClientTask): void {
    if (this.disposed || task.workType?.state === 'resolved') return
    const id = task.id
    this.retained.add(id)
    if (this.values.get(id)?.state === 'resolved') return
    if (this.pending.has(id) || this.attempted.get(id) === fingerprint(task)) return
    const version = fingerprint(task)
    const token = {}
    this.pending.set(id, token)
    this.attempted.set(id, version)
    const settle = (value: WorkTypeReadResult): void => {
      if (this.disposed || !this.retained.has(id) || this.pending.get(id) !== token) return
      this.values.set(id, value)
      this.pending.delete(id)
      this.apply(id, value)
    }
    void this.read(task).then(settle).catch(() => settle({ state: 'unavailable' }))
  }

  retain(tasks: readonly ClientTask[]): void {
    this.retained = new Set(tasks.map(task => task.id))
    for (const task of tasks) {
      if (task.workType) {
        const workType = mergeWorkType(this.values.get(task.id), task.workType)!
        this.values.set(task.id, workType)
        if (workType.state === 'resolved') this.pending.delete(task.id)
      }
    }
    for (const id of this.values.keys()) if (!this.retained.has(id)) this.values.delete(id)
    for (const id of this.pending.keys()) if (!this.retained.has(id)) this.pending.delete(id)
    for (const id of this.attempted.keys()) if (!this.retained.has(id)) this.attempted.delete(id)
  }

  preserve(task: ClientTask): ClientTask {
    return { ...task, workType: mergeWorkType(this.values.get(task.id), task.workType) }
  }

  retry(task: ClientTask): void {
    if (this.pending.has(task.id)) return
    this.values.delete(task.id)
    this.attempted.delete(task.id)
    this.ensure({ ...task, workType: undefined })
  }

  dispose(): void {
    this.disposed = true
    this.retained.clear()
    this.pending.clear()
    this.values.clear()
    this.attempted.clear()
  }
}

export function mergeTaskUpdate(current: readonly ClientTask[], incoming: ClientTask, deletedIds?: ReadonlySet<string>): ClientTask[] {
  if (deletedIds?.size) {
    current = current.filter(task => !deletedIds.has(task.id))
    if (deletedIds.has(incoming.id)) return [...current]
  }
  const index = current.findIndex(task => task.id === incoming.id)
  if (index === -1) return [incoming, ...current]
  if (isStaleActiveUpdate(current[index]!, incoming)) return [...current]
  const next = [...current]
  next[index] = { ...incoming, workType: mergeWorkType(current[index].workType, incoming.workType) }
  return next
}

export function mergeTaskList(current: readonly ClientTask[], incoming: readonly ClientTask[], deletedIds?: ReadonlySet<string>): ClientTask[] {
  const byId = new Map(current.map(task => [task.id, task]))
  return incoming.filter(task => !deletedIds?.has(task.id))
    .map(task => {
      const existing = byId.get(task.id)
      if (existing && isStaleActiveUpdate(existing, task)) return existing
      return { ...task, workType: mergeWorkType(existing?.workType, task.workType) }
    })
}

function isStaleActiveUpdate(current: ClientTask, incoming: ClientTask): boolean {
  const userControlledOrTerminal = current.status === 'paused' || current.status === 'interrupted'
    || current.status === 'completed' || current.status === 'failed' || current.executionHealth === 'start-failed'
  const incomingActive = incoming.status === 'running'
    || (incoming.status === 'pending' && incoming.activeRunId !== null)
  const incomingTerminal = incoming.activeRunId === null
    && (incoming.status === 'paused' || incoming.status === 'interrupted' || incoming.status === 'completed' || incoming.status === 'failed')

  if (current.activeRunId !== null) {
    if (userControlledOrTerminal && incomingActive && incoming.activeRunId === current.activeRunId) return true
    if (incoming.activeRunId === current.activeRunId) return false
    return !(incomingTerminal && incoming.lastRunId === current.activeRunId)
  }
  if (incomingTerminal && current.lastRunId && incoming.lastRunId !== current.lastRunId) {
    const currentEnd = current.lastRunEndedAt ?? current.completedAt ?? current.startFailureAt
    const incomingEnd = incoming.lastRunEndedAt ?? incoming.completedAt
    if (currentEnd !== undefined && currentEnd !== null && (incomingEnd === undefined || incomingEnd === null || incomingEnd <= currentEnd)) return true
  }
  if (incomingTerminal && current.status === 'pending' && current.lastRunId === incoming.lastRunId) return true
  if (current.status === 'pending' && current.activeRunId === null && incomingActive
    && incoming.activeRunId === current.lastRunId) return true
  if (userControlledOrTerminal && incomingActive) {
    if (!incoming.activeRunId || incoming.activeRunId === current.lastRunId) return true
    const previousEnd = current.lastRunEndedAt ?? current.completedAt ?? current.startFailureAt ?? current.startedAt ?? current.createdAt
    const nextRunEvidence = incoming.currentRunStartedAt ?? incoming.queuedAt
    return nextRunEvidence === undefined || nextRunEvidence === null || nextRunEvidence < previousEnd
  }
  return false
}

export function mergeInitialTaskQuery(current: readonly ClientTask[], queried: readonly ClientTask[], pushedIds: ReadonlySet<string>, receivedList: boolean, deletedIds?: ReadonlySet<string>): ClientTask[] {
  if (deletedIds?.size) {
    current = current.filter(task => !deletedIds.has(task.id))
    queried = queried.filter(task => !deletedIds.has(task.id))
  }
  const queriedById = new Map(queried.map(task => [task.id, task]))
  const liveWithTypes = current.map(task => ({ ...task, workType: mergeWorkType(task.workType, queriedById.get(task.id)?.workType) }))
  if (receivedList) return liveWithTypes
  const currentById = new Map(liveWithTypes.map(task => [task.id, task]))
  return [...queried.map(task => {
    const live = currentById.get(task.id)
    if (!live) return task
    if (pushedIds.has(task.id) || isStaleActiveUpdate(live, task)) {
      return { ...live, workType: mergeWorkType(live.workType, task.workType) }
    }
    return { ...task, workType: mergeWorkType(live.workType, task.workType) }
  }),
    ...liveWithTypes.filter(task => !queriedById.has(task.id))]
}
