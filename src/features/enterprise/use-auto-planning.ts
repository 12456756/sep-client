import { useEffect, useRef, useState } from 'react';
import type { ArrangementDraft, ArrangementPlanningProgress } from '../../shared/types';

interface PlanningAttempt {
  draftId: string | null;
  planningId: string | null;
  terminal: boolean;
}

/** IPC progress may arrive before invoke resolves. Keep one attempt until its terminal event. */
export function useAutoPlanning() {
  const [draft, setDraft] = useState<ArrangementDraft | null>(null);
  const [events, setEvents] = useState<ArrangementPlanningProgress[]>([]);
  const [planning, setPlanning] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<PlanningAttempt | null>(null);

  const fail = (current: PlanningAttempt, message: string): void => {
    if (attempt.current !== current) return;
    current.terminal = true;
    attempt.current = null;
    setPlanning(false);
    setCancellable(false);
    setDraft(null);
    setError(message);
  };

  useEffect(() => {
    const unsubscribe = window.electronAPI.onArrangementPlanningEvent(event => {
      const current = attempt.current;
      if (!current || current.terminal || event.draftId !== current.draftId) return;
      if (current.planningId && current.planningId !== event.planningId) return;
      current.planningId = event.planningId;
      setCancellable(true);
      setEvents(previous => [...previous, event]);
      if (event.type === 'arrangement_planning_failed' || event.type === 'arrangement_planning_cancelled') {
        fail(current, event.data.message || (event.type === 'arrangement_planning_failed' ? '自动编排失败，请重试' : '已取消自动编排，可修改目标后重试'));
      } else if (event.type === 'arrangement_planning_completed') {
        current.terminal = true;
        setCancellable(false);
        void (async () => {
          try {
            const result = await window.electronAPI.getArrangementDraft(event.draftId);
            if (attempt.current !== current) return;
            if (!result.success || !result.draft) throw new Error(result.error?.message || '读取编排草稿失败，请重试');
            setDraft(result.draft);
            setPlanning(false);
          } catch (cause) {
            fail(current, cause instanceof Error ? cause.message : '读取编排草稿失败，请重试');
          }
        })();
      }
    });
    return () => {
      unsubscribe();
      const current = attempt.current;
      attempt.current = null;
      if (current?.draftId && current.planningId && !current.terminal) {
        // Best-effort cleanup; there is no mounted view left to report a failure to.
        void window.electronAPI.cancelArrangementPlanning({ draftId: current.draftId, planningId: current.planningId }).catch(() => undefined);
      }
    };
  }, []);

  const start = async (goal: string, workDir: string): Promise<void> => {
    if (!goal.trim() || attempt.current && !attempt.current.terminal) return;
    const current: PlanningAttempt = { draftId: null, planningId: null, terminal: false };
    attempt.current = current;
    setPlanning(true);
    setCancellable(false);
    setDraft(null);
    setEvents([]);
    setError(null);
    try {
      const created = await window.electronAPI.createArrangementDraft({
        schemaVersion: 1, mode: 'auto', title: goal.trim().slice(0, 40), goal: goal.trim(),
        confirmedInputs: [], sharedSkillIds: [], conversation: null, nodes: [],
        workspace: { mode: 'shared', path: workDir || null }, permissions: { preset: 'read-only' }, lastPlanning: null,
      });
      if (attempt.current !== current) return;
      if (!created.success || !created.draft) throw new Error(created.error?.message || '自动编排草稿创建失败');
      current.draftId = created.draft.id;
      setDraft(created.draft);
      const planned = await window.electronAPI.planArrangementDraft({ draftId: created.draft.id, expectedRevision: created.draft.revision });
      if (current.terminal) return;
      if (!planned.success || !planned.planningId) throw new Error(planned.error?.message || '自动编排未能启动');
      if (attempt.current !== current) {
        await window.electronAPI.cancelArrangementPlanning({ draftId: created.draft.id, planningId: planned.planningId });
        return;
      }
      current.planningId = planned.planningId;
      setCancellable(true);
    } catch (cause) {
      if (!current.terminal) fail(current, cause instanceof Error ? cause.message : '自动编排失败');
    }
  };

  const cancel = async (): Promise<void> => {
    const current = attempt.current;
    if (!current?.draftId || !current.planningId || current.terminal) return;
    setCancellable(false);
    try {
      const result = await window.electronAPI.cancelArrangementPlanning({ draftId: current.draftId, planningId: current.planningId });
      if (attempt.current !== current || current.terminal) return;
      if (!result.success) throw new Error(result.error?.message || '取消自动编排失败');
      // A completed event wins a cancellation race. No event is required for successful cancellation.
      if (result.cancelled) fail(current, '已取消自动编排，可修改目标后重试');
      else setCancellable(true);
    } catch (cause) {
      if (attempt.current !== current || current.terminal) return;
      setError(cause instanceof Error ? cause.message : '取消自动编排失败');
      setCancellable(true);
    }
  };

  return { draft, setDraft, events, planning, cancellable, error, setError, start, cancel };
}
