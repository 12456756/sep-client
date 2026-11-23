import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { bindConversationSchedule, conversationScheduleRequestId } from './conversation-schedule'
import type { ConversationScheduleReceipt } from '../../src/shared/scheduled-creation'

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
