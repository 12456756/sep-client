import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService, type ConversationServiceDependencies } from './conversation-service'
import type { WorkPlan } from '../domain/arrangement-plan'
import type { TaskOwnerScope } from '../data/scope-path'
import { TaskManager } from '../runtime/task-manager'
import { TaskRuntime } from '../runtime/task-runtime'
import { TaskRunStore } from '../data/task-run-store'
import { TaskMetadataStore, type TaskMetadata } from '../data/task-metadata-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { ConversationContextStore } from '../domain/conversation-context'
import { effectivePermissionPolicy } from '../domain/arrangement-plan'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'

function fixture(general = true) {
  let scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const task = { id: 'task', subscriptionId: 'carrier', status: 'completed', activeRunId: null as string | null, scheduledOrigin: undefined as unknown }
  let plan = { id: task.id, mode: 'conversation', conversation: { kind: general ? 'general' : 'employee', ...(general ? { modelId: 'general-model' } : {}),
    participants: [{ subscriptionId: 'carrier', modelId: general ? 'general-model' : 'employee-model' }], activeSubscriptionId: 'carrier' },
    knowledge: { mode: 'auto', knowledgeBaseIds: ['kb'] },
  } as WorkPlan
  let metadata: TaskMetadata = { version: 1, taskId: task.id, kind: 'conversation', participantSubscriptionIds: ['carrier'], currentSubscriptionId: 'carrier', createdAt: 1 }
  const original = structuredClone(plan)
  let denied = false, pending = false, runtimeFails = false, saveFails = false
  let afterAuthorization = () => {}
  const calls: string[] = []
  const service = new ConversationService({
    scope: { currentScope: () => scope },
    taskManager: { async getTask() { return task } },
    employees: {
      async authorize(subscriptionId: string) { calls.push('authorize'); afterAuthorization(); return denied ? null : { subscriptionId, modelId: 'employee-model' } },
      async authorizeModel(modelId: string, subscriptionId: string) { calls.push('authorizeModel'); afterAuthorization(); return denied ? null : { subscriptionId, modelId } },
    },
    workPlans: {
      async get() { return structuredClone(plan) },
      async save(_scope: TaskOwnerScope, value: WorkPlan) { calls.push('plan'); if (saveFails) throw new Error('save failed'); plan = structuredClone(value) },
    },
    execution: async () => ({ async switchConversationEmployee(_taskId: string, subscriptionId: string) {
      calls.push('runtime');
      assert.equal(plan.conversation?.activeSubscriptionId, subscriptionId)
      if (runtimeFails) throw new Error('runtime rejected')
      task.subscriptionId = subscriptionId
    } }),
    taskMetadataStore: { async load() { return metadata }, async save(_scope: TaskOwnerScope, value: TaskMetadata) { calls.push('metadata'); metadata = value } },
    queue: { async whenIdle(_taskId: string, operation: () => Promise<void>) { if (pending) throw Object.assign(new Error('pending'), { code: 'INVALID_STATE' }); await operation() } },
  } as unknown as ConversationServiceDependencies)
  return { service, task, calls, original, get plan() { return plan }, get metadata() { return metadata },
    deny: () => { denied = true }, wait: () => { pending = true }, failRuntime: () => { runtimeFails = true }, failSave: () => { saveFails = true },
    changeAccountDuringAuthorization: () => { afterAuthorization = () => { scope = { memberId: 'other', enterpriseId: 'enterprise' } } },
  }
}

test('a general assistant can hand off to an authorized employee and persist employee mode and model', async () => {
  const f = fixture()
  const updated = await f.service.switchEmployee('task', 'selected')
  assert.deepEqual(updated, f.plan)
  assert.deepEqual(f.plan.conversation, { kind: 'employee', participants: [{ subscriptionId: 'selected', modelId: 'employee-model' }], activeSubscriptionId: 'selected' })
  assert.deepEqual(f.plan.knowledge, f.original.knowledge)
  assert.equal(f.task.subscriptionId, 'selected')
  assert.equal(f.metadata.currentSubscriptionId, 'selected')
  assert.deepEqual(f.metadata.participantSubscriptionIds, ['carrier', 'selected'])
  assert.deepEqual(f.calls, ['authorize', 'plan', 'runtime', 'metadata'])
})

