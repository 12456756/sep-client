import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { classifyTaskEvent, shouldPushTaskEvent, type TaskEventVisibility } from './task-event-visibility'
import type { TaskExecutionEvent } from '../../src/shared/types'

function event(type: string, data: unknown = {}): TaskExecutionEvent {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    subscriptionId: 'employee-1',
    sequence: 1,
    type,
    occurredAt: 1,
    data,
  }
}

test('streams text deltas and important execution events', () => {
  const cases: Array<[string, unknown, TaskEventVisibility]> = [
    ['text_delta', { text: 'hello' }, 'stream'],
    ['tool_execution_start', { toolName: 'read', toolId: 'read-1' }, 'important'],
    ['tool_execution_start', { toolName: 'write', toolId: 'write-1' }, 'important'],
    ['tool_execution_end', { toolName: 'edit', toolId: 'edit-1', success: true }, 'important'],
    ['approval_requested', { requestId: 'approval-1', toolName: 'bash' }, 'important'],
    ['approval_resolved', { requestId: 'approval-1', approved: true }, 'important'],
    ['workflow_node_started', { nodeId: 'node-1' }, 'important'],
    ['workflow_node_completed', { nodeId: 'node-1' }, 'important'],
    ['agent_end', { willRetry: false }, 'important'],
    ['session_error', { message: 'failed' }, 'important'],
  ]

  for (const [type, data, expected] of cases) {
    const current = event(type, data)
    assert.equal(classifyTaskEvent(current), expected, type)
    assert.equal(shouldPushTaskEvent(current), true, type)
  }
})

test('does not push internal lifecycle events to the renderer', () => {
  for (const type of ['agent_start', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_end', 'compaction_start', 'compaction_end']) {
    const current = event(type, { internal: true })
    assert.equal(classifyTaskEvent(current), 'internal', type)
    assert.equal(shouldPushTaskEvent(current), false, type)
  }
})

test('unknown events are fail-closed and high-risk tool events remain visible', () => {
  assert.equal(shouldPushTaskEvent(event('provider_debug', { token: 'secret' })), false)
  assert.equal(shouldPushTaskEvent(event('tool_execution_start', { toolName: 'write', input: { path: 'a.txt' } })), true)
  assert.equal(shouldPushTaskEvent(event('tool_execution_end', { toolName: 'bash', success: false })), true)
})
