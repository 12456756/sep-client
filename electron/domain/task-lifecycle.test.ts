import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { TaskStatus, type ClientTask } from '../../src/shared/types'
import { classifyTaskLifecycle, type ClassifyTaskLifecycleInput } from './task-lifecycle'

function task(status: ClientTask['status'], activeRunId: string | null): ClassifyTaskLifecycleInput['task'] {
  return { status, activeRunId, startedAt: 10, currentRunStartedAt: 10 }
}

describe('classifyTaskLifecycle', () => {
  it('keeps legacy pending records as not started', () => {
    assert.deepEqual(classifyTaskLifecycle({ task: task(TaskStatus.PENDING, null), runtime: null, run: null, checkpoint: null, missingForMs: null, missingGraceMs: 60_000 }),
      { kind: 'not-started', reason: 'no-active-run' })
  })

  it('recognizes runtime queue and worker ownership as live', () => {
    assert.deepEqual(classifyTaskLifecycle({ task: task(TaskStatus.PENDING, 'run-a'), runtime: { runId: 'run-a', phase: 'queued' }, run: null, checkpoint: null, missingForMs: 0, missingGraceMs: 60_000 }),
      { kind: 'live', reason: 'queued' })
    assert.deepEqual(classifyTaskLifecycle({ task: task(TaskStatus.RUNNING, 'run-a'), runtime: { runId: 'run-a', phase: 'running' }, run: null, checkpoint: null, missingForMs: 0, missingGraceMs: 60_000 }),
      { kind: 'live', reason: 'running' })
  })

  it('reconciles a terminal run only when the arrangement checkpoint agrees', () => {
    const finding = classifyTaskLifecycle({ task: task(TaskStatus.RUNNING, 'run-a'), runtime: null,
      run: { id: 'run-a', outcome: 'completed', startedAt: 20, endedAt: 40 },
      checkpoint: { activeRunId: null, lastRunId: 'run-a', status: 'completed', updatedAt: 39 }, missingForMs: 10_000, missingGraceMs: 60_000 })
    assert.deepEqual(finding, { kind: 'terminal-evidence', reason: 'run-terminal', targetStatus: TaskStatus.COMPLETED, endedAt: 40, startedAt: 20 })
  })

  it('requires a durable end time before trusting a terminal run', () => {
    const finding = classifyTaskLifecycle({ task: task(TaskStatus.RUNNING, 'run-a'), runtime: null,
      run: { id: 'run-a', outcome: 'completed', startedAt: 20, endedAt: null }, checkpoint: null,
      missingForMs: 10_000, missingGraceMs: 60_000 })
    assert.deepEqual(finding, { kind: 'missing', reason: 'run-record-missing' })
  })

  it('does not infer age from task creation when there is no lifecycle timestamp', () => {
    const finding = classifyTaskLifecycle({ task: { status: TaskStatus.RUNNING, activeRunId: null, startedAt: null, currentRunStartedAt: null },
      runtime: null, run: null, checkpoint: null, missingForMs: null, missingGraceMs: 1 })
    assert.deepEqual(finding, { kind: 'missing', reason: 'active-status-without-run' })
  })

  it('does not use an old checkpoint to complete a newer run', () => {
    const finding = classifyTaskLifecycle({ task: task(TaskStatus.RUNNING, 'run-new'), runtime: null,
      run: { id: 'run-new', outcome: 'running', startedAt: 30, endedAt: null },
      checkpoint: { activeRunId: null, lastRunId: 'run-old', status: 'completed', updatedAt: 20 }, missingForMs: 10_000, missingGraceMs: 60_000 })
    assert.deepEqual(finding, { kind: 'inconsistent', reason: 'checkpoint-run-mismatch' })
  })

  it('waits through missing-owner grace and classifies an old orphan as suspected lost', () => {
    const input = { task: task(TaskStatus.RUNNING, 'run-a'), runtime: null,
      run: { id: 'run-a', outcome: 'running' as const, startedAt: 10, endedAt: null }, checkpoint: null, missingGraceMs: 60_000 }
    assert.equal(classifyTaskLifecycle({ ...input, missingForMs: 59_999 }).kind, 'missing')
    assert.deepEqual(classifyTaskLifecycle({ ...input, missingForMs: 60_000 }), { kind: 'suspected-lost', reason: 'run-no-longer-active' })
    assert.equal(classifyTaskLifecycle({ ...input, missingForMs: null }).kind, 'missing')
  })

  it('protects user-stopped and terminal tasks from stale run evidence', () => {
    const run = { id: 'run-a', outcome: 'completed' as const, startedAt: 10, endedAt: 20 }
    assert.equal(classifyTaskLifecycle({ task: task(TaskStatus.PAUSED, 'run-a'), runtime: null, run, checkpoint: null, missingForMs: 99_000, missingGraceMs: 0 }).kind, 'protected')
    assert.equal(classifyTaskLifecycle({ task: task(TaskStatus.COMPLETED, null), runtime: null, run, checkpoint: null, missingForMs: null, missingGraceMs: 0 }).kind, 'protected')
  })

  it('requires explicit conversation metadata before trusting a terminal run without a checkpoint', () => {
    const input: ClassifyTaskLifecycleInput = { task: task(TaskStatus.RUNNING, 'run-a'), runtime: null,
      run: { id: 'run-a', outcome: 'completed', startedAt: 10, endedAt: 20 },
      checkpoint: null, missingForMs: 60_000, missingGraceMs: 60_000 }
    assert.equal(classifyTaskLifecycle(input).kind, 'missing')
    assert.equal(classifyTaskLifecycle({ ...input, run: { ...input.run!, executionKind: 'arrangement' } }).kind, 'missing')
    assert.equal(classifyTaskLifecycle({ ...input, run: { ...input.run!, executionKind: 'conversation' } }).kind, 'terminal-evidence')
    assert.deepEqual(classifyTaskLifecycle({ ...input, run: { ...input.run!, executionKind: 'conversation', arrangementNodeId: 'node' } }),
      { kind: 'inconsistent', reason: 'child-run-bound-as-parent' })
  })

  it('rejects contradictory terminal evidence and invalid timing', () => {
    const input: ClassifyTaskLifecycleInput = { task: task(TaskStatus.RUNNING, 'run-a'), runtime: null,
      run: { id: 'run-a', outcome: 'completed', startedAt: 10, endedAt: 20, executionKind: 'arrangement' },
      checkpoint: { activeRunId: null, lastRunId: 'run-a', status: 'completed', updatedAt: 19 },
      missingForMs: null, missingGraceMs: 60_000 }
    for (const status of ['running', 'failed', 'interrupted'] as const) {
      assert.equal(classifyTaskLifecycle({ ...input, checkpoint: { ...input.checkpoint!, status } }).kind, 'inconsistent')
    }
    assert.equal(classifyTaskLifecycle({ ...input, checkpoint: { ...input.checkpoint!, activeRunId: 'other-run' } }).kind, 'inconsistent')
    assert.equal(classifyTaskLifecycle({ ...input, checkpoint: { ...input.checkpoint!, updatedAt: Number.NaN } }).kind, 'inconsistent')
    for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, 21]) {
      assert.deepEqual(classifyTaskLifecycle({ ...input, run: { ...input.run!, startedAt } }),
        { kind: 'inconsistent', reason: 'run-time-invalid' })
    }
  })

  it('diagnoses an unbound runtime owner instead of treating it as a never-started task', () => {
    assert.deepEqual(classifyTaskLifecycle({ task: task(TaskStatus.PENDING, null),
      runtime: { runId: 'run-a', phase: 'starting' }, run: null, checkpoint: null, missingForMs: null, missingGraceMs: 60_000 }),
    { kind: 'inconsistent', reason: 'runtime-run-mismatch' })
  })
})
