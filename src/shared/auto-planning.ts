import type { ArrangementDraft, ArrangementDraftDocument, ArrangementPlanningProgress } from './types'

export interface PlanningRecordSummary extends Pick<ArrangementDraft, 'id' | 'owner' | 'title' | 'goal' | 'status' | 'revision' | 'createdAt' | 'updatedAt' | 'lastPlanning' | 'confirmedWorkPlanId'> {
  workDir: string | null
}

export interface PlanningProgressSnapshot {
  draftId: string
  owner: ArrangementDraft['owner']
  planningId: string
  modelId: string
  sequence: number
  events: ArrangementPlanningProgress[]
}

export interface PlanningRecordSnapshot {
  draft: ArrangementDraft
  progress: PlanningProgressSnapshot | null
}

export interface AutoPlanningInput {
  requestId: string
  modelId: string
  document: ArrangementDraftDocument
}

export interface PlanningRecordChange {
  owner: ArrangementDraft['owner']
  draftId: string
  record: PlanningRecordSummary | null
}

export function planningRecordSummary(draft: ArrangementDraft): PlanningRecordSummary {
  return { id: draft.id, owner: draft.owner, title: draft.title, goal: draft.goal, status: draft.status, revision: draft.revision,
    createdAt: draft.createdAt, updatedAt: draft.updatedAt, lastPlanning: draft.lastPlanning,
    confirmedWorkPlanId: draft.confirmedWorkPlanId, workDir: draft.workspace.path }
}
