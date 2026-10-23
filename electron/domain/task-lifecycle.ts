import { TaskStatus, type ClientTask, type ClientTaskStatus } from '../../src/shared/types'

export type TaskLifecycleRuntimePhase = 'queued' | 'starting' | 'running' | 'finalizing'

export interface TaskLifecycleRuntimeEvidence {
  runId: string
  phase: TaskLifecycleRuntimePhase
}

export interface TaskLifecycleRunEvidence {
  id: string
  outcome: 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped' | 'interrupted'
  startedAt: number
  endedAt: number | null
  executionKind?: 'conversation' | 'arrangement'
  arrangementNodeId?: string
}

export interface TaskLifecycleCheckpointEvidence {
  activeRunId: string | null
  lastRunId: string | null
  status: 'queued' | 'running' | 'waiting-user' | 'interrupted' | 'completed' | 'stopped' | 'failed'
  updatedAt: number
}

export type TaskLifecycleFinding =
  | { kind: 'not-started'; reason: 'no-active-run' }
  | { kind: 'live'; reason: TaskLifecycleRuntimePhase }
  | { kind: 'terminal-evidence'; reason: 'run-terminal'; targetStatus: ClientTaskStatus; endedAt: number; startedAt: number }
  | { kind: 'missing'; reason: 'run-record-missing' | 'run-owner-missing' | 'active-status-without-run' }
  | { kind: 'suspected-lost'; reason: 'run-no-longer-active' | 'admission-no-longer-active' }
  | { kind: 'inconsistent'; reason: 'runtime-run-mismatch' | 'checkpoint-run-mismatch' | 'checkpoint-not-terminal' | 'terminal-task-has-active-run' | 'child-run-bound-as-parent' | 'run-time-invalid' }
  | { kind: 'protected'; reason: 'user-paused-or-interrupted' | 'task-already-terminal' }

export interface ClassifyTaskLifecycleInput {
  task: Pick<ClientTask, 'status' | 'activeRunId' | 'currentRunStartedAt' | 'startedAt'>
  runtime: TaskLifecycleRuntimeEvidence | null
  run: TaskLifecycleRunEvidence | null
  checkpoint: TaskLifecycleCheckpointEvidence | null
  missingForMs: number | null
  missingGraceMs: number
}

function statusForOutcome(outcome: TaskLifecycleRunEvidence['outcome']): ClientTaskStatus | null {
  switch (outcome) {
    case 'completed': return TaskStatus.COMPLETED
    case 'failed': return TaskStatus.FAILED
    case 'cancelled':
    case 'stopped': return TaskStatus.PAUSED
    case 'interrupted': return TaskStatus.INTERRUPTED
    case 'running': return null
  }
}

function statusForCheckpoint(status: TaskLifecycleCheckpointEvidence['status']): ClientTaskStatus | null {
  switch (status) {
    case 'completed': return TaskStatus.COMPLETED
    case 'failed': return TaskStatus.FAILED
    case 'stopped':
    case 'waiting-user': return TaskStatus.PAUSED
    case 'interrupted': return TaskStatus.INTERRUPTED
    default: return null
  }
}

function isTaskTerminal(status: ClientTaskStatus): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.FAILED
}

export function classifyTaskLifecycle(input: ClassifyTaskLifecycleInput): TaskLifecycleFinding {
  const { task, runtime, run, checkpoint, missingForMs, missingGraceMs } = input
  if (task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED) {
    if (task.activeRunId && runtime?.runId === task.activeRunId) return { kind: 'live', reason: runtime.phase }
    return { kind: 'protected', reason: 'user-paused-or-interrupted' }
  }
  if (isTaskTerminal(task.status)) {
    return task.activeRunId
      ? { kind: 'inconsistent', reason: 'terminal-task-has-active-run' }
      : { kind: 'protected', reason: 'task-already-terminal' }
  }

  const activeRunId = task.activeRunId
  if (!activeRunId) {
    if (runtime) return { kind: 'inconsistent', reason: 'runtime-run-mismatch' }
    if (task.status === TaskStatus.PENDING) return { kind: 'not-started', reason: 'no-active-run' }
    if (missingForMs === null || missingForMs < missingGraceMs) return { kind: 'missing', reason: 'active-status-without-run' }
    return { kind: 'suspected-lost', reason: 'admission-no-longer-active' }
  }

  if (runtime) {
    return runtime.runId === activeRunId
      ? { kind: 'live', reason: runtime.phase }
      : { kind: 'inconsistent', reason: 'runtime-run-mismatch' }
  }

  if (run && run.id !== activeRunId) return { kind: 'inconsistent', reason: 'runtime-run-mismatch' }
  if (run?.arrangementNodeId) return { kind: 'inconsistent', reason: 'child-run-bound-as-parent' }
  if (checkpoint?.activeRunId && checkpoint.activeRunId !== activeRunId ||
      checkpoint?.lastRunId && checkpoint.lastRunId !== activeRunId) {
    return { kind: 'inconsistent', reason: 'checkpoint-run-mismatch' }
  }
  const checkpointMatchesRun = checkpoint !== null &&
    (checkpoint.lastRunId === activeRunId || checkpoint.activeRunId === activeRunId)
  const checkpointTarget = checkpointMatchesRun && checkpoint ? statusForCheckpoint(checkpoint.status) : null
  if (checkpointTarget && run?.outcome === 'running') {
    return { kind: 'inconsistent', reason: 'checkpoint-not-terminal' }
  }
  if (run && run.outcome !== 'running') {
    const targetStatus = statusForOutcome(run.outcome)
    if (!targetStatus) return { kind: 'missing', reason: 'run-record-missing' }
    if (run.endedAt === null || !Number.isFinite(run.endedAt)) return { kind: 'missing', reason: 'run-record-missing' }
    if (!Number.isFinite(run.startedAt) || run.startedAt < 0 || run.endedAt < run.startedAt) {
      return { kind: 'inconsistent', reason: 'run-time-invalid' }
    }
    if (run.executionKind !== 'conversation' && !checkpointMatchesRun) {
      return { kind: 'missing', reason: 'run-owner-missing' }
    }
    if (checkpointMatchesRun && (checkpointTarget !== targetStatus || !Number.isFinite(checkpoint!.updatedAt))) {
      return { kind: 'inconsistent', reason: 'checkpoint-not-terminal' }
    }
    return { kind: 'terminal-evidence', reason: 'run-terminal', targetStatus, endedAt: run.endedAt, startedAt: run.startedAt }
  }
  if (missingForMs === null || missingForMs < missingGraceMs) {
    return { kind: 'missing', reason: run ? 'run-owner-missing' : 'run-record-missing' }
  }
  return { kind: 'suspected-lost', reason: run ? 'run-no-longer-active' : 'admission-no-longer-active' }
}
