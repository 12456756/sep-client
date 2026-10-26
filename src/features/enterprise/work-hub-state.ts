import type { AppRoute, WorkItem } from './types'
import { readWorkRecordFilters, type WorkRecordFilterState } from './work-record-filters'

export interface WorkHubState {
  filters: WorkRecordFilterState
  selectedWorkId: string | null
}

export function enterWorkHubRoute(state: WorkHubState, route: AppRoute): WorkHubState {
  if (route.name === 'records') return { ...state, filters: readWorkRecordFilters(route) }
  if (route.name === 'work') return { ...state, selectedWorkId: route.workId }
  return state
}

export type StatusIndicator = 'running' | 'attention' | 'completed' | 'failed' | 'paused' | 'unstarted' | 'queued'
export function workStatusIndicator(work: Pick<WorkItem, 'status' | 'queuedAt' | 'isActive' | 'currentRunStartedAt'>): StatusIndicator {
  if (work.status === 'failed') return 'failed'
  if (work.status === 'waiting-user') return 'attention'
  if (work.status === 'completed') return 'completed'
  if (work.status === 'paused') return 'paused'
  if (work.queuedAt && !work.currentRunStartedAt) return 'queued'
  return work.status === 'running' ? 'running' : 'unstarted'
}

type OrderWork = Pick<WorkItem, 'id' | 'status' | 'isActive' | 'currentEmployeeId' | 'workType' | 'updatedAt' | 'pinnedAt'>
export interface WorkOrderSnapshot { signature: string; ids: string[] }

/** Message/token timestamps update previews without moving the row beneath the pointer. */
export function refreshWorkOrder(works: readonly OrderWork[], previous?: WorkOrderSnapshot): WorkOrderSnapshot {
  const signature = JSON.stringify([...works].sort((a, b) => a.id.localeCompare(b.id)).map(work => [work.id, work.status, work.isActive, work.currentEmployeeId, work.workType, work.pinnedAt ?? null]))
  if (previous?.signature === signature) return previous
  return { signature, ids: [...works].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt).map(work => work.id) }
}

export function applyWorkOrder<T extends { id: string; pinnedAt?: number | null }>(works: readonly T[], order: WorkOrderSnapshot): T[] {
  const ranks = new Map(order.ids.map((id, index) => [id, index]))
  return [...works].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity))
}
