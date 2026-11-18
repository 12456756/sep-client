import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRuntime } from './task-runtime'
import { TaskManager } from './task-manager'
import { TaskRunStore } from '../data/task-run-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { ConversationContextStore } from '../domain/conversation-context'
import { effectivePermissionPolicy } from '../domain/arrangement-plan'
import { ConversationService, type ConversationServiceDependencies } from '../service/conversation-service'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'

for (const general of [false, true]) {
  test(`${general ? 'general' : 'employee'} conversation uses the changed model for follow-ups and after runtime restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-conversation-model-'))
    const owner = { memberId: 'member', enterpriseId: 'enterprise' }
    const manager = new TaskManager(root), runs = new TaskRunStore(root), plans = new WorkPlanStore(root)
    const contexts: PiTaskWorkerOptions['context'][] = []
    const authorize = async (subscriptionId: string, modelId = 'model-a') => ({ subscriptionId, modelId, gatewayUrl: 'http://unused' })
    const createRuntime = () => new TaskRuntime({
      taskManager: manager, taskRunStore: runs, workPlanStore: plans,
      resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'model-a', gatewayUrl: 'http://unused' }),
      authorizeEmployee: authorize, authorizeModel: modelId => authorize('employee', modelId),
      getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
      createWorker: options => ({
        async run() {
          contexts.push(options.context)
          await mkdir(options.context.sessionDir, { recursive: true })
          const sessionFile = join(options.context.sessionDir, 'session.jsonl')
          await writeFile(sessionFile, '{}\n')
          await options.onSessionCreated?.({ sessionId: 'shared', sessionFile })
          await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: 'employee',
            sequence: 0, occurredAt: Date.now(), type: 'text_delta', data: { text: `Reply ${contexts.length}` } })
        }, async abort() {}, async dispose() {},
      }),
    })
    let runtime = createRuntime()
    try {
      await manager.initialize()
      await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
      const task = await manager.createTask('model switch', 'first question', join(root, 'workspace'), 'employee')
      await plans.save(owner, {
        schemaVersion: 1, id: task.id, owner, sourceDraftId: 'draft', sourceDraftRevision: 1,
        mode: 'conversation', title: task.title, goal: task.prompt, confirmedInputs: [], nodes: [],
        conversation: { ...(general ? { kind: 'general', modelId: 'model-a' } : {}), participants: [{ subscriptionId: 'employee', modelId: 'model-a' }], activeSubscriptionId: 'employee' },
        workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'read-only' }),
        planHash: 'hash', createdAt: Date.now(),
      })
      const settle = async () => {
        for (let i = 0; i < 200; i++) {
          if ((await manager.getTask(task.id))?.activeRunId === null) return
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.fail('conversation did not settle')
      }
      await runtime.executeTask(task.id, { conversation: true })
      await settle()
      const service = new ConversationService({ scope: { currentScope: () => owner }, taskManager: manager, workPlans: plans,
        employees: { authorize, authorizeModel: (modelId: string) => authorize('employee', modelId) },
      } as unknown as ConversationServiceDependencies)
      await service.switchModel(task.id, 'model-b')
      await runtime.continueConversation(task.id, 'second question')
      await settle()
      await runtime.stopAll()
      runtime = createRuntime()
      await runtime.continueConversation(task.id, 'third question')
      await settle()
      assert.deepEqual(contexts.map(context => context.modelId), ['model-a', 'model-b', 'model-b'])
      assert.equal(contexts[1].resumeSessionFile, join(contexts[0].sessionDir, 'session.jsonl'))
      assert.equal(contexts[2].resumeSessionFile, contexts[1].resumeSessionFile)
      const records = await runs.list(owner, task.id)
      assert.deepEqual(records.map(record => record.modelId).sort(), ['model-a', 'model-b', 'model-b'])
      const history = await new ConversationContextStore(runs.getTaskDir(owner, task.id)).listMessages()
      assert.deepEqual(history.filter(message => message.role === 'user').map(message => message.content), ['first question', 'second question', 'third question'])
      assert.deepEqual(history.filter(message => message.role === 'assistant').map(message => message.content), ['Reply 1', 'Reply 2', 'Reply 3'])
    } finally { await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
  })
}
