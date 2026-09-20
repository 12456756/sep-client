import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArrangementPlanSnapshot, ClientTask, TaskExecutionEvent } from '../../shared/types';
import { runtimeKey } from '../../shared/work-activity';

function mergeEvents(current: TaskExecutionEvent[], incoming: TaskExecutionEvent[]): TaskExecutionEvent[] {
  const bySequence = new Map(current.map(event => [event.sequence, event]));
  incoming.forEach(event => { if (event.type.startsWith('arrangement_')) bySequence.set(event.sequence, event); });
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Read the existing plan/timeline IPC contracts, never reconstruct DAG state from a percentage. */
export function useArrangementPlans(tasks: ClientTask[]) {
  const [plans, setPlans] = useState<Record<string, ArrangementPlanSnapshot>>({});
  const [events, setEvents] = useState<Record<string, TaskExecutionEvent[]>>({});
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(new Map<string, string>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const requests = requested.current;
    return () => { mounted.current = false; requests.clear(); };
  }, []);

  const recordEvent = useCallback((event: TaskExecutionEvent): void => {
    if (!event.type.startsWith('arrangement_')) return;
    const key = runtimeKey(event.taskId, event.runId);
    setEvents(previous => ({ ...previous, [key]: mergeEvents(previous[key] ?? [], [event]) }));
  }, []);

  useEffect(() => {
    for (const task of tasks) {
      const requestKey = runtimeKey(task.id, task.activeRunId ?? '') + ':' + task.status;
      if (requested.current.get(task.id) === requestKey) continue;
      requested.current.set(task.id, requestKey);
      void (async () => {
        try {
          const [planResult, timeline] = await Promise.all([
            window.electronAPI.getArrangementPlan(task.id),
            task.activeRunId ? window.electronAPI.getTaskTimeline(task.id, task.activeRunId) : Promise.resolve(null),
          ]);
          if (!mounted.current || requested.current.get(task.id) !== requestKey) return;
          if (!planResult.success) throw new Error(planResult.error?.message || '编排计划加载失败');
          if (timeline && !timeline.success) throw new Error(timeline.error?.message || '工作执行记录加载失败');
          if (planResult.plan) setPlans(previous => ({ ...previous, [task.id]: planResult.plan! }));
          if (timeline?.events && task.activeRunId) {
            const key = runtimeKey(task.id, task.activeRunId);
            setEvents(previous => ({ ...previous, [key]: mergeEvents(previous[key] ?? [], timeline.events!) }));
          }
          setError(null);
        } catch (cause) {
          if (mounted.current) setError(cause instanceof Error ? cause.message : '工作计划加载失败');
        }
      })();
    }
  }, [tasks]);
  return { plans, events, recordEvent, error };
}
