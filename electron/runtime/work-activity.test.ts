import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { TaskExecutionEvent } from '../../src/shared/types'
import { applyRuntimeEvent, runtimeKey } from '../../src/shared/work-activity'

function event(type: string, data: unknown, sequence = 1): TaskExecutionEvent {
  return { taskId: 'task-1', runId: 'run-1', subscriptionId: 'employee-1', sequence, type, occurredAt: sequence, data }
}

test('keeps runtime activities isolated by task and run', () => {
  assert.equal(runtimeKey('task-1', 'run-1'), 'task-1:run-1')
  const first = applyRuntimeEvent([], event('tool_execution_start', { toolId: 'tool-1', toolName: 'write' }))
  const completed = applyRuntimeEvent(first, event('tool_execution_end', { toolId: 'tool-1', success: true }, 2))
  assert.equal(completed[0]?.state, 'completed')
  assert.equal(completed[0]?.text, '\u5df2\u5b8c\u6210\u6587\u4ef6\u5199\u5165')
  const otherRun = applyRuntimeEvent([], { ...event('tool_execution_start', { toolId: 'tool-1', toolName: 'bash' }), runId: 'run-2' })
  assert.equal(otherRun[0]?.runId, 'run-2')
  assert.equal(completed[0]?.runId, 'run-1')
})

test('shows approval and arrangement state without exposing tool payloads', () => {
  const approval = applyRuntimeEvent([], event('approval_requested', { requestId: 'approval-1', toolName: 'edit', input: { path: 'secret.txt' } }))
  assert.equal(approval[0]?.state, 'waiting-user')
  assert.equal(approval[0]?.text, '\u7b49\u5f85\u4f60\u7684\u786e\u8ba4\uff1a\u6587\u4ef6\u7f16\u8f91')
  const resolved = applyRuntimeEvent(approval, event('approval_resolved', { requestId: 'approval-1', approved: false }, 2))
  assert.equal(resolved[0]?.state, 'failed')
  assert.equal(resolved[0]?.text, '\u672a\u83b7\u5f97\u786e\u8ba4\uff0c\u64cd\u4f5c\u5df2\u88ab\u963b\u6b62')
  const started = applyRuntimeEvent([], event('arrangement_node_started', { nodeId: 'node-1', nodeRunId: 'node-run-1', title: '\u6574\u7406\u8d44\u6599' }))
  const ended = applyRuntimeEvent(started, event('arrangement_node_completed', { nodeId: 'node-1', nodeRunId: 'node-run-1', title: '\u6574\u7406\u8d44\u6599' }, 2))
  assert.equal(ended[0]?.state, 'completed')
  assert.equal(ended[0]?.text, '\u5df2\u5b8c\u6210\uff1a\u6574\u7406\u8d44\u6599')
  assert.equal(ended.some(activity => activity.text.includes('secret.txt')), false)
})


test('retains the node title when the real completion event only carries output', () => {
  const started = applyRuntimeEvent([], event('arrangement_node_started', { nodeId: 'node-1', nodeRunId: 'node-run-1', title: 'Research\nnotes' }))
  const completed = applyRuntimeEvent(started, event('arrangement_node_completed', { nodeId: 'node-1', nodeRunId: 'node-run-1', output: 'research result' }, 2))
  assert.equal(completed[0]?.text, '已完成：Research notes')
  assert.equal(completed[0]?.state, 'completed')
  const snapshot = applyRuntimeEvent(completed, event('arrangement_state_changed', { nodeId: 'node-1', nodeStatus: 'completed' }, 3))
  assert.deepEqual(snapshot, completed)
})


test('settles retry activities across distinct event sequence numbers', () => {
  const first = applyRuntimeEvent([], event('auto_retry_start', { attempt: 1 }, 1))
  const second = applyRuntimeEvent(first, event('auto_retry_start', { attempt: 2 }, 2))
  assert.equal(second.filter(item => item.state === 'running').length, 1)
  const finished = applyRuntimeEvent(second, event('auto_retry_end', { success: true }, 3))
  assert.equal(finished.filter(item => item.state === 'running').length, 0)
  assert.equal(finished.at(-1)?.state, 'completed')
  const exhausted = applyRuntimeEvent(first, event('retry_budget_exhausted', {}, 4))
  assert.equal(exhausted[0]?.state, 'failed')
})
