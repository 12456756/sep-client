import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { bindConversationSchedule, conversationScheduleReceipt, conversationScheduleRequestId, isConversationScheduleTimeReply, precedingConversationUser } from './conversation-schedule'
import { CONVERSATION_SCHEDULE_EVENT, type ConversationScheduleReceipt } from '../../src/shared/scheduled-creation'
import type { ConversationMessage } from '../domain/conversation-context'
import type { TaskExecutionEvent } from '../../src/shared/types'
import { conversationScheduleToolDefinition } from '../pi/sdk/pi-conversation-schedule'

test('the tool may be called for a concrete job with a clear date or recurrence but no hour', () => {
  const tool = conversationScheduleToolDefinition(async () => assert.fail('reading the description must not submit'))
  assert.match(tool.description, /action=resume.*今天的14:40/)
  assert.match(tool.description, /If only the time of day is omitted, use 09:00/)
  assert.match(tool.description, /Do not use for status or capability questions, examples, quotes, cancellation/)
})

test('host routing only recognizes standalone clock replies, not questions, quotations or new work', () => {
  for (const value of ['每天早上10点', '改成早上 10 点。', '上午十点半', '调整到 １０：３０', '下午三点一刻']) {
    assert.equal(isConversationScheduleTimeReply(value), true, value)
  }
  for (const value of ['明天的会上午10点开', '每天9点发日报', '10点可以吗？', '不要改成10点', '> 早上10点', '“上午10点”']) {
    assert.equal(isConversationScheduleTimeReply(value), false, value)
  }
})

test('only a valid receipt from the immediately preceding user turn in this conversation can be resumed', async () => {
  const draft = { id: conversationScheduleRequestId('chat', 'first'), revision: 3 }
  const user = (runId: string, taskId = 'chat'): ConversationMessage => ({ id: runId, taskId, runId, turnId: runId, subscriptionId: 'sub',
    modelId: 'chat-model', role: 'user', content: 'message', createdAt: 42 })
  const event = (runId: string, data: unknown, taskId = 'chat', type = CONVERSATION_SCHEDULE_EVENT): TaskExecutionEvent => ({
    runId, taskId, data, type, subscriptionId: 'sub', sequence: 1, occurredAt: 42 })
  const pending = event('first', { status: 'needs_input', message: 'What time?', draft })
  const read = async (id: string) => id === 'first' ? [pending] : []
  const previousConversationScheduleDraft = async (taskId: string, runId: string, messages: ConversationMessage[], timeline: typeof read) => {
    const preceding = precedingConversationUser(taskId, runId, messages)
    const receipt = preceding && await conversationScheduleReceipt(preceding, timeline)
    return receipt?.status === 'needs_input' ? receipt.draft : undefined
  }
  assert.deepEqual(await previousConversationScheduleDraft('chat', 'second', [user('first')], read), draft)
  assert.deepEqual(await previousConversationScheduleDraft('chat', 'second', [user('first'), user('second')], read), draft)
  assert.equal(await previousConversationScheduleDraft('chat', 'third', [user('first'), user('unrelated')], read), undefined)
  assert.equal(await previousConversationScheduleDraft('chat', 'second', [user('first', 'other')], read), undefined)
  assert.equal(await previousConversationScheduleDraft('chat', 'second', [user('first')], async () => [{ ...pending, taskId: 'other' }]), undefined)
  assert.equal(await previousConversationScheduleDraft('chat', 'second', [user('first')], async () => [pending, event('first', null, 'chat', 'run_cancelled')]), undefined)
  assert.equal(await previousConversationScheduleDraft('chat', 'second', [user('first')], async () => [pending, event('first', { status: 'cancelled', message: 'Cancelled' })]), undefined)
})

test('resuming sends only the user answer to the same versioned draft and never starts a new request', async () => {
  const draft = { id: conversationScheduleRequestId('chat', 'first'), revision: 3 }
  const options = { taskId: 'chat', messageId: 'second', userMessage: '每天早上10点', receivedAt: 43, modelId: 'model',
    workDir: 'D:/workspace', signal: new AbortController().signal, isCurrent: () => true,
    approve: async () => false, receipt: async () => {} }
  const expected = { status: 'cancelled', message: 'cancelled in test' } as const
  const bound = bindConversationSchedule({ ...options, draft, submit: async request => {
    assert.equal(request.requestId, draft.id)
    assert.equal(request.expectedRevision, 3)
    assert.equal(request.message, options.userMessage)
    return expected
  } })
  assert.deepEqual(await bound(), expected)
  const standalone = bindConversationSchedule({ ...options, submit: async () => assert.fail('no eligible draft') })
  assert.equal((await standalone()).status, 'blocked')
})

test('the host submits the current user message and settings once, without model-supplied text', async () => {
  const userMessage = '每天早上八点帮我生成简报'
  const receipts: ConversationScheduleReceipt[] = []
  let calls = 0
  let current = true
  const tool = bindConversationSchedule({
    taskId: 'chat', messageId: 'message:stable', userMessage, receivedAt: 42,
    modelId: 'chat-model', workDir: 'D:/workspace', signal: new AbortController().signal, isCurrent: () => current,
    approve: async () => false, receipt: async receipt => { receipts.push(receipt) },
    submit: async (request, review) => {
      calls++
      assert.equal(request.message, userMessage)
      assert.equal(request.modelId, 'chat-model')
      assert.equal(request.workDir, 'D:/workspace')
      assert.deepEqual(request.permissions, { preset: 'workspace-edit', approvalMode: 'confirm-each' })
      assert.equal(request.requestId, conversationScheduleRequestId('chat', 'message:stable'))
      assert.equal(review.receivedAt, 42)
      return { status: 'created', id: 'definition', title: '简报', nextRunAt: 100, timezone: 'Asia/Shanghai' }
    },
  })
  const [a, b] = await Promise.all([tool(), tool()])
  assert.deepEqual(a, b)
  assert.equal(calls, 1)
  assert.deepEqual(receipts.map(receipt => receipt.status), ['pending', 'created'])
  current = false
  await assert.rejects(tool(), /no longer active/)
})

test('empty, quoted, and fenced user messages do not reach scheduled creation', async () => {
  for (const userMessage of ['   ', '> 每天早上八点生成简报\n> 并保存到本地', '```text\n每天早上八点生成简报\n```', '~~~\n每天早上八点生成简报\n~~~']) {
    const tool = bindConversationSchedule({
      taskId: 'chat', messageId: 'message:quoted', userMessage, receivedAt: 42,
      modelId: 'chat-model', workDir: 'D:/workspace', signal: new AbortController().signal, isCurrent: () => true,
      approve: async () => assert.fail('untrusted text cannot request approval'), receipt: async () => {},
      submit: async () => assert.fail('untrusted text cannot be submitted'),
    })
    assert.equal((await tool()).status, 'blocked')
  }
})
