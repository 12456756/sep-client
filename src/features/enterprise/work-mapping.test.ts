import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildWorkItem, encodeWorkPrompt, getArrangementDisplayEvents } from './work-mapping'
import type { ArrangementPlanSnapshot, ClientTask, TaskExecutionEvent } from '../../shared/types'

const prompt = encodeWorkPrompt('整理资料', {
  kind: 'conversation', goal: '请整理这份资料', steps: [], participants: ['employee-a'],
  sharedContext: { goal: '请整理这份资料', confirmedInputs: [], previousResults: [], userNotes: [] },
})
const task: ClientTask = {
  id: 'task-a', title: '整理资料', prompt, status: 'running', workDir: null,
  createdAt: 1, startedAt: 2, completedAt: null, error: null, files: [], logs: [],
  ownerId: 'member-a', ownerEnterpriseId: 'enterprise-a', subscriptionId: 'employee-a', activeRunId: 'run-a',
}

describe('arrangement retry display regressions', () => {
  const plan: ArrangementPlanSnapshot = {
    id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1,
    owner: { memberId: 'member-a', enterpriseId: 'enterprise-a' },
    mode: 'auto', title: task.title, goal: 'goal', conversation: null,
    nodes: [{ id: 'node-a', subscriptionId: 'employee-a', modelId: 'model-a', title: 'Node A', instruction: 'do A', expectedOutput: 'output', dependsOn: [], skillIds: [], requiresUserConfirmation: false }],
    workspace: { mode: 'shared', path: null },
    permissions: { preset: 'read-only', allowedTools: [], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled', approvalMode: 'confirm-each' },
    confirmedInputs: [], planHash: 'hash', createdAt: 1,
  }
  const failed: TaskExecutionEvent = {
    taskId: task.id, runId: 'run-a', subscriptionId: 'employee-a', sequence: 1,
    type: 'arrangement_state_changed', occurredAt: 3, data: { nodeId: 'node-a', nodeStatus: 'failed', status: 'waiting-user' },
  }

  it('shows a paused arrangement waiting for a failed node retry as failed', () => {
    const work = buildWorkItem({ task: { ...task, status: 'paused', error: '429' }, employees: [], plan, arrangementEvents: [failed] })
    assert.equal(work.status, 'failed')
    assert.equal(work.stopReason, '429')
    assert.equal(work.steps[0]?.state, 'failed')
  })

  it('keeps completed predecessors visible from the retry checkpoint snapshot', () => {
    const snapshot: TaskExecutionEvent = { ...failed, runId: 'retry-run', data: {
      status: 'running', nodeStates: [{ nodeId: 'node-a', status: 'completed' }],
    } }
    const work = buildWorkItem({ task, employees: [], plan, arrangementEvents: [snapshot] })
    assert.equal(work.steps[0]?.state, 'done')
  })

  it('retains completed progress while the retry run is queued or has no snapshot', () => {
    const serialPlan = { ...plan, nodes: [plan.nodes[0], { ...plan.nodes[0], id: 'node-b', dependsOn: ['node-a'] }] }
    const completed: TaskExecutionEvent = { ...failed, type: 'arrangement_node_completed', data: { nodeId: 'node-a' } }
    const failedB: TaskExecutionEvent = { ...failed, sequence: 2, data: { nodeId: 'node-b', nodeStatus: 'failed', status: 'waiting-user' } }
    const started: TaskExecutionEvent = { ...failed, runId: 'retry-run', type: 'arrangement_node_started', data: { nodeId: 'node-b' } }
    for (const current of [[], [started]]) {
      const events = getArrangementDisplayEvents({ 'task-a:run-a': [completed, failedB], 'task-a:retry-run': current }, task.id, 'retry-run')
      const work = buildWorkItem({ task: { ...task, status: current.length ? 'running' : 'pending', activeRunId: 'retry-run' }, employees: [], plan: serialPlan, arrangementEvents: events })
      assert.equal(work.progress, 50)
      assert.equal(work.steps[0]?.state, 'done')
      assert.equal(work.steps[1]?.state, current.length ? 'running' : 'pending')
    }
  })

  it('retains completed nodes from an earlier retry snapshot without borrowing another task', () => {
    const snapshot: TaskExecutionEvent = { ...failed, data: { nodeStates: [{ nodeId: 'node-a', status: 'completed' }] } }
    const foreign: TaskExecutionEvent = { ...snapshot, taskId: 'task-b' }
    const events = getArrangementDisplayEvents({ 'task-a:run-a': [snapshot], 'task-b:run-a': [foreign] }, task.id, 'retry-run')
    assert.equal(buildWorkItem({ task, employees: [], plan, arrangementEvents: events }).progress, 100)
    assert.deepEqual(getArrangementDisplayEvents({ 'task-b:run-a': [foreign] }, task.id, 'retry-run'), [])
  })

  it('uses the new run snapshot as authoritative once it arrives', () => {
    const completed: TaskExecutionEvent = { ...failed, type: 'arrangement_node_completed', data: { nodeId: 'node-a' } }
    const current: TaskExecutionEvent[] = [{ ...failed, runId: 'retry-run', data: { nodeStates: [{ nodeId: 'node-a', status: 'ready' }] } }]
    const events = getArrangementDisplayEvents({ 'task-a:run-a': [completed], 'task-a:retry-run': current }, task.id, 'retry-run')
    assert.equal(events, current)
    assert.equal(buildWorkItem({ task, employees: [], plan, arrangementEvents: events }).steps[0]?.state, 'pending')
  })

  it('does not mistake an explicitly stopped arrangement for a retryable failure', () => {
    const stopped: TaskExecutionEvent = { ...failed, sequence: 2, type: 'stop_requested', data: { reason: 'user stopped' } }
    const work = buildWorkItem({ task: { ...task, status: 'paused', error: 'user stopped' }, employees: [], plan, arrangementEvents: [failed, stopped] })
    assert.equal(work.status, 'paused')
  })
})

describe('conversation display regressions', () => {
  it('renders only the original user goal for legacy encoded initial prompts', () => {
    const fallback = buildWorkItem({ task, employees: [] })
    const loaded = buildWorkItem({ task, employees: [], messages: [
      { id: 'run-a-user', role: 'user', content: prompt, createdAt: 1, runId: 'run-a' },
    ] })
    assert.equal(fallback.messages[0]?.content, '请整理这份资料')
    assert.equal(loaded.messages[0]?.content, '请整理这份资料')
  })

  it('never rewrites normal follow-up messages or assistant replies as goal metadata', () => {
    const content = '请解释“工作目标：”这个标签'
    const work = buildWorkItem({ task, employees: [], messages: [
      { id: 'user-2', role: 'user', content, createdAt: 3, runId: 'run-b' },
      { id: 'assistant', role: 'assistant', content: prompt, createdAt: 4, runId: 'run-b' },
    ] })
    assert.deepEqual(work.messages.map(message => message.content), [content, prompt])
  })

  it('replaces a partial persisted response with the live response for the same run', () => {
    const work = buildWorkItem({ task, employees: [], streamingText: '你好，世界', streamingRunId: 'run-a', messages: [
      { id: 'old-assistant', role: 'assistant', content: '之前的回答', createdAt: 1, runId: 'old-run' },
      { id: 'run-a-assistant', role: 'assistant', content: '你好', createdAt: 2, runId: 'run-a' },
    ] })
    assert.deepEqual(work.messages.map(message => message.content), ['之前的回答', '你好，世界'])
  })
})

describe('authoritative work type projection', () => {
  it('uses the queried type over conflicting legacy prompt metadata', () => {
    const work = buildWorkItem({ task: { ...task, workType: { state: 'resolved', kind: 'arrangement' } }, employees: [] })
    assert.equal(work.kind, 'flow')
    assert.deepEqual(work.workType, { state: 'resolved', kind: 'arrangement' })
  })

  it('does not label an unqueried task as a resolved conversation', () => {
    assert.deepEqual(buildWorkItem({ task, employees: [] }).workType, { state: 'loading' })
  })

  it('keeps unavailable classification separate from execution status', () => {
    const work = buildWorkItem({ task: { ...task, workType: { state: 'unavailable' } }, employees: [] })
    assert.equal(work.status, 'running')
    assert.deepEqual(work.workType, { state: 'unavailable' })
  })
})
