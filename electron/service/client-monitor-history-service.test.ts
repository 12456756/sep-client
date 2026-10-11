import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ClientMonitorHistoryService } from './client-monitor-history-service'
import type { ClientTask, TaskExecutionEvent } from '../../src/shared/types'
import type { TaskRunRecord } from '../data/task-run-store'

const scope = { enterpriseId: 'enterprise', memberId: 'member' }
const task: ClientTask = { id: 'task', title: 'Task', prompt: 'snapshot input', status: 'interrupted', createdAt: 1, startedAt: 2, completedAt: null, error: null, ownerId: 'member', ownerEnterpriseId: 'enterprise', subscriptionId: 'sub', activeRunId: null, workDir: null, files: [], logs: [] }
const run = (id: string, outcome: TaskRunRecord['outcome'], startedAt: number): TaskRunRecord => ({ version: 3, id, taskId: 'task', owner: scope, subscriptionId: 'sub', modelId: 'model', runtimeKey: 'sub:model', workspaceDir: '', sessionDir: '', agentDir: '', sessionFile: null, sessionId: null, startedAt, endedAt: outcome === 'running' ? null : startedAt + 1, outcome, error: null, prompt: `input-${id}` })

it('uses canonical messages before sanitized deltas and maps interrupted to PAUSED', async () => {
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
  assert.equal(result.runs[1].status?.status, 'PAUSED')
  assert.equal(result.runs[1].messages[1].content, 'partial')
  assert.equal(result.runs[1].status?.errorSummary, null)
  assert.equal(timelines, 1)
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
  assert.equal(first[0].runs[0].status?.status, 'PAUSED')
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
