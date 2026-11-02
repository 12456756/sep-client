import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react'
import type { ArrangementDraft, ArrangementDraftDocument, ArrangementPlanningProgress } from '../../shared/types'
import type { KnowledgeSelection } from '../../shared/knowledge-selection'
import type { AttachmentRef } from '../../shared/attachment-contracts'
import { recoverDraftRevisionConflict, responseError } from '../../shared/arrangement-feedback'
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback'
import { usePlanningController } from './auto-planning-scope'
const EMPTY_EVENTS: ArrangementPlanningProgress[] = []

export function useAutoPlanning(bindingKey = '', recordId?: string, onRecorded?: (draftId: string) => void) {
  const controller = usePlanningController()
  const [localId, setLocalId] = useState<string | null>(null)
  const id = recordId ?? localId
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const { capture } = useOperationFeedback(bindingKey)
  const snapshot = useSyncExternalStore(
    useCallback(listener => controller && id ? controller.subscribeRecord(id, listener) : () => {}, [controller, id]),
    useCallback(() => id ? controller?.getRecord(id) : undefined, [controller, id]),
    () => undefined,
  )
  const draft = snapshot?.draft ?? null
  const events = snapshot?.progress?.events ?? EMPTY_EVENTS
  const planning = submitting || draft?.status === 'planning'
  const cancellable = draft?.status === 'planning' && Boolean(draft.lastPlanning?.planningId)
  const reload = useCallback(async () => {
    if (!id || !controller) return
    const notice = capture()
    setLoadFailed(false)
    try { await controller.load(id) }
    catch (error) { if (notice.isCurrent()) setLoadFailed(true); notice.fail(error, 'read') }
  }, [id, controller, capture])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (draft?.status !== 'planning-failed') return
    capture().show(draft.lastPlanning?.message || '自动编排失败，请联系平台管理员', 'error', `planning:${draft.id}:${draft.lastPlanning?.planningId}`, true)
  }, [draft?.status, draft?.id, draft?.lastPlanning?.planningId, draft?.lastPlanning?.message, capture])

  const setDraft = (value: SetStateAction<ArrangementDraft | null>): void => {
    const next = typeof value === 'function' ? value(draft) : value
    if (next) controller?.updateDraft(next)
    else setLocalId(null)
  }
  const start = async (goal: string, workDir: string, modelId: string, attachmentRefs: AttachmentRef[] = [], attachmentSessionId?: string, mustUseAttachments = true, permissions: ArrangementDraftDocument['permissions'] = { preset: 'read-only' }, knowledge?: KnowledgeSelection): Promise<void> => {
    if (submittingRef.current || !controller) return
    const notice = capture()
    if (!goal.trim() || !modelId) { notice.show(!goal.trim() ? '请填写工作目标' : '请选择需要使用的模型', 'warning'); return }
    submittingRef.current = true; setSubmitting(true)
    try {
      const result = await controller.start({ requestId: crypto.randomUUID(), modelId, document: {
        schemaVersion: 1, mode: 'auto', title: goal.trim().slice(0, 40), goal: goal.trim(), knowledge, confirmedInputs: [], sharedSkillIds: [], conversation: null, nodes: [],
        attachmentCandidates: attachmentRefs.map(attachment => ({ attachment, mustUse: mustUseAttachments })), attachmentSessionId,
        workspace: { mode: 'shared', path: workDir || null }, permissions, lastPlanning: null,
      } })
      if (!result || !notice.isCurrent()) return
      setLocalId(result.draft.id)
      onRecorded?.(result.draft.id)
    } catch (error) { notice.fail(error, 'planning') }
    finally { submittingRef.current = false; if (notice.isCurrent()) setSubmitting(false) }
  }
  const cancel = async (): Promise<void> => {
    if (!draft?.lastPlanning || draft.status !== 'planning') return
    const notice = capture()
    try {
      const result = await window.electronAPI.cancelArrangementPlanning({ draftId: draft.id, planningId: draft.lastPlanning.planningId })
      if (!result.success) throw responseError(result, 'cancel')
      await controller?.load(draft.id)
    } catch (error) { notice.fail(error, 'cancel') }
  }
  const recheckDraft = async (target: ArrangementDraft, modelId: string): Promise<void> => {
    if (submittingRef.current || !controller) return
    submittingRef.current = true
    const notice = capture()
    if (!modelId) { submittingRef.current = false; notice.show('请选择需要使用的模型', 'warning'); return }
    try {
      const result = await window.electronAPI.planArrangementDraft({ draftId: target.id, expectedRevision: target.revision, modelId })
      if (!result.success) throw responseError(result, 'planning')
      await controller.load(target.id)
    } catch (error) {
      if (!notice.isCurrent()) return
      if (!await recoverDraftRevisionConflict(error, () => controller.load(target.id), cause => notice.fail(cause, 'read'))) notice.fail(error, 'planning')
    }
    finally { submittingRef.current = false }
  }
  const access = async (input: { stepId: string; employeeId: string } | { requestId: string }): Promise<void> => {
    if (!draft || planning) return
    const notice = capture()
    try {
      const result = 'requestId' in input ? await window.electronAPI.getEmployeeAccessRequest({ draftId: draft.id, ...input })
        : await window.electronAPI.requestEmployeeAccess({ draftId: draft.id, expectedRevision: draft.revision, ...input })
      if (!result.success || !result.draft) throw responseError(result, 'request')
      if (notice.isCurrent()) controller?.updateDraft(result.draft)
    } catch (error) {
      if (!notice.isCurrent()) return
      if (!await recoverDraftRevisionConflict(error, () => controller?.load(draft.id) ?? Promise.resolve(), cause => notice.fail(cause, 'read'))) notice.fail(error, 'request')
    }
  }
  return { draft, setDraft, events, planning, cancellable, start, cancel, loadFailed, reload,
    requestEmployeeAccess: (stepId: string, employeeId: string) => access({ stepId, employeeId }),
    refreshEmployeeAccess: (requestId: string) => access({ requestId }),
    recheck: async () => { if (draft) await recheckDraft(draft, draft.planningModelId ?? snapshot?.progress?.modelId ?? '') },
    recheckDraft,
  }
}
