import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import { test } from 'node:test'
import * as ts from 'typescript'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { attachmentImportLimits, attachmentRefSchema } from '../../src/shared/attachment-contracts'
import { knowledgeSelectionSchema } from '../../src/shared/knowledge-selection'
import { conversationQueueInputSchema } from '../../src/shared/conversation-queue'
import { conversationScheduleDraftActionSchema, conversationScheduleDraftActionText } from '../../src/shared/scheduled-creation'
import { FEEDBACK_OPERATION_BY_CHANNEL, INVOKE_CHANNELS } from './channels'
import { AppError } from '../errors/app-error'
import { toEnvelope } from '../errors/error-mapper'
import type { Route } from './router'
import type { RequestContext } from './request-context'

const source = readFileSync(new URL('./routes/conversation.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const dependencies: Record<string, unknown> = {
  zod: { z }, 'node:crypto': { randomUUID }, '../channels': { INVOKE_CHANNELS },
  '../router': { route: (channel: string, schema: z.ZodType, handle: Route['handle']) => ({ channel, schema, handle }) },
  './task': { createTaskInput: z.object({}), CREATE_TASK_INVALID: '' },
  '../../../src/shared/attachment-contracts': { attachmentImportLimits, attachmentRefSchema },
  '../../../src/shared/knowledge-selection': { knowledgeSelectionSchema },
  '../../../src/shared/conversation-queue': { conversationQueueInputSchema },
  '../../../src/shared/scheduled-creation': { conversationScheduleDraftActionSchema, conversationScheduleDraftActionText },
}
const loaded = { exports: {} as { conversationRoutes?: Route[] } }
compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => {
  assert.ok(Object.hasOwn(dependencies, id)); return dependencies[id]
}, loaded.exports, loaded)
const route = loaded.exports.conversationRoutes!.find(item => item.channel === INVOKE_CHANNELS.TASK_CONTINUE)!
const queueRoute = loaded.exports.conversationRoutes!.find(item => item.channel === INVOKE_CHANNELS.CONVERSATION_QUEUE)!
const switchRoute = loaded.exports.conversationRoutes!.find(item => item.channel === INVOKE_CHANNELS.TASK_SWITCH_EMPLOYEE)!

test('conversation handoff validates employee and general targets and returns the changed plan', async () => {
  const targets = [
    [{ taskId: 'task', subscriptionId: 'employee' }, 'employee'],
    [{ taskId: 'task', kind: 'general', modelId: 'model' }, { kind: 'general', modelId: 'model' }],
  ] as const
  for (const [input, target] of targets) {
    const plan = { id: 'task' }
    const context = { conversations: { async switchEmployee(taskId: string, value: unknown) {
      assert.equal(taskId, 'task'); assert.deepEqual(value, target); return plan
    } } } as unknown as RequestContext
    assert.deepEqual(await switchRoute.handle(context, switchRoute.schema.parse(input) as never), { success: true, plan })
  }
  for (const input of [
    { taskId: 'task', kind: 'general' },
    { taskId: 'task', kind: 'general', modelId: '  ' },
    { taskId: 'task', kind: 'general', modelId: 'model', subscriptionId: 'employee' },
    { taskId: 'task', kind: 'unexpected', subscriptionId: 'employee' },
  ]) assert.equal(switchRoute.schema.safeParse(input).success, false)
})

test('conversation accepts 128 attachment references and rejects 129', () => {
  const input = { taskId: 'task', prompt: 'Inspect attachments', attachmentRefs: Array.from({ length: 128 }, (_, index) => ({ attachmentId: `attachment-${index}`, sha256: 'a'.repeat(64) })) }
  assert.equal(route.schema.safeParse(input).success, true)
  assert.equal(route.schema.safeParse({ ...input, attachmentRefs: [...input.attachmentRefs, input.attachmentRefs[0]] }).success, false)
})

test('conversation accepts only the exact display text and valid version for a draft action', async () => {
  const scheduleDraftAction = { kind: 'review', draft: { id: '11111111-1111-4111-8111-111111111111', revision: 3 }, time: '14:13' } as const
  const input = { taskId: 'chat', prompt: conversationScheduleDraftActionText(scheduleDraftAction), scheduleDraftAction }
  const context = { conversations: { async continue(value: Record<string, unknown>) {
    assert.deepEqual(value.scheduleDraftAction, scheduleDraftAction); return { queued: false }
  } } } as unknown as RequestContext
  assert.deepEqual(await route.handle(context, route.schema.parse(input) as never), { success: true, queued: false })
  assert.equal(route.schema.safeParse({ ...input, prompt: 'other request' }).success, false)
  assert.equal(route.schema.safeParse({ ...input, scheduleDraftAction: { ...scheduleDraftAction, time: '24:15' } }).success, false)
})

test('conversation queue accepts a validated priority action and rejects unrelated fields', () => {
  assert.deepEqual(queueRoute.schema.parse({ taskId: 'task', action: 'prioritize', entryId: 'queued-message' }), {
    taskId: 'task', action: 'prioritize', entryId: 'queued-message',
  })
  assert.throws(() => queueRoute.schema.parse({ taskId: 'task', action: 'prioritize', entryId: '../outside' }))
  assert.throws(() => queueRoute.schema.parse({ taskId: 'task', action: 'prioritize', unexpected: true }))
})

test('queue read errors are not reported as message send failures', () => {
  const error = new AppError('INVALID_ARGUMENT')
  const queueError = toEnvelope(error, { feedbackOperation: FEEDBACK_OPERATION_BY_CHANNEL[queueRoute.channel] })
  const sendError = toEnvelope(error, { feedbackOperation: FEEDBACK_OPERATION_BY_CHANNEL[route.channel] })
  assert.match(queueError.message, /^对话队列读取失败/)
  assert.match(sendError.message, /^消息发送失败/)
})

test('conversation skip requires a snapshot token and does not accept a replay or replacement prompt', async () => {
  const input = { taskId: 'task', action: 'skip', skipToken: 'a'.repeat(64) }
  const queue = { paused: false, items: [], failed: null, skipped: true }
  const context = { conversations: { async queue(value: unknown) {
    assert.deepEqual(value, input); return queue
  } } } as unknown as RequestContext
  assert.deepEqual(await queueRoute.handle(context, queueRoute.schema.parse(input) as never), { success: true, queue })
  for (const bad of [{ ...input, skipToken: undefined }, { ...input, skipToken: 'old-run' }, { ...input, prompt: 'send automatically' }]) {
    assert.equal(queueRoute.schema.safeParse(bad).success, false)
  }
})

for (const queued of [false, true]) test(`continue returns the backend waiting decision queued=${queued}`, async () => {
  const input = route.schema.parse({ taskId: 'task', messageId: 'message', prompt: 'follow-up', queued: !queued })
  const context = { conversations: { async continue(value: Record<string, unknown>) {
    assert.equal(value.taskId, 'task'); assert.equal(value.messageId, 'message')
    assert.equal(Object.hasOwn(value, 'queued'), false)
    return { queued }
  } } } as unknown as RequestContext
  assert.deepEqual(await route.handle(context, input as never), { success: true, queued })
})
