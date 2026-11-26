import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildArrangementTranscript, mergeTranscriptEvents, selectTranscriptEvent, visibleModelText } from './arrangement-transcript'
import type { TaskExecutionEvent } from '../../shared/types'
import type { WorkStep } from './types'

const steps: WorkStep[] = ['a', 'b'].map(id => ({ id, title: `Node ${id}`, employeeId: `employee-${id}`,
  employeeName: `Employee ${id}`, input: 'INTERNAL INSTRUCTION', output: '', dependsOn: [], needsConfirm: false, state: 'running' }))
const event = (sequence: number, nodeId: string, eventType: string, data: Record<string, unknown> = {}): TaskExecutionEvent => ({
  taskId: 'task', runId: 'parent', subscriptionId: 'owner', sequence, occurredAt: sequence,
  type: 'arrangement_node_progress', data: { nodeId, nodeRunId: `run-${nodeId}`, eventType, ...data },
})

describe('arrangement transcript projection', () => {
  it('retains only the current attempt diagnostic marker, not error data', () => {
    const failed = { ...event(1, 'a', ''), type: 'arrangement_node_failed', data: { nodeId: 'a', nodeRunId: 'run-a', diagnosticAvailable: true, diagnostic: 'PRIVATE' } }
    const projected = selectTranscriptEvent(failed)!
    assert.equal(buildArrangementTranscript(steps, [projected])[0].diagnosticRunId, 'run-a')
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/)
    const later = { ...failed, sequence: 2, occurredAt: 2, data: { ...failed.data, nodeRunId: 'run-a2', diagnosticAvailable: false } }
    assert.equal(buildArrangementTranscript(steps, [projected, later])[0].diagnosticRunId, undefined)
  })
  it('keeps parallel employees and turns independent in plan order', () => {
    const result = buildArrangementTranscript(steps, [event(1, 'b', 'turn_start'), event(2, 'a', 'turn_start'),
      event(3, 'b', 'thinking_delta', { text: 'Think B' }), event(4, 'a', 'text_delta', { text: 'Reply A' }),
      event(5, 'b', 'text_delta', { text: 'Reply B' }), event(6, 'a', 'turn_start'), event(7, 'a', 'text_delta', { text: 'Next A' })])
    assert.deepEqual(result.map(node => node.step.id), ['a', 'b'])
    assert.deepEqual(result[0].entries.map(entry => entry.text), ['Reply A', 'Next A'])
    assert.deepEqual(result[1].entries.map(entry => entry.text), ['Think B', 'Reply B'])
  })

  it('hides internal messages and final JSON even when it is still streaming', () => {
    for (const text of ['{', '{"no', '{"nodeId":"a","summary":"done","finalDeliverables":[]}', '```json\n{"nodeId":"a"']) {
      assert.equal(visibleModelText(text), '')
    }
    assert.equal(visibleModelText('Findings\n```json\n{"nodeId":"a"}'), 'Findings')
    assert.equal(visibleModelText('[Market source](https://example.com)'), '[Market source](https://example.com)')
    assert.equal(visibleModelText('```ts\nconst answer = 42\n```'), '```ts\nconst answer = 42\n```')
    const result = buildArrangementTranscript(steps, [event(1, 'a', 'user_message', { text: 'CORRECTION SECRET' }),
      event(2, 'a', 'text_delta', { text: '{"nodeId":"a"}' })])
    assert.deepEqual(result[0].entries, [])
  })

  it('decorates tool operations and updates their state without showing arguments', () => {
    const events = [event(1, 'a', 'tool_execution_start', { toolId: 'read-1', toolName: 'read', input: { token: 'SECRET' } }),
      event(2, 'a', 'tool_execution_end', { toolId: 'read-1', toolName: 'read', success: true }),
      event(3, 'b', 'tool_execution_start', { toolId: 'office', toolName: 'mcp__officecli__officecli' }),
      event(4, 'b', 'tool_execution_end', { toolId: 'office', success: false })]
    const result = buildArrangementTranscript(steps, events)
    assert.equal(result[0].entries[0].text, '执行工具操作')
    assert.equal(result[0].entries[0].toolName, 'read')
    assert.equal(result[0].entries[0].state, 'completed')
    assert.equal(result[1].entries[0].text, '执行工具操作')
    assert.equal(result[1].entries[0].toolName, 'mcp__officecli__officecli')
    assert.equal(result[1].entries[0].state, 'failed')
    assert.doesNotMatch(JSON.stringify(result), /SECRET|token/)
  })

  it('identifies connector and extension calls from live or saved events without exposing inputs or results', () => {
    const savedNode = { ...event(1, 'b', ''), type: 'arrangement_node_started', data: { nodeId: 'b', nodeRunId: 'run-b' } }
    const savedTool = { ...event(5, 'b', ''), runId: 'run-b', type: 'tool_execution_end',
      data: { toolId: 'search', toolName: 'mcp__example__search', success: true, result: 'PRIVATE RESULT' } }
    const unnamedTool = event(6, 'a', 'tool_execution_start', { toolId: 'malformed', toolName: 'PRIVATE INPUT\n' })
    const events = [savedNode,
      event(2, 'a', 'tool_execution_start', { toolId: 'ding', toolName: 'dingtalk_schema', input: 'PRIVATE INPUT' }),
      event(3, 'a', 'tool_execution_start', { toolId: 'send' }),
      event(4, 'a', 'tool_execution_end', { toolId: 'send', toolName: 'dingtalk_execute', success: false }),
      savedTool, unnamedTool,
      event(7, 'a', 'tool_execution_start', { toolId: 'custom', toolName: 'toString' }),
    ].flatMap(event => { const selected = selectTranscriptEvent(event); return selected ? [selected] : [] })
    const [live, history] = buildArrangementTranscript(steps, events)
    assert.deepEqual(live.entries.map(entry => [entry.text, entry.state]), [
      ['执行工具操作', 'running'],
      ['执行工具操作', 'failed'],
      ['工具名称未记录', 'running'],
      ['执行工具操作', 'running'],
    ])
    assert.deepEqual(live.entries.map(entry => entry.toolName), ['dingtalk_schema', 'dingtalk_execute', undefined, 'toString'])
    assert.deepEqual(history.entries.map(entry => [entry.text, entry.toolName, entry.state]), [['执行工具操作', 'mcp__example__search', 'completed']])
    assert.doesNotMatch(JSON.stringify([live, history]), /PRIVATE INPUT|PRIVATE RESULT/)
  })

  it('merges history and live events by run and sequence without dropping parallel events', () => {
    const first = event(1, 'a', 'text_delta', { text: 'A' })
    const second = { ...event(1, 'b', 'text_delta', { text: 'B' }), runId: 'parent-2' }
    assert.equal(mergeTranscriptEvents([first], [first, second]).length, 2)
  })

  it('recovers old node timelines without displaying node prompts or duplicate new progress', () => {
    const start = { ...event(1, 'a', ''), type: 'arrangement_node_started', data: { nodeId: 'a', nodeRunId: 'run-a', prompt: 'SECRET' } }
    const raw = { ...event(1, 'a', ''), runId: 'run-a', type: 'text_delta', data: { text: 'Old reply' } }
    assert.equal(buildArrangementTranscript(steps, [start, raw])[0].entries[0].text, 'Old reply')
    const progress = event(2, 'a', 'text_delta', { text: 'Old reply' })
    assert.equal(buildArrangementTranscript(steps, [start, raw, progress])[0].entries.length, 1)
  })

  it('recovers historical assistant thinking snapshots without exposing message internals or duplicating turn snapshots', () => {
    const raw = (sequence: number, type: string, data: unknown): TaskExecutionEvent => ({ ...event(sequence, 'a', ''), runId: 'run-a', type, data })
    const start = { ...event(1, 'a', ''), type: 'arrangement_node_started', data: { nodeId: 'a', nodeRunId: 'run-a' } }
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Historical reasoning' },
      { type: 'text', text: '{"nodeId":"a","finalDeliverables":[]}' }, { type: 'toolCall', arguments: { password: 'PRIVATE TOOL INPUT' } }] }
    const source = [start, raw(2, 'turn_start', {}), raw(3, 'text_delta', { text: 'Visible answer' }),
      raw(4, 'message_end', { message }), raw(5, 'turn_end', { message }),
      raw(6, 'message_end', { message: { role: 'user', content: [{ type: 'thinking', thinking: 'REPAIR PROMPT' }] } })]
    const selected = source.flatMap(event => { const safe = selectTranscriptEvent(event); return safe ? [safe] : [] })
    assert.doesNotMatch(JSON.stringify(selected), /PRIVATE TOOL INPUT|REPAIR PROMPT|finalDeliverables/)
    const result = buildArrangementTranscript(steps, selected)[0].entries
    assert.deepEqual(result.map(entry => [entry.kind, entry.text]), [['thinking', 'Historical reasoning'], ['text', 'Visible answer']])
  })

  it('keeps streamed thinking authoritative when full message snapshots or parent progress also exist', () => {
    const snapshot = { ...event(5, 'a', ''), runId: 'run-a', type: 'message_end', data: { message: {
      role: 'assistant', content: [{ type: 'thinking', thinking: 'Streamed thinking' }],
    } } }
    const result = buildArrangementTranscript(steps, [event(1, 'a', 'turn_start'), event(2, 'a', 'thinking_delta', { text: 'Streamed ' }),
      event(3, 'a', 'thinking_delta', { text: 'thinking' }), snapshot])
    assert.deepEqual(result[0].entries.map(entry => entry.text), ['Streamed thinking'])
    const historical = buildArrangementTranscript(steps, [event(1, 'a', 'turn_start'),
      event(2, 'a', 'tool_execution_start', { toolId: 'read', toolName: 'read' }), snapshot])
    assert.equal(historical[0].entries.filter(entry => entry.kind === 'thinking')[0]?.text, 'Streamed thinking')
  })
})