test('failed plan persistence or a runtime rejection leaves the general conversation intact', async () => {
  for (const runtime of [false, true]) {
    const f = fixture()
    if (runtime) f.failRuntime(); else f.failSave()
    await assert.rejects(f.service.switchEmployee('task', 'selected'), new RegExp(runtime ? 'runtime rejected' : 'save failed'))
    assert.deepEqual(f.plan, f.original)
    assert.equal(f.task.subscriptionId, 'carrier')
    assert.equal(f.metadata.currentSubscriptionId, 'carrier')
  }
})

test('choosing the employee that carried the general model still changes to employee mode', async () => {
  const f = fixture()
  await f.service.switchEmployee('task', 'carrier')
  assert.equal(f.plan.conversation?.kind, 'employee')
  assert.deepEqual(f.plan.conversation?.participants, [{ subscriptionId: 'carrier', modelId: 'employee-model' }])
  assert.deepEqual(f.metadata.participantSubscriptionIds, ['carrier'])
})

test('an employee conversation can return to the general assistant using model authorization', async () => {
  const f = fixture(false)
  const updated = await f.service.switchEmployee('task', { kind: 'general', modelId: 'general-model' })
  assert.deepEqual(updated, f.plan)
  assert.deepEqual(f.plan.conversation, { kind: 'general', modelId: 'general-model', participants: [{ subscriptionId: 'carrier', modelId: 'general-model' }], activeSubscriptionId: 'carrier' })
  assert.deepEqual(f.plan.knowledge, f.original.knowledge)
  assert.equal(f.metadata.currentSubscriptionId, 'carrier')
  assert.deepEqual(f.calls, ['authorizeModel', 'plan', 'runtime', 'metadata'])
  await f.service.switchEmployee('task', 'selected')
  assert.equal(f.plan.conversation?.kind, 'employee')
  assert.equal(f.plan.conversation?.modelId, undefined)
})

test('a failed switch to the general assistant restores the previous employee configuration', async () => {
  for (const runtime of [false, true]) {
    const f = fixture(false)
    if (runtime) f.failRuntime(); else f.failSave()
    await assert.rejects(f.service.switchEmployee('task', { kind: 'general', modelId: 'general-model' }))
    assert.deepEqual(f.plan, f.original)
    assert.equal(f.task.subscriptionId, 'carrier')
  }
})

for (const toGeneral of [false, true]) test(`authorization, account changes, active, queued and scheduled work reject a handoff to ${toGeneral ? 'general' : 'employee'} without persistence`, async () => {
  for (const scenario of ['denied', 'account', 'active', 'queued', 'scheduled'] as const) {
    const f = fixture(!toGeneral)
    if (scenario === 'denied') f.deny()
    if (scenario === 'account') f.changeAccountDuringAuthorization()
    if (scenario === 'active') f.task.activeRunId = 'run'
    if (scenario === 'queued') f.wait()
    if (scenario === 'scheduled') f.task.scheduledOrigin = { definitionId: 'schedule' }
    await assert.rejects(f.service.switchEmployee('task', toGeneral ? { kind: 'general', modelId: 'general-model' } : 'selected'), { code: scenario === 'denied' ? toGeneral ? 'MODEL_NOT_ALLOWED' : 'INVALID_ARGUMENT' : scenario === 'account' ? 'AUTH_REQUIRED' : 'INVALID_STATE' })
    assert.deepEqual(f.plan, f.original)
    assert.ok(!f.calls.includes('plan') && !f.calls.includes('runtime'))
  }
})

