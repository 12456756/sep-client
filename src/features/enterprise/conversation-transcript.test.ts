import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildConversationReplies, buildConversationTranscript } from './conversation-transcript'
import type { WorkItem, WorkMessage } from './types'
import type { TaskExecutionEvent } from '../../shared/types'

const event = (sequence: number, type: string, data: unknown, runId = 'run-a'): TaskExecutionEvent => ({
  taskId: 'task', runId, subscriptionId: 'employee', sequence, type, data, occurredAt: sequence,
})

test('groups streamed thinking and tool usage by run in execution order without duplicating history', () => {
  const events = [event(1, 'thinking_delta', { text: '先检查' }), event(2, 'thinking_delta', { text: '资料。' }),
    event(3, 'tool_execution_start', { toolId: 'read-a', toolName: 'read', input: { path: '/work/input.txt', password: 'secret' } }),
    event(4, 'tool_execution_end', { toolId: 'read-a', toolName: 'read', success: true }),
    event(5, 'thinking_delta', { text: '开始整理。' }), event(6, 'text_delta', { text: '完整回复只出现在对话中' })]
  const runs = buildConversationTranscript([...events, events[0]!])
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.runId, 'run-a')
  assert.deepEqual(runs[0]!.entries.map(entry => entry.kind), ['thinking', 'tool', 'thinking'])
  assert.equal(runs[0]!.entries[0]!.text, '先检查资料。')
  assert.equal(runs[0]!.entries[1]!.state, 'completed')
  assert.match(runs[0]!.entries[1]!.text, /读取/)
  assert.doesNotMatch(JSON.stringify(runs), /secret|password|完整回复只出现在对话中/)
})

test('history can recover thinking from message snapshots and separate later conversation runs', () => {
  const runs = buildConversationTranscript([
    event(1, 'message_end', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: '历史思考' }] } }),
    event(2, 'tool_execution_end', { toolId: 'tool', toolName: 'bash', success: false }),
    event(3, 'thinking_delta', { text: '下一轮思考' }, 'run-b'),
  ])
  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.entries[0]!.text, '历史思考')
  assert.equal(runs[0]!.entries[1]!.state, 'failed')
  assert.equal(runs[1]!.entries[0]!.text, '下一轮思考')
})

test('a final snapshot does not repeat the same streamed thinking', () => {
  const runs = buildConversationTranscript([event(1, 'thinking_delta', { text: '思考' }),
    event(2, 'message_end', { thinking: '思考' })])
  assert.equal(runs[0]!.entries.length, 1)
  assert.equal(runs[0]!.entries[0]!.text, '思考')
})

test('approval decisions replace the matching waiting row without mixing requests or runs', () => {
  const requested = event(1, 'approval_requested', { requestId: 'upload', toolName: 'video_from_image' })
  const quote = event(2, 'approval_requested', { requestId: 'quote', toolName: 'video_from_image' })
  const otherRun = event(3, 'approval_requested', { requestId: 'upload' }, 'run-b')
  const runs = buildConversationTranscript([requested, quote, otherRun,
    event(4, 'approval_resolved', { requestId: 'upload', approved: true }),
    event(5, 'approval_resolved', { requestId: 'quote', approved: false, reason: 'timeout' })])
  assert.deepEqual(runs[0]!.entries.map(entry => entry.state), ['completed', 'failed'])
  assert.ok(runs[0]!.entries.every(entry => !entry.text.includes('等待')))
  assert.equal(runs[1]!.entries[0]!.state, 'waiting-user')
  assert.match(runs[1]!.entries[0]!.text, /等待/)
})

test('a resolved approval without a request does not create a waiting notification', () => {
  assert.deepEqual(buildConversationTranscript([event(1, 'approval_resolved', { requestId: 'unknown', approved: true })]), [])
})

const message = (id: string, role: WorkMessage['role'], runId?: string): WorkMessage => ({ id, role, runId, content: id, createdAt: 1 })
const work = (messages: WorkMessage[], activeRunId: string | null = null) => ({
  id: 'task', messages, activeRunId, isActive: !!activeRunId, createdAt: 1, updatedAt: 2,
} as WorkItem)

test('creates an immediate reply before any events or response text and keeps its identity during streaming', () => {
  const initial = buildConversationReplies(work([message('user', 'user')]), true)
  assert.equal(initial[0]?.kind, 'message')
  assert.equal(initial[1]?.kind, 'reply')
  assert.equal(initial[1]?.kind === 'reply' && initial[1].active, true)
  const running = buildConversationReplies(work([message('user', 'user', 'run')], 'run'), false)
  const streaming = buildConversationReplies(work([message('user', 'user', 'run'), message('stream', 'employee', 'run')], 'run'), false)
  const settled = buildConversationReplies(work([message('user', 'user', 'run'), message('final', 'employee', 'run')]), false)
  assert.equal(running[1]?.id, streaming[1]?.id)
  assert.equal(streaming[1]?.id, settled[1]?.id)
  assert.equal(streaming.filter(item => item.kind === 'reply').length, 1)
})

test('keeps every reply attached to its own user message and run, including a run without a result', () => {
  const items = buildConversationReplies(work([
    message('first', 'user', 'run-a'), message('answer-a', 'employee', 'run-a'),
    message('second', 'user', 'run-b'), message('answer-b', 'employee', 'run-b'),
    message('third', 'user', 'run-c'), message('error', 'system'),
  ]), false)
  assert.deepEqual(items.map(item => item.kind === 'reply' ? item.runId : item.message.id), ['first', 'run-a', 'second', 'run-b', 'third', 'run-c', 'error'])
  assert.deepEqual(items.filter(item => item.kind === 'reply').map(item => item.messages.map(row => row.content)), [['answer-a'], ['answer-b'], []])
})

test('does not create a reply for a task that has not started or infer historical run IDs', () => {
  const items = buildConversationReplies(work([message('user', 'user'), message('legacy', 'employee')]), false)
  assert.equal(items.length, 2)
  assert.equal(items[1]?.kind === 'reply' && items[1].runId, undefined)
  assert.equal(buildConversationReplies(work([message('user', 'user')]), false).length, 1)
})
