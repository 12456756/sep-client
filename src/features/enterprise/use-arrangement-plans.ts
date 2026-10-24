import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArrangementExecutionSnapshot, ArrangementPlanSnapshot, ClientTask, TaskExecutionEvent } from '../../shared/types';
import { runtimeKey } from '../../shared/work-activity';

const EXECUTION_REFRESH_INTERVAL = 5000

function mergeEvents(current: TaskExecutionEvent[], incoming: TaskExecutionEvent[]): TaskExecutionEvent[] {
  const bySequence = new Map(current.map(event => [event.sequence, event]));
  incoming.forEach(event => { if (event.type.startsWith('arrangement_')) bySequence.set(event.sequence, event); });
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Read the existing plan/timeline IPC contracts, never reconstruct DAG state from a percentage. */
export function useArrangementPlans(tasks: ClientTask[], scopeKey: string) {
  const [plans, setPlans] = useState<Record<string, ArrangementPlanSnapshot>>({});
  const [events, setEvents] = useState<Record<string, TaskExecutionEvent[]>>({});
  const [executions, setExecutions] = useState<Record<string, ArrangementExecutionSnapshot | null>>({});
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(new Map<string, { key: string }>());
  const executionInFlight = useRef(new Map<string, { request: { key: string }; generation: number }>());
  const executionPending = useRef(new Map<string, { request: { key: string }; generation: number }>());
  const mounted = useRef(false);
  const scope = useRef({ key: scopeKey, generation: 0 });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const [loadedScope, setLoadedScope] = useState(scopeKey);
  useEffect(() => {
    requested.current.clear();
    setPlans({});
    setEvents({});
    setExecutions({});
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

  const loadExecution = useCallback((taskId: string, request: { key: string }, requestGeneration: number): void => {
    if (!mounted.current || scope.current.generation !== requestGeneration || requested.current.get(taskId) !== request) return
    const inFlight = executionInFlight.current.get(taskId)
    if (inFlight) {
      if (inFlight.request !== request || inFlight.generation !== requestGeneration) executionPending.current.set(taskId, { request, generation: requestGeneration })
      return
    }
    executionInFlight.current.set(taskId, { request, generation: requestGeneration })
    void (async () => {
      const isCurrent = () => mounted.current && scope.current.generation === requestGeneration && requested.current.get(taskId) === request
      try {
        const result = await window.electronAPI.getArrangementExecution(taskId)
        if (!isCurrent()) return
        if (!result.success) throw new Error(result.error?.message || '编排执行状态加载失败')
        setExecutions(previous => ({ ...previous, [taskId]: result.execution ?? null }))
      } catch (cause) {
        if (isCurrent()) setError(cause instanceof Error ? cause.message : '编排执行状态加载失败')
      } finally {
        executionInFlight.current.delete(taskId)
        const pending = executionPending.current.get(taskId)
        executionPending.current.delete(taskId)
        if (pending && mounted.current && requested.current.get(taskId) === pending.request && scope.current.generation === pending.generation) {
          queueMicrotask(() => loadExecution(taskId, pending.request, pending.generation))
        }
      }
    })()
  }, []);

  useEffect(() => {
    const taskIds = new Set(tasks.map(task => task.id));
    for (const id of requested.current.keys()) {
      if (!taskIds.has(id)) requested.current.delete(id);
    }
    for (const task of tasks) {
      // Raw creation events precede plan persistence; the classified query waits for that commit.
      if (!task.workType) {
        requested.current.delete(task.id);
        continue;
      }
      const typeKey = task.workType.state === 'resolved' ? task.workType.kind : task.workType.state;
      const requestKey = runtimeKey(task.id, task.activeRunId ?? '') + ':' + task.status + ':' + typeKey;
      if (requested.current.get(task.id)?.key === requestKey) continue;
      const request = { key: requestKey };
      requested.current.set(task.id, request);
      const isCurrent = () => mounted.current && scope.current.generation === generation && requested.current.get(task.id) === request;
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
      if (task.workType.state === 'resolved' && task.workType.kind === 'arrangement') loadExecution(task.id, request, generation)
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
  }, [tasks, generation, loadExecution]);

  // Media providers can finish without producing a model event. Refresh only the
  // local execution snapshot at a low rate so the page reflects delivery progress
  // without adding another provider polling loop or overlapping IPC calls.
  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      for (const task of tasks) {
        if (!active || task.workType?.state !== 'resolved' || task.workType.kind !== 'arrangement' ||
          (task.status !== 'running' && task.status !== 'pending' && task.status !== 'waiting_approval' && !task.activeRunId)) continue
        const request = requested.current.get(task.id)
        if (!request) continue
        loadExecution(task.id, request, generation)
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, EXECUTION_REFRESH_INTERVAL)
    return () => { active = false; window.clearInterval(timer) }
  }, [tasks, generation, loadExecution]);
  return { plans: loadedScope === scopeKey ? plans : {}, events: loadedScope === scopeKey ? events : {}, executions: loadedScope === scopeKey ? executions : {}, recordEvent, error };
}
