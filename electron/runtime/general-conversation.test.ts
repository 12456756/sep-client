import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRuntime } from './task-runtime'
import { TaskManager } from './task-manager'
import { TaskRunStore } from '../data/task-run-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { effectivePermissionPolicy } from '../domain/arrangement-plan'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'

test('general chat preserves selected model, permissions and history across turns and restart without employee behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-general-chat-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root)
  const plans = new WorkPlanStore(root)
  const runs = new TaskRunStore(root)
  const contexts: PiTaskWorkerOptions['context'][] = []
  let subscriptionId = 'subscription-a'
  let runtime: TaskRuntime | undefined
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      if ((await manager.getTask(id))?.activeRunId === null) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('run did not settle')
  }
  const createRuntime = () => new TaskRuntime({
    taskManager: manager, taskRunStore: runs, workPlanStore: plans,
    resolveEmployee: id => ({ subscriptionId: id, modelId: 'model', gatewayUrl: 'http://unused' }),
    authorizeEmployee: async () => assert.fail('must not authorize employee or prepare skills'),
    authorizeModel: async modelId => ({ subscriptionId, modelId, gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    knowledgeSearch: async () => assert.fail('must not search employee knowledge'),
    media: { async prepareRun() { assert.fail('must not prepare employee media') }, async stopTask() {}, async waitForRun() {} },
    createWorker: options => ({
      async run(prompt) {
        contexts.push(options.context)
        assert.ok(['first', 'second', 'third'].includes(prompt))
        await mkdir(options.context.sessionDir, { recursive: true })
        const file = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(file, '{}\n', 'utf8')
        await options.onSessionCreated?.({ sessionId: 'shared', sessionFile: file })
      }, async abort() {}, async dispose() {},
    }),
  })
  try {
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('general', 'first', join(root, 'workspace'), subscriptionId)
    await plans.save(scope, {
      id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope, mode: 'conversation',
      title: 'general', goal: 'first', nodes: [], confirmedInputs: [],
      conversation: { kind: 'general', modelId: 'selected', participants: [{ subscriptionId, modelId: 'selected' }], activeSubscriptionId: subscriptionId },
      workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'confirm-each' }),
      planHash: 'general', createdAt: Date.now(),
    })
    runtime = createRuntime()
    await runtime.executeTask(task.id, { conversation: true })
    await settle(task.id)
    subscriptionId = 'subscription-b'
    await runtime.continueConversation(task.id, 'second')
    await settle(task.id)
    await runtime.stopAll()
    runtime = createRuntime()
    await runtime.continueConversation(task.id, 'third')
    await settle(task.id)
    assert.equal(contexts.length, 3)
    for (const context of contexts) {
      assert.equal(context.modelId, 'selected')
      assert.equal(context.employeeProfile, undefined)
      assert.equal(context.systemPrompt, undefined)
      assert.equal(context.useNativeSystemPrompt, true)
      assert.equal(context.disableSkills, true)
      assert.deepEqual(context.additionalSkillPaths, [])
      assert.equal(context.toolPolicy?.preset, 'workspace-edit')
      assert.equal(context.transformSystemPrompt?.('unknown dynamic text'), 'unknown dynamic text')
    }
    assert.equal(contexts[1].resumeSessionFile, join(contexts[0].sessionDir, 'session.jsonl'))
    assert.equal(contexts[2].resumeSessionFile, contexts[1].resumeSessionFile)
    assert.deepEqual((await runs.list(scope, task.id)).map(run => run.subscriptionId).sort(), ['subscription-a', 'subscription-b', 'subscription-b'])
  } finally { await runtime?.stopAll(); await rm(root, { recursive: true, force: true }) }
})
