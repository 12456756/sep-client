import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ClientMonitorHistoryService } from './client-monitor-history-service'
import type { ClientTask, TaskExecutionEvent } from '../../src/shared/types'
import type { TaskRunRecord } from '../data/task-run-store'
import type { ConversationMessage } from '../domain/conversation-context'

const scope = { enterpriseId: 'enterprise', memberId: 'member' }
const task: ClientTask = { id: 'task', title: 'Task', prompt: 'snapshot input', status: 'interrupted', createdAt: 1, startedAt: 2, completedAt: null, error: null, ownerId: 'member', ownerEnterpriseId: 'enterprise', subscriptionId: 'sub', activeRunId: null, workDir: null, files: [], logs: [] }
const run = (id: string, outcome: TaskRunRecord['outcome'], startedAt: number): TaskRunRecord => ({ version: 3, id, taskId: 'task', owner: scope, subscriptionId: 'sub', modelId: 'model', runtimeKey: 'sub:model', workspaceDir: '', sessionDir: '', agentDir: '', sessionFile: null, sessionId: null, startedAt, endedAt: outcome === 'running' ? null : startedAt + 1, outcome, error: null, prompt: `input-${id}` })

it('does not override persisted run outcomes with conflicting snapshot labels', async () => {
  const cases = [
    ['interrupted', 'paused', 'INTERRUPTED'], ['interrupted', 'completed', 'INTERRUPTED'],
    ['interrupted', 'running', 'INTERRUPTED'], ['stopped', 'interrupted', 'PAUSED'],
    ['cancelled', 'paused', 'CANCELLED'], ['completed', 'paused', 'COMPLETED'],
    ['failed', 'completed', 'FAILED'], ['running', 'completed', 'RUNNING'],
    ['running', 'waiting_approval', 'WAITING_APPROVAL'],
  ] as const
  for (const [outcome, snapshot, expected] of cases) {
    const history = new ClientMonitorHistoryService({
      scopeProvider: () => scope, listTasks: async () => [{ ...task, status: snapshot, completedAt: 99 }],
      listRuns: async () => [run('run-1', outcome, 2)], listMessages: async () => [], getTimeline: async () => [],
    })
    const recovered = (await history.read(scope))[0].runs[0]
    assert.equal(recovered.status?.status, expected, `${outcome}/${snapshot}`)
    if (['INTERRUPTED', 'PAUSED', 'RUNNING', 'WAITING_APPROVAL'].includes(expected)) assert.equal(recovered.status?.completedAt, null)
    if (outcome === 'interrupted') assert.equal(recovered.runEndedAt, new Date(3).toISOString())
  }
})

it('does not use one run_completed event to certify multiple assistant messages', async () => {
  const messages: ConversationMessage[] = ['run-1-assistant', 'another-assistant'].map((id, index) => ({ id, taskId: 'task', turnId: 'run-1', runId: 'run-1', subscriptionId: 'sub', modelId: 'model', role: 'assistant', content: 'same response', createdAt: 3 + index }))
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => scope, listTasks: async () => [{ ...task, status: 'completed' }], listRuns: async () => [run('run-1', 'completed', 2)],
    listMessages: async () => messages,
    getTimeline: async () => [{ taskId: 'task', runId: 'run-1', subscriptionId: 'sub', sequence: 1, type: 'run_completed', occurredAt: 5, data: null }],
  })
  const [result] = await history.read(scope)
  const outputs = result.runs[0].messages.filter(message => message.type === 'model_output')
  assert.deepEqual(outputs.map(message => message.messageId), ['run-1-assistant', 'another-assistant'])
  assert.deepEqual(outputs.map(message => message.completeness), ['unverified', 'unverified'])
  messages.pop()
  assert.equal((await history.read(scope))[0].runs[0].messages.find(message => message.type === 'model_output')?.completeness, 'complete')
})

it('recovers the final tool response without the preliminary generation promise', async () => {
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => scope, listTasks: async () => [task], listRuns: async () => [run('run-1', 'completed', 2)],
    listMessages: async () => [],
    getTimeline: async () => [
      { taskId: 'task', runId: 'run-1', subscriptionId: 'sub', sequence: 1, type: 'text_delta', occurredAt: 2, data: { text: 'I will generate.' } },
      { taskId: 'task', runId: 'run-1', subscriptionId: 'sub', sequence: 2, type: 'tool_execution_start', occurredAt: 3, data: {} },
      { taskId: 'task', runId: 'run-1', subscriptionId: 'sub', sequence: 3, type: 'text_delta', occurredAt: 4, data: { text: 'Generated and saved.' } },
    ],
  })
  const output = (await history.read(scope))[0].runs[0].messages.find(message => message.type === 'model_output')
  assert.equal(output?.content, 'Generated and saved.')
})

it('recovers bound canonical orphan messages under their original run without status or v2 proof', async () => {
  const messages: ConversationMessage[] = [
    { id: 'output-1', taskId: 'task', turnId: 'orphan-1', runId: 'orphan-1', subscriptionId: 'sub', modelId: 'model', role: 'assistant', content: 'answer', createdAt: 3 },
    { id: 'output-2', taskId: 'task', turnId: 'orphan-2', runId: 'orphan-2', subscriptionId: 'other-sub', modelId: 'model', role: 'assistant', content: 'answer', createdAt: 4 },
    { id: 'foreign', taskId: 'foreign', turnId: 'orphan-1', runId: 'orphan-1', subscriptionId: 'sub', modelId: 'model', role: 'assistant', content: 'foreign', createdAt: 3 },
  ]
  const history = new ClientMonitorHistoryService({ scopeProvider: () => scope, listTasks: async () => [task], listRuns: async () => [], listMessages: async () => messages, getTimeline: async () => [] })
  const [result] = await history.read(scope)
  assert.deepEqual(result.runs.map(value => value.runId), ['orphan-1', 'orphan-2'])
  assert.ok(result.runs.every(value => !value.status && !value.localRun && value.messages[0].completeness === 'unverified'))
  messages.push({ ...messages[0], id: 'conflict', subscriptionId: 'conflicting-sub' })
  assert.deepEqual((await history.read(scope))[0].runs.map(value => value.runId), ['orphan-2'])
})

