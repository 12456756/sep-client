import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildWorkItem, encodeWorkPrompt, getArrangementDisplayEvents } from './work-mapping'
import type { ArrangementExecutionSnapshot, ArrangementPlanSnapshot, ClientTask, TaskExecutionEvent } from '../../shared/types'

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
  it('includes document formats and task file identities for conversation preview', () => {
    const work = buildWorkItem({ task: { ...task, files: ['C:\\work\\report.DOCX', 'deliverables/sheet.xlsx', 'notes.md'] }, employees: [] })
    assert.equal(work.kind, 'conversation')
    assert.deepEqual(work.deliverables.map(file => [file.id, file.format]), [
      ['task-a-file-0', 'docx'], ['task-a-file-1', 'xlsx'], ['task-a-file-2', 'md'],
    ])
  })
  it('displays the general assistant instead of the authentication employee in history and messages', () => {
    const work = buildWorkItem({ task, employees: [], plan: { mode: 'conversation', conversation: { kind: 'general' } } as ArrangementPlanSnapshot,
      messages: [{ id: 'reply', role: 'assistant', content: 'hello', createdAt: 1, runId: 'run' }] })
    assert.equal(work.currentEmployeeName, '通用助手')
    assert.deepEqual(work.participants, ['builtin:general-assistant'])
    assert.equal(work.messages.find(message => message.role === 'employee')?.employeeName, '通用助手')
  })
  it('projects a historical pending task as arranging without execution timestamps', () => {
    const work = buildWorkItem({ task: { ...task, status: 'pending', startedAt: null, completedAt: null, activeRunId: null, createdAt: 1 }, employees: [] })
    assert.equal(work.status, 'arranging')
    assert.equal(work.startedAt, null)
    assert.equal(work.completedAt, null)
  })

  it('does not project a running status without an admitted run as active work', () => {
    for (const taskStatus of ['running', 'waiting_approval'] as const) {
      const work = buildWorkItem({ task: { ...task, status: taskStatus, activeRunId: null }, employees: [] })
      assert.equal(work.status, 'arranging')
      assert.equal(work.isActive, false)
    }
  })

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

  it('does not treat a settled model reply or rejected delivery as a completed node', () => {
    const events: TaskExecutionEvent[] = [{ ...failed, type: 'arrangement_node_started', data: { nodeId: 'node-a' } }]
    for (let attempt = 1; attempt <= 4; attempt++) {
      events.push({ ...failed, type: 'agent_end', data: { willRetry: false } },
        { ...failed, type: 'arrangement_delivery_checked', data: { nodeId: 'node-a', validationAttempts: attempt, accepted: false } })
      const work = buildWorkItem({ task, employees: [], plan, arrangementEvents: events })
      assert.equal(work.status, 'running')
      assert.equal(work.steps[0]?.state, 'running')
      assert.equal(work.progress, 0)
    }
    events.push({ ...failed, type: 'arrangement_node_completed', data: { nodeId: 'node-a' } })
    assert.equal(buildWorkItem({ task, employees: [], plan, arrangementEvents: events }).steps[0]?.state, 'done')
  })

  it('shows a paused arrangement waiting for a failed node retry as failed', () => {
    const work = buildWorkItem({ task: { ...task, status: 'paused', error: '429' }, employees: [], plan, arrangementEvents: [failed] })
    assert.equal(work.status, 'failed')
    assert.equal(work.stopReason, '429')
    assert.equal(work.steps[0]?.state, 'failed')
  })

  it('shows explicit confirmation from either a checkpoint or a newer event as waiting for the user', () => {
    const confirmationPlan = { ...plan, nodes: [{ ...plan.nodes[0]!, requiresUserConfirmation: true }] }
    const execution: ArrangementExecutionSnapshot = { activeRunId: null, status: 'waiting-user', updatedAt: 4,
      nodes: [{ nodeId: 'node-a', status: 'completed', pendingConfirmation: true, finalFiles: [] }] }
    const event: TaskExecutionEvent = { ...failed, occurredAt: 5,
      data: { status: 'waiting-user', nodeStates: execution.nodes } }
    for (const input of [{ arrangementExecution: execution }, { arrangementEvents: [event] }]) {
      const work = buildWorkItem({ task: { ...task, status: 'paused', activeRunId: null }, employees: [], plan: confirmationPlan, ...input })
      assert.equal(work.status, 'waiting-user')
      assert.equal(work.steps[0]?.state, 'waiting-user')
      assert.equal(work.arrangementExecution?.nodes[0]?.pendingConfirmation, true)
    }
  })

  it('projects a media clarification from checkpoints and live events without showing task failure', () => {
    const inputRequest = { requestId: 'spec-question', kind: 'media-spec' as const, question: '视频用于什么场景？', requirements: [{ id: 'video', specRevision: 1 }] }
    const execution: ArrangementExecutionSnapshot = { activeRunId: null, status: 'waiting-user', updatedAt: 4,
      nodes: [{ nodeId: 'node-a', status: 'interrupted', inputRequest, finalFiles: [] }] }
    const event: TaskExecutionEvent = { ...failed, occurredAt: 5, data: { status: 'waiting-user', nodeStates: execution.nodes } }
    for (const input of [{ arrangementExecution: execution }, { arrangementEvents: [event] }]) {
      const work = buildWorkItem({ task: { ...task, status: 'paused', activeRunId: null }, employees: [], plan, ...input })
      assert.equal(work.status, 'waiting-user')
      assert.equal(work.steps[0]?.state, 'waiting-user')
      assert.equal(work.nextUserAction, inputRequest.question)
      assert.deepEqual(work.arrangementExecution?.nodes[0]?.inputRequest, inputRequest)
    }
    const resumed = buildWorkItem({ task, employees: [], plan, arrangementExecution: execution,
      arrangementEvents: [{ ...event, occurredAt: 6, data: { status: 'running', nodeStates: [{ nodeId: 'node-a', status: 'running' }] } }] })
    assert.equal(resumed.arrangementExecution?.nodes[0]?.inputRequest, undefined)
  })

  it('removes the pending confirmation when a newer authoritative event confirms the node', () => {
    const execution: ArrangementExecutionSnapshot = { activeRunId: null, status: 'waiting-user', updatedAt: 4,
      nodes: [{ nodeId: 'node-a', status: 'completed', pendingConfirmation: true, finalFiles: [] }] }
    const work = buildWorkItem({ task, employees: [], plan, arrangementExecution: execution, arrangementEvents: [{
      ...failed, occurredAt: 5, data: { status: 'completed', nodeStates: [{ nodeId: 'node-a', status: 'completed', pendingConfirmation: false }] },
    }] })
    assert.equal(work.steps[0]?.state, 'done')
    assert.equal(work.arrangementExecution?.nodes[0]?.pendingConfirmation, false)
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

  it('shows only validated final files and keeps them after a retry starts', () => {
    const retryPlan = { ...plan, nodes: [plan.nodes[0], { ...plan.nodes[0], id: 'node-b', title: 'Node B', dependsOn: ['node-a'] }] }
    const execution = {
      activeRunId: 'retry-run', status: 'running' as const, updatedAt: 5,
      nodes: [
        { nodeId: 'node-a', status: 'completed' as const, finalFiles: [{ id: 'report', path: 'deliverables/report.md', format: 'md', size: 10, sha256: 'a'.repeat(64), nodeRunId: 'node-run-a', validatedAt: 4 }] },
        { nodeId: 'node-b', status: 'running' as const, finalFiles: [] },
      ],
    }
    const work = buildWorkItem({ task: { ...task, activeRunId: 'retry-run' }, employees: [], plan: retryPlan, arrangementExecution: execution })
    assert.deepEqual(work.deliverables.map(file => file.path), ['deliverables/report.md'])
    assert.equal(work.deliverables[0]?.nodeTitle, 'Node A')
    assert.equal(work.steps[0]?.state, 'done')
    assert.equal(work.steps[1]?.state, 'running')
  })

  it('does not mistake an explicitly stopped arrangement for a retryable failure', () => {
    const stopped: TaskExecutionEvent = { ...failed, sequence: 2, type: 'stop_requested', data: { reason: 'user stopped' } }
    const work = buildWorkItem({ task: { ...task, status: 'paused', error: 'user stopped' }, employees: [], plan, arrangementEvents: [failed, stopped] })
    assert.equal(work.status, 'paused')
  })

  const finalFile = { id: 'report', path: 'deliverables/report.md', format: 'md', size: 10, sha256: 'a'.repeat(64), nodeRunId: 'node-run-a', validatedAt: 4 }
  it('distinguishes a failed node, a running peer and dependency-blocked nodes', () => {
    const parallelPlan = { ...plan, nodes: [plan.nodes[0],
      { ...plan.nodes[0], id: 'node-b' }, { ...plan.nodes[0], id: 'child', dependsOn: ['node-a'] }] }
    const work = buildWorkItem({ task, employees: [], plan: parallelPlan, arrangementExecution: {
      activeRunId: 'run-a', status: 'running', updatedAt: 10, nodes: [
        { nodeId: 'node-a', status: 'failed', finalFiles: [] },
        { nodeId: 'node-b', status: 'running', finalFiles: [] },
        { nodeId: 'child', status: 'blocked', finalFiles: [] },
      ],
    } })
    assert.equal(work.status, 'running')
    assert.deepEqual(work.steps.map(step => step.state), ['failed', 'running', 'blocked'])
  })
  const persisted: ArrangementExecutionSnapshot = {
    activeRunId: 'run-a', status: 'completed', updatedAt: 10,
    nodes: [{ nodeId: 'node-a', status: 'completed', finalFiles: [finalFile] }],
  }

  it('does not replay older running events over a newer completed checkpoint', () => {
    const work = buildWorkItem({ task, employees: [], plan, arrangementExecution: persisted,
      arrangementEvents: [{ ...failed, data: { nodeId: 'node-a', nodeStatus: 'running', status: 'running' } }] })
    assert.equal(work.steps[0]?.state, 'done')
    assert.equal(work.arrangementExecution?.status, 'completed')
  })

  it('applies only changed nodes when a newer partial event follows a checkpoint', () => {
    const parallelPlan = { ...plan, nodes: [plan.nodes[0], { ...plan.nodes[0], id: 'node-b' }] }
    const work = buildWorkItem({ task, employees: [], plan: parallelPlan,
      arrangementExecution: { ...persisted, nodes: [...persisted.nodes, { nodeId: 'node-b', status: 'pending', finalFiles: [] }] },
      arrangementEvents: [{ ...failed, occurredAt: 11, data: { nodeId: 'node-b', nodeStatus: 'running', status: 'running' } }] })
    assert.deepEqual(work.steps.map(step => step.state), ['done', 'running'])
  })

  it('binds completion events and their final files even before the next state snapshot', () => {
    const work = buildWorkItem({ task, employees: [], plan, arrangementEvents: [
      { ...failed, data: { nodeId: 'node-a', nodeStatus: 'running', status: 'running' } },
      { ...failed, sequence: 2, occurredAt: 4, type: 'arrangement_node_completed', data: { nodeId: 'node-a', finalDeliverables: [finalFile] } },
    ] })
    assert.equal(work.steps[0]?.state, 'done')
    assert.equal(work.deliverables.length, 1)
  })

  it('retains terminal execution status from state events', () => {
    const work = buildWorkItem({ task, employees: [], plan, arrangementEvents: [
      { ...failed, data: { status: 'completed', nodeStates: [{ nodeId: 'node-a', status: 'completed' }] } },
    ] })
    assert.equal(work.arrangementExecution?.status, 'completed')
  })

  it('does not animate persisted running nodes after work is stopped', () => {
    const work = buildWorkItem({ task: { ...task, status: 'paused' }, employees: [], plan,
      arrangementExecution: { ...persisted, status: 'running', nodes: [{ nodeId: 'node-a', status: 'running', finalFiles: [] }] } })
    assert.equal(work.steps[0]?.state, 'interrupted')
  })

  it('never offers a node failure when an explicit control interrupts its worker', () => {
    for (const [status, expected] of [['PAUSED', 'interrupted'], ['CANCELLED', 'stopped']] as const) {
      const work = buildWorkItem({ task, employees: [], plan, arrangementEvents: [{ ...failed, type: 'arrangement_node_failed', data: { nodeId: 'node-a', status } }] })
      assert.equal(work.steps[0]?.state, expected)
      assert.equal(work.arrangementExecution?.nodes[0]?.status, expected)
    }
  })

  it('does not show invalidated final files from failed nodes', () => {
    const work = buildWorkItem({ task, employees: [], plan,
      arrangementExecution: { ...persisted, status: 'waiting-user', nodes: [{ ...persisted.nodes[0], status: 'failed' }] } })
    assert.deepEqual(work.deliverables, [])
  })

  it('copies final file paths relative to the actual workspace on both platforms', () => {
    for (const [workDir, expected] of [['/work/project/', '/work/project/deliverables/report.md'], ['C:\\Work\\Project\\', 'C:\\Work\\Project\\deliverables\\report.md']]) {
      const work = buildWorkItem({ task: { ...task, workDir }, employees: [], plan, arrangementExecution: persisted })
      assert.equal(work.deliverables[0]?.path, expected)
    }
  })

  it('preserves existing file results for legacy workflows and plans without delivery contracts', () => {
    const legacyTask = { ...task, files: ['/work/result.md'], prompt: encodeWorkPrompt('goal', {
      kind: 'flow', goal: 'goal', steps: [], participants: [], sharedContext: { goal: 'goal', confirmedInputs: [], previousResults: [], userNotes: [] },
    }) }
    for (const legacyPlan of [undefined, { ...plan, mode: 'manual' as const }]) {
      const work = buildWorkItem({ task: legacyTask, employees: [], plan: legacyPlan })
      assert.deepEqual(work.deliverables.map(file => file.path), ['/work/result.md'])
    }
  })

  it('does not expose process files for plans with structured delivery contracts', () => {
    const structuredPlan = { ...plan, nodes: [{ ...plan.nodes[0], deliverables: [{ ...finalFile, name: 'Report', contentOutline: ['result'], acceptanceCriteria: ['complete'] }] }] }
    const work = buildWorkItem({ task: { ...task, files: ['/work/process.log'] }, employees: [], plan: structuredPlan })
    assert.deepEqual(work.deliverables, [])
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
