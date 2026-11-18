import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ConversationService, type ConversationServiceDependencies } from './conversation-service'
import type { WorkPlan } from '../domain/arrangement-plan'
import type { TaskOwnerScope } from '../data/scope-path'
import { toEnvelope } from '../errors/error-mapper'
import { AppError } from '../errors/app-error'

function fixture(general = false) {
  let scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const task = { id: 'task', subscriptionId: 'employee', status: 'completed', activeRunId: null, scheduledOrigin: undefined as unknown }
  let plan = { id: 'task', owner: { ...scope }, mode: 'conversation',
    conversation: general ? { kind: 'general', modelId: 'model-a', participants: [], activeSubscriptionId: null }
      : { participants: [{ subscriptionId: 'employee', modelId: 'model-a' }, { subscriptionId: 'other', modelId: 'other-model' }], activeSubscriptionId: 'employee' },
  } as WorkPlan
  let saved = 0
  let allowed = true
  let pending = false
  let authorizeHook = () => {}
  const authorizations: unknown[] = []
  const service = new ConversationService({
    scope: { currentScope: () => scope },
    taskManager: { async getTask() { return task } },
    workPlans: { async get() { return structuredClone(plan) }, async save(_owner: TaskOwnerScope, next: WorkPlan) { saved++; plan = structuredClone(next) } },
    employees: {
      async authorize(subscriptionId: string, modelId: string) { authorizations.push(['employee', subscriptionId, modelId]); authorizeHook(); return allowed ? { modelId } : null },
      async authorizeModel(modelId: string, subscriptionId: string) { authorizations.push(['general', subscriptionId, modelId]); authorizeHook(); return allowed ? { modelId } : null },
    },
    queue: { async whenIdle(_id: string, operation: () => Promise<void>) { if (pending) throw Object.assign(new Error('pending'), { code: 'INVALID_STATE' }); await operation() } },
  } as unknown as ConversationServiceDependencies)
  return { service, task, get plan() { return plan }, get saved() { return saved }, authorizations,
    deny: () => { allowed = false }, wait: () => { pending = true },
    duringAuthorization: (hook: () => void) => { authorizeHook = hook },
    switchScope: () => { scope = { memberId: 'other', enterpriseId: 'enterprise' } },
  }
}

test('employee model selection is authorized and persisted without changing other participants', async () => {
  const f = fixture()
  const result = await f.service.switchModel('task', 'model-b')
  assert.deepEqual(result.conversation?.participants, [{ subscriptionId: 'other', modelId: 'other-model' }, { subscriptionId: 'employee', modelId: 'model-b' }])
  assert.equal(f.plan.conversation?.participants.find(item => item.subscriptionId === 'employee')?.modelId, 'model-b')
  assert.deepEqual(f.authorizations, [['employee', 'employee', 'model-b']])
  assert.equal(f.saved, 1)
})

test('general assistant selection uses model authorization and survives reading the saved plan', async () => {
  const f = fixture(true)
  await f.service.switchModel('task', 'model-b')
  assert.equal(f.plan.conversation?.modelId, 'model-b')
  assert.deepEqual(f.authorizations, [['general', 'employee', 'model-b']])
  assert.deepEqual(f.plan.conversation?.participants, [])
})

test('unavailable models, queued input, active runs and scheduled records cannot change the saved model', async () => {
  for (const scenario of ['denied', 'pending', 'active', 'scheduled'] as const) {
    const f = fixture()
    if (scenario === 'denied') f.deny()
    if (scenario === 'pending') f.wait()
    if (scenario === 'active') f.task.status = 'running'
    if (scenario === 'scheduled') f.task.scheduledOrigin = { definitionId: 'schedule' }
    await assert.rejects(f.service.switchModel('task', 'model-b'), { code: scenario === 'denied' ? 'MODEL_NOT_ALLOWED' : 'INVALID_STATE' })
    assert.equal(f.saved, 0)
  }
})

test('an account change during authorization cannot save to the previous conversation', async () => {
  const f = fixture()
  f.duringAuthorization(f.switchScope)
  await assert.rejects(f.service.switchModel('task', 'model-b'), { code: 'AUTH_REQUIRED' })
  assert.equal(f.saved, 0)
})

test('model switching errors use the shared feedback channel with actionable reasons', () => {
  const result = toEnvelope(new AppError('INVALID_STATE', { message: '请等待当前回复结束或终止后再切换模型。' }), { feedbackOperation: 'workModel' })
  assert.match(result.message, /请等待当前回复结束或终止后再切换模型/)
  const unknown = toEnvelope(new Error('internal detail'), { feedbackOperation: 'workModel' })
  assert.match(unknown.message, /模型切换失败/)
  assert.doesNotMatch(unknown.message, /internal detail|员工切换/)
})