it('uses canonical messages before sanitized deltas and preserves INTERRUPTED', async () => {
  let timelines = 0
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => scope, listTasks: async () => [task], listRuns: async () => [run('run-2', 'interrupted', 4), run('run-1', 'completed', 2)],
    listMessages: async () => [{ id: 'message', taskId: 'task', turnId: 'run-1', runId: 'run-1', subscriptionId: 'sub', modelId: 'model', role: 'assistant', content: 'x'.repeat(12000), createdAt: 3 }],
    getTimeline: async () => { timelines++; return [{ taskId: 'task', runId: 'run-2', subscriptionId: 'sub', sequence: 1, type: 'text_delta', occurredAt: 4, data: { text: 'partial' } }] },
  })
  const [result] = await history.read(scope)
  assert.deepEqual(result.runs.map(r => r.runId), ['run-1', 'run-2'])
  assert.deepEqual(result.runs.map(r => r.queuedAt), [2, 4])
  assert.ok(result.runs.every(r => r.localRun))
  assert.equal(result.runs[0].messages[1].content.length, 12000)
  assert.equal(result.runs[1].status?.status, 'INTERRUPTED')
  assert.equal(result.runs[1].status?.completedAt, null)
  assert.equal(result.runs[1].runEndedAt, new Date(5).toISOString())
  assert.equal(result.runs[1].messages[1].content, 'partial')
  assert.equal(result.runs[1].status?.errorSummary, null)
  assert.equal(timelines, 2)
})

it('skips missing subscription/foreign scope and creates a stable snapshot-only run', async () => {
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => scope,
    listTasks: async () => [task, { ...task, id: 'missing', subscriptionId: null }, { ...task, id: 'foreign', ownerId: 'other' }],
    listRuns: async () => [], listMessages: async () => [], getTimeline: async (): Promise<TaskExecutionEvent[]> => [],
  })
  const first = await history.read(scope)
  const second = await history.read(scope)
  assert.equal(first.length, 1)
  assert.equal(first[0].runs[0].runId, second[0].runs[0].runId)
  assert.equal(first[0].runs[0].messages[0].content, 'snapshot input')
  assert.equal(first[0].runs[0].status?.status, 'INTERRUPTED')
  assert.equal(first[0].runs[0].queuedAt, task.createdAt)
  assert.equal(first[0].runs[0].localRun, undefined)
})

it('redacts and bounds historical error summaries', async () => {
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => scope, listTasks: async () => [{ ...task, status: 'failed', error: `Bearer secret ${'x'.repeat(2000)}` }],
    listRuns: async () => [run('run-error', 'failed', 2)], listMessages: async () => [], getTimeline: async () => [],
  })
  const [result] = await history.read(scope)
  const error = result.runs[0].status?.errorSummary ?? ''
  assert.equal(error.includes('secret'), false)
  assert.equal(error.startsWith('Bearer [redacted]'), true)
  assert.equal(error.length, 1000)
})

it('discards a recovery snapshot if the scope changes during reads', async () => {
  let current = scope
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => current, listTasks: async () => [task], listRuns: async () => { current = { enterpriseId: 'other', memberId: 'other' }; return [run('run', 'completed', 2)] },
    listMessages: async () => [], getTimeline: async () => [],
  })
  assert.deepEqual(await history.read(scope), [])
})

it('falls back only to a proven first-run task creation time and never invents a later run time', async () => {
  for (const createdAt of [10, Number.NaN]) {
    const history = new ClientMonitorHistoryService({
      scopeProvider: () => scope, listTasks: async () => [{ ...task, createdAt }],
      listRuns: async () => [run('run-1', 'running', Number.NaN), run('run-2', 'running', Number.NaN)],
      listMessages: async () => [], getTimeline: async () => [],
    })
    const [result] = await history.read(scope)
    assert.equal(result.runs[0].queuedAt, Number.isFinite(createdAt) ? createdAt : undefined)
    assert.equal(result.runs[1].queuedAt, undefined)
    assert.ok(result.runs.every(value => value.status?.startedAt === null))
  }
})

it('ignores a local run whose task ID does not match the task snapshot', async () => {
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => scope, listTasks: async () => [task],
    listRuns: async () => [{ ...run('foreign-run', 'completed', 2), taskId: 'another-task' }],
    listMessages: async () => [], getTimeline: async () => [],
  })
  assert.deepEqual(await history.read(scope), [])
})

it('does not assign task creation time to a snapshot active run without its persisted record', async () => {
  const history = new ClientMonitorHistoryService({
    scopeProvider: () => scope, listTasks: async () => [{ ...task, activeRunId: 'unproven-active' }],
    listRuns: async () => [], listMessages: async () => [], getTimeline: async () => [],
  })
  const [result] = await history.read(scope)
  assert.equal(result.runs[0].runId, 'unproven-active')
  assert.equal(result.runs[0].queuedAt, undefined)
  assert.equal(result.runs[0].localRun, undefined)
})
