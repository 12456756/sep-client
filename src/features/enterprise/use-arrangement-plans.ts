import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArrangementPlanSnapshot, ClientTask, TaskExecutionEvent } from '../../shared/types';
import { runtimeKey } from '../../shared/work-activity';

function mergeEvents(current: TaskExecutionEvent[], incoming: TaskExecutionEvent[]): TaskExecutionEvent[] {
  const bySequence = new Map(current.map(event => [event.sequence, event]));
  incoming.forEach(event => { if (event.type.startsWith('arrangement_')) bySequence.set(event.sequence, event); });
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Read the existing plan/timeline IPC contracts, never reconstruct DAG state from a percentage. */
export function useArrangementPlans(tasks: ClientTask[], scopeKey: string) {
  const [plans, setPlans] = useState<Record<string, ArrangementPlanSnapshot>>({});
  const [events, setEvents] = useState<Record<string, TaskExecutionEvent[]>>({});
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(new Map<string, string>());
  const mounted = useRef(false);
  const scope = useRef({ key: scopeKey, generation: 0 });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const [loadedScope, setLoadedScope] = useState(scopeKey);
  useEffect(() => {
    requested.current.clear();
    setPlans({});
    setEvents({});
    setError(null);
    setLoadedScope(scopeKey);
  }, [scopeKey]);
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
      // Raw creation events precede plan persistence; the classified query waits for that commit.
      if (!task.workType) {
        requested.current.delete(task.id);
        continue;
      }
      const typeKey = task.workType.state === 'resolved' ? task.workType.kind : task.workType.state;
      const requestKey = runtimeKey(task.id, task.activeRunId ?? '') + ':' + task.status + ':' + typeKey;
      if (requested.current.get(task.id) === requestKey) continue;
      requested.current.set(task.id, requestKey);
      const isCurrent = () => mounted.current && scope.current.generation === generation && requested.current.get(task.id) === requestKey;
      void (async () => {
        try {
          const result = await window.electronAPI.getArrangementPlan(task.id);
          if (!isCurrent()) return;
          if (!result.success) throw new Error(result.error?.message || '编排计划加载失败');
          if (result.plan) setPlans(previous => ({ ...previous, [task.id]: result.plan! }));
        } catch (cause) {
          if (isCurrent()) setError(cause instanceof Error ? cause.message : '工作计划加载失败');
        }
      })();
      if (task.activeRunId) void (async () => {
        try {
          const timeline = await window.electronAPI.getTaskTimeline(task.id, task.activeRunId!);
          if (!isCurrent()) return;
          if (!timeline.success) throw new Error(timeline.error?.message || '工作执行记录加载失败');
          if (timeline.events) {
            const key = runtimeKey(task.id, task.activeRunId!);
            setEvents(previous => ({ ...previous, [key]: mergeEvents(previous[key] ?? [], timeline.events!) }));
          }
        } catch (cause) {
          if (isCurrent()) setError(cause instanceof Error ? cause.message : '工作执行记录加载失败');
        }
      })();
    }
  }, [tasks, generation]);
  return { plans: loadedScope === scopeKey ? plans : {}, events: loadedScope === scopeKey ? events : {}, recordEvent, error };
}