for (const initialGeneral of [false, true]) test(`a handoff from ${initialGeneral ? 'general' : 'employee'} keeps history and the selected mode after restart`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-conversation-employee-'))
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root), runs = new TaskRunStore(root), plans = new WorkPlanStore(root), metadata = new TaskMetadataStore(root)
  const contexts: PiTaskWorkerOptions['context'][] = []
  const authorizations: string[] = []
  const authorize = async (subscriptionId: string, modelId = 'employee-model') => ({ subscriptionId, modelId, gatewayUrl: 'http://unused', systemPrompt: 'Selected employee instructions' })
  const authorizeEmployee = async (subscriptionId: string, modelId?: string) => { authorizations.push('employee'); return authorize(subscriptionId, modelId) }
  const authorizeModel = async (modelId: string) => { authorizations.push('general'); return { subscriptionId: 'carrier', modelId, gatewayUrl: 'http://unused' } }
  const createRuntime = () => new TaskRuntime({
    taskManager: manager, taskRunStore: runs, workPlanStore: plans,
    resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'employee-model', gatewayUrl: 'http://unused' }),
    authorizeEmployee, authorizeModel,
    getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    createWorker: options => ({
      async run() {
        contexts.push(options.context)
        await mkdir(options.context.sessionDir, { recursive: true })
        const sessionFile = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(sessionFile, '{}\n')
        await options.onSessionCreated?.({ sessionId: 'shared', sessionFile })
        await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 0, occurredAt: Date.now(), type: 'text_delta', data: { text: `Reply ${contexts.length}` } })
      }, async abort() {}, async dispose() {},
    }),
  })
  let runtime = createRuntime()
  try {
    await manager.initialize()
    await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
    const task = await manager.createTask('general handoff', 'first question', join(root, 'workspace'), 'carrier')
    await plans.save(owner, {
      schemaVersion: 1, id: task.id, owner, sourceDraftId: 'draft', sourceDraftRevision: 1,
      mode: 'conversation', title: task.title, goal: task.prompt, confirmedInputs: [], nodes: [],
      conversation: { kind: initialGeneral ? 'general' : 'employee', ...(initialGeneral ? { modelId: 'general-model' } : {}), participants: [{ subscriptionId: 'carrier', modelId: initialGeneral ? 'general-model' : 'employee-model' }], activeSubscriptionId: 'carrier' },
      workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'read-only' }), planHash: 'hash', createdAt: Date.now(),
    })
    await metadata.save(owner, { version: 1, taskId: task.id, kind: 'conversation', participantSubscriptionIds: ['carrier'], currentSubscriptionId: 'carrier', createdAt: Date.now() })
    const settle = async () => {
      for (let i = 0; i < 200; i++) {
        if ((await manager.getTask(task.id))?.activeRunId === null && !runtime.hasConversationRun(task.id)) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.fail('conversation did not settle')
    }
    await runtime.executeTask(task.id, { conversation: true })
    await settle()
    const service = new ConversationService({ scope: { currentScope: () => manager.getCurrentUserScope() }, taskManager: manager,
      workPlans: plans, taskMetadataStore: metadata, employees: { authorize: authorizeEmployee, authorizeModel }, execution: async () => runtime,
    } as unknown as ConversationServiceDependencies)
    const beforeHandoff = authorizations.length
    await service.switchEmployee(task.id, initialGeneral ? 'selected' : { kind: 'general', modelId: 'general-model' })
    assert.deepEqual(authorizations.slice(beforeHandoff), [initialGeneral ? 'employee' : 'general', initialGeneral ? 'employee' : 'general'])
    await runtime.continueConversation(task.id, 'second question')
    await settle()
    await runtime.stopAll()
    runtime = createRuntime()
    await runtime.continueConversation(task.id, 'third question')
    await settle()
    assert.deepEqual(contexts.map(context => context.subscriptionId), initialGeneral ? ['carrier', 'selected', 'selected'] : ['carrier', 'carrier', 'carrier'])
    assert.deepEqual(contexts.map(context => context.modelId), initialGeneral ? ['general-model', 'employee-model', 'employee-model'] : ['employee-model', 'general-model', 'general-model'])
    assert.equal(contexts[0].useNativeSystemPrompt, initialGeneral ? true : undefined)
    for (const context of contexts.slice(1)) {
      assert.equal(context.systemPrompt, initialGeneral ? 'Selected employee instructions' : undefined)
      assert.equal(context.useNativeSystemPrompt, initialGeneral ? undefined : true)
    }
    assert.equal(contexts[1].resumeSessionFile, join(contexts[0].sessionDir, 'session.jsonl'))
    assert.equal(contexts[2].resumeSessionFile, contexts[1].resumeSessionFile)
    assert.equal((await plans.get(owner, task.id))?.conversation?.kind, initialGeneral ? 'employee' : 'general')
    const history = await new ConversationContextStore(runs.getTaskDir(owner, task.id)).listMessages()
    assert.deepEqual(history.filter(message => message.role === 'user').map(message => message.content), ['first question', 'second question', 'third question'])
    assert.deepEqual(history.filter(message => message.role === 'assistant').map(message => message.content), ['Reply 1', 'Reply 2', 'Reply 3'])
  } finally { await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
})
