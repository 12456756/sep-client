import { useEffect, useRef, useState } from 'react'
import type { ArrangementDraft, ArrangementPlanningProgress } from '../../shared/types'
import type { AttachmentRef } from '../../shared/attachment-contracts'
import type { KnowledgeSelection } from '../../shared/knowledge-selection'
import { responseError } from '../../shared/arrangement-feedback'
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback'

type Notice = ReturnType<ReturnType<typeof useOperationFeedback>['capture']>
interface PlanningAttempt {
  draftId: string | null
  planningId: string | null
  minRevision: number
  terminal: boolean
  notice: Notice
}

/** An attempt owns its IPC reply and terminal event, including events arriving first. */
export function useAutoPlanning(bindingKey = '') {
  const [draft, setDraft] = useState<ArrangementDraft | null>(null)
  const [events, setEvents] = useState<ArrangementPlanningProgress[]>([])
  const [planning, setPlanning] = useState(false)
  const [cancellable, setCancellable] = useState(false)
  const { capture } = useOperationFeedback(bindingKey)
  const attempt = useRef<PlanningAttempt | null>(null)
  const planningModelId = useRef<string | null>(null)
  const hasAttempt = () => attempt.current !== null
  const draftRef = useRef(draft)
  draftRef.current = draft

  const finish = (current: PlanningAttempt, error?: unknown): void => {
    if (attempt.current !== current || !current.notice.isCurrent()) return
    current.terminal = true
    attempt.current = null
    setPlanning(false)
    setCancellable(false)
    if (error !== undefined) current.notice.fail(error, 'planning', `planning:${current.draftId}:${current.planningId}`)
  }

  useEffect(() => {
    setDraft(null)
    setEvents([])
    setPlanning(false)
    setCancellable(false)
    planningModelId.current = null
    const unsubscribe = window.electronAPI.onArrangementPlanningEvent(event => {
      const current = attempt.current
      if (!current || current.terminal || !current.notice.isCurrent() || event.draftId !== current.draftId) return
      if (event.draftRevision < current.minRevision) return
      if (current.planningId && current.planningId !== event.planningId) return
      current.planningId = event.planningId
      setEvents(previous => [...previous, event])
      if (event.type === 'arrangement_planning_failed') {
        finish(current, responseError({ error: event.data.message ? { message: event.data.message } : undefined }, 'planning'))
      } else if (event.type === 'arrangement_planning_cancelled') {
        finish(current)
      } else if (event.type === 'arrangement_planning_completed') {
        current.terminal = true
        setCancellable(false)
        void (async () => {
          try {
            const result = await window.electronAPI.getArrangementDraft(event.draftId)
            if (attempt.current !== current || !current.notice.isCurrent()) return
            if (!result.success || !result.draft) throw responseError(result, 'read')
            setDraft(result.draft)
            finish(current)
          } catch (error) { finish(current, error) }
        })()
      } else setCancellable(true)
    })
    return () => {
      unsubscribe()
      const current = attempt.current
      attempt.current = null
      if (current?.draftId && current.planningId && !current.terminal) {
        void window.electronAPI.cancelArrangementPlanning({ draftId: current.draftId, planningId: current.planningId }).catch(() => undefined)
      }
    }
    // Each listener is bound to the mounted workspace identity.
  }, [bindingKey])

  const plan = async (current: PlanningAttempt, target: ArrangementDraft, modelId: string): Promise<void> => {
    current.draftId = target.id
    current.minRevision = target.revision + 1
    const result = await window.electronAPI.planArrangementDraft({ draftId: target.id, expectedRevision: target.revision, modelId })
    if (current.terminal) return
    if (!result.success || !result.planningId) throw responseError(result, 'planning')
    if (attempt.current !== current || !current.notice.isCurrent()) {
      void window.electronAPI.cancelArrangementPlanning({ draftId: target.id, planningId: result.planningId }).catch(() => undefined)
      return
    }
    current.planningId = result.planningId
    setCancellable(true)
  }

  const beginAttempt = (modelId: string): PlanningAttempt => {
    planningModelId.current = modelId
    const current: PlanningAttempt = { draftId: null, planningId: null, minRevision: 0, terminal: false, notice: capture() }
    attempt.current = current
    setPlanning(true)
    setCancellable(false)
    setEvents([])
    return current
  }

  const start = async (goal: string, workDir: string, modelId: string, attachmentRefs: AttachmentRef[] = [], attachmentSessionId?: string, mustUseAttachments = true, knowledge?: KnowledgeSelection): Promise<void> => {
    if (hasAttempt()) return
    if (!goal.trim() || !modelId) { capture().show(!goal.trim() ? '请填写工作目标' : '请选择需要使用的模型', 'warning'); return }
    const current = beginAttempt(modelId)
    setDraft(null)
    try {
      const result = await window.electronAPI.createArrangementDraft({
        schemaVersion: 1, mode: 'auto', title: goal.trim().slice(0, 40), goal: goal.trim(),
        knowledge,
        confirmedInputs: [], sharedSkillIds: [], conversation: null, nodes: [],
        attachmentCandidates: attachmentRefs.map(attachment => ({ attachment, mustUse: mustUseAttachments })), attachmentSessionId,
        workspace: { mode: 'shared', path: workDir || null }, permissions: { preset: 'read-only' }, lastPlanning: null,
      })
      if (attempt.current !== current || !current.notice.isCurrent()) return
      if (!result.success || !result.draft) throw responseError(result, 'create')
      setDraft(result.draft)
      await plan(current, result.draft, modelId)
    } catch (error) { if (!current.terminal) finish(current, error) }
  }

  const cancel = async (): Promise<void> => {
    const current = attempt.current
    if (!current?.draftId || !current.planningId || current.terminal) return
    setCancellable(false)
    try {
      const result = await window.electronAPI.cancelArrangementPlanning({ draftId: current.draftId, planningId: current.planningId })
      if (attempt.current !== current || current.terminal || !current.notice.isCurrent()) return
      if (!result.success) throw responseError(result, 'cancel')
      if (result.cancelled) finish(current)
      else setCancellable(true)
    } catch (error) {
      if (attempt.current !== current || current.terminal || !current.notice.isCurrent()) return
      current.notice.fail(error, 'cancel')
      setCancellable(true)
    }
  }

  const access = async (input: { stepId: string; employeeId: string } | { requestId: string }): Promise<void> => {
    if (!draft || planning) return
    const target = draft
    const notice = capture()
    const operation = 'requestId' in input ? 'requestStatus' : 'request'
    try {
      const result = 'requestId' in input
        ? await window.electronAPI.getEmployeeAccessRequest({ draftId: target.id, requestId: input.requestId })
        : await window.electronAPI.requestEmployeeAccess({ draftId: target.id, expectedRevision: target.revision, ...input })
      if (!notice.isCurrent() || draftRef.current?.id !== target.id) return
      if (!result.success || !result.draft) throw responseError(result, operation)
      setDraft(result.draft)
    } catch (error) { if (draftRef.current?.id === target.id) notice.fail(error, operation) }
  }

  const recheckDraft = async (target: ArrangementDraft, modelId: string, force = false): Promise<void> => {
    if (attempt.current || planning && !force) return
    const current = beginAttempt(modelId)
    setDraft(target)
    try { await plan(current, target, modelId) }
    catch (error) { if (!current.terminal) finish(current, error) }
  }

  return {
    draft, setDraft, events, planning, cancellable, start, cancel,
    requestEmployeeAccess: (stepId: string, employeeId: string) => access({ stepId, employeeId }),
    refreshEmployeeAccess: (requestId: string) => access({ requestId }),
    recheck: async () => { if (draft && planningModelId.current) await recheckDraft(draft, planningModelId.current) },
    recheckDraft,
  }
}
