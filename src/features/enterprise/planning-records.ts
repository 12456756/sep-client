import type { PlanningRecordSummary } from '../../shared/auto-planning'
import type { WorkItem } from './types'

export function planningRecordWork(record: PlanningRecordSummary): WorkItem {
  const cancelled = record.lastPlanning?.status === 'cancelled'
  const status = record.status === 'planning-failed' ? 'failed' : cancelled ? 'paused'
    : ['ready', 'preflight-failed', 'awaiting-employee'].includes(record.status) ? 'waiting-user' : 'arranging'
  const nextUserAction = record.status === 'awaiting-employee' ? '待匹配员工' : status === 'waiting-user' ? '待确认计划' : null
  return { id: record.id, recordKey: record.id, planningDraft: record, title: record.title || record.goal, goal: record.goal, kind: 'flow',
    workType: { state: 'resolved', kind: 'arrangement' }, status, isActive: false, progress: 0, currentEmployeeId: '', currentEmployeeName: '自动编排',
    steps: [], nextUserAction, createdAt: record.createdAt, updatedAt: record.updatedAt, startedAt: null, completedAt: null,
    participants: [], deliverables: [], timeline: [], messages: [], activities: [],
    sharedContext: { goal: record.goal, confirmedInputs: [], previousResults: [], userNotes: [] }, stopReason: cancelled ? '已取消规划' : null, workDir: record.workDir }
}

export function mergePlanningRecords(tasks: WorkItem[], records: readonly PlanningRecordSummary[], deletedTaskIds: ReadonlySet<string> = new Set()): WorkItem[] {
  const replacements = new Map(records.filter(record => record.confirmedWorkPlanId).map(record => [record.confirmedWorkPlanId!, record]))
  const classified = new Set(tasks.filter(task => task.workType.state === 'resolved').map(task => task.id))
  const merged: WorkItem[] = tasks.filter(task => !replacements.has(task.id) || classified.has(task.id)).map(task => ({ ...task, recordKey: replacements.get(task.id)?.id ?? task.id }))
  for (const record of records) {
    if (record.confirmedWorkPlanId && deletedTaskIds.has(record.confirmedWorkPlanId)) continue
    if (record.confirmedWorkPlanId && classified.has(record.confirmedWorkPlanId)) continue
    merged.push(planningRecordWork(record))
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt)
}
