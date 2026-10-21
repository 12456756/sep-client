import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStatus } from '../../src/shared/types'
import { evaluateToolCall } from '../../pi-extension/guard'
import type { Subscription } from '../common/platform/platform-api'
import { ArrangementDraftStore } from '../data/arrangement-draft-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ScopePath } from '../data/scope-path'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { ArrangementService } from '../service/arrangement-service'
import { EmployeeAuthorizer } from '../service/employee-authorizer'
import { PiArrangementPlanner } from './pi-arrangement-planner'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'

const scope = { enterpriseId: 'company-id', memberId: 'member-id' }
const names = { enterpriseName: '\u661f\u6cb3 Company', memberName: '\u5f20\u4e09 User' }
const gatewayUrl = 'http://gateway.invalid'
const employee: Subscription = {
  id: 'sub-a', subscriptionId: 'sub-a', employeeId: 'employee-a', name: 'Researcher',
  status: 'ACTIVE', templateVersion: '1.0.0',
  template: { id: 'employee-a', name: 'Researcher', avatar: null },
  department: null, allowedModels: ['model-a'], upgradeAvailable: false,
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Arrangement did not reach the expected state.')
}

for (const { manual, invalidDelivery } of [{ manual: false, invalidDelivery: false }, { manual: true, invalidDelivery: false }, { manual: false, invalidDelivery: true }]) {
  it(`plans, confirms and ${invalidDelivery ? 'fails undelivered work' : 'executes an arrangement'} in a ${manual ? 'manual' : 'name-based default'} workspace`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-workspace-'))
    const runs = new TaskRunStore(root)
    const manager = new TaskManager(root, null, undefined, runs)
    const plans = new WorkPlanStore(root)
    const checkpoints = new ArrangementCheckpointStore(root)
    const metadata = new TaskMetadataStore(root)
    const authorizer = new EmployeeAuthorizer(
      { async getValidAccessToken() { return 'test-token' }, getMeta: () => scope },
      { async list() { return [employee] }, async refresh() { return [employee] }, snapshot: () => [employee], invalidate() {} },
      { async prepare() { return { skillPaths: [] } }, invalidate() {} },
      gatewayUrl,
    )
    const executed: string[] = []
    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: runs, workPlanStore: plans, arrangementCheckpointStore: checkpoints,
      getRefreshToken: () => 'test-token', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
      resolveEmployee: id => authorizer.resolve(id),
      authorizeEmployee: (id, modelId) => authorizer.authorize(id, modelId),
      createWorker: options => ({
        async run() {
          const context = options.context
          const task = await manager.getTask(context.taskId)
          assert.equal(context.workspaceDir, task?.workDir)
          assert.equal(context.toolPolicy?.workspaceDir, context.workspaceDir)
          assert.deepEqual(context.toolPolicy?.allowedPaths, [])
          assert.equal(context.toolPolicy?.preset, 'workspace-edit')
          const paths = runs.getPaths(scope, context.taskId, context.runId)
          assert.equal(context.agentDir, paths.agentDir)
          assert.equal(context.sessionDir, paths.sessionDir)
          const nodeId = executed.length === 0 ? 'research' : 'report'
          const artifact = join(context.workspaceDir, `${nodeId}-result.txt`)
          assert.ok(context.toolPolicy)
          assert.equal(evaluateToolCall('write', { path: artifact }, context.toolPolicy).allowed, true)
          assert.equal(evaluateToolCall('read', { path: artifact }, context.toolPolicy).allowed, true)
          assert.equal(evaluateToolCall('write', { path: join(root, 'outside.txt') }, context.toolPolicy).allowed, false)
          if (nodeId === 'report') {
            assert.equal(await readFile(join(context.workspaceDir, 'research-result.txt'), 'utf8'), 'research result')
            assert.ok(context.fixedSystemPrompt?.includes('research-result.txt'))
          }
          if (!invalidDelivery) await writeFile(artifact, `${nodeId} result`, 'utf8')
          executed.push(context.workspaceDir)
          await options.onEvent({
            taskId: context.taskId, runId: context.runId, subscriptionId: context.subscriptionId,
            sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'research result' },
          })
          for (let validation = 0; validation < 5; validation++) {
            assert.equal((await manager.getTask(context.taskId))?.status, TaskStatus.RUNNING)
            const checkpoint = await checkpoints.get(scope, context.taskId)
            assert.equal(checkpoint?.state.status, 'running')
            assert.equal(checkpoint?.state.nodes.find(node => node.nodeId === nodeId)?.status, 'running')
            const correction = await options.onResponseSettled?.({ text: JSON.stringify({
              nodeId, summary: `${nodeId} result`, finalDeliverables: [{ id: 'result', path: `${nodeId}-result.txt` }],
            }), stopReason: 'stop' })
            if (!correction) return
            assert.equal((await manager.getTask(context.taskId))?.status, TaskStatus.RUNNING)
            assert.equal((await checkpoints.get(scope, context.taskId))?.state.nodes.find(node => node.nodeId === nodeId)?.status, 'running')
            assert.match(correction.continueWith, /FILE_MISSING/)
          }
          assert.fail('Failed delivery must throw on the fifth validation')
        },
        async abort() {}, async dispose() {},
      }),
    })
    t.after(async () => {
      await runtime.stopAll()
      await rm(root, { recursive: true, force: true })
    })
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId, names)
    const planningRoot = join(root, 'arrangement-planning')
    let planningCalls = 0
    const planner = new PiArrangementPlanner({
      gatewayUrl, workspaceRoot: planningRoot,
      getRefreshToken: () => 'test-token', onAuthenticationRequired() {},
      createWorker: options => ({
        async run(prompt) {
          planningCalls++
          assert.equal(options.context.workspaceDir, planningRoot)
          assert.equal((await manager.getAllTasks()).length, 0)
          assert.ok(!prompt.includes(names.enterpriseName))
          assert.ok(!prompt.includes(names.memberName))
          const event = {
            taskId: options.context.taskId, runId: options.context.runId,
            subscriptionId: employee.subscriptionId, sequence: 1,
            type: 'text_delta' as const, occurredAt: Date.now(),
            data: { text: JSON.stringify({
              title: 'Research report',
              nodes: ['research', 'report'].map((id, index) => ({
                id, subscriptionId: employee.subscriptionId, modelId: 'model-a', title: id,
                instruction: `Complete ${id}`, expectedOutput: `${id} result`,
                knowledgeQuery: `Internal guidance for ${id}`,
                objective: `Deliver ${id} results`,
                deliverables: [{ id: 'result', name: `${id} result`, format: 'txt', path: `${id}-result.txt`,
                  contentOutline: ['Research findings'], acceptanceCriteria: ['Contains research findings'] }],
                dependsOn: index === 0 ? [] : ['research'], requiresUserConfirmation: false,
              })),
            }) },
          }
          await options.onEvent(event)
          await options.onResponseSettled?.({ text: event.data.text, stopReason: 'stop' })
        },
        async abort() {}, async dispose() {},
      }),
    })
    const service = new ArrangementService({
      scope: { currentScope: () => manager.getCurrentUserScope() },
      drafts: new ArrangementDraftStore(root), employees: authorizer,
      workPlans: plans, taskMetadata: metadata, taskManager: manager,
      execution: async () => runtime, planner,
    })
    const manualPath = join(root, '\u81ea\u9009 workspace')
    const draft = await service.createDraft({
      schemaVersion: 1, mode: 'auto', status: 'editing', title: '', goal: 'Prepare a report',
      confirmedInputs: [], sharedSkillIds: [], conversation: null, nodes: [],
      workspace: { mode: 'shared', path: manual ? manualPath : null },
      permissions: { preset: 'workspace-edit', approvalMode: 'auto-approve' }, lastPlanning: null,
    })
    await service.startPlanning(draft.id, draft.revision, 'model-a')
    await waitFor(async () => (await service.getDraft(draft.id)).status !== 'planning')
    const ready = await service.getDraft(draft.id)
    assert.equal(ready.status, 'ready', ready.lastPlanning?.message ?? undefined)
    assert.equal(planningCalls, 1)
    assert.equal((await manager.getAllTasks()).length, 0)
    const confirmed = await service.confirmAndStart(ready.id, ready.revision, 'confirm-key')
    const taskId = confirmed.plan.id
    const workspace = manual ? manualPath : join(root, 'task-workspaces', 'v1', names.enterpriseName, names.memberName, taskId)
    assert.equal(confirmed.plan.workspace.path, workspace)
    assert.deepEqual(confirmed.plan.owner, scope)
    assert.equal((await plans.get(scope, taskId))?.workspace.path, workspace)
    assert.equal((await metadata.load(scope, taskId))?.kind, 'arrangement')
    await waitFor(async () => {
      const task = await manager.getTask(taskId)
      if (!invalidDelivery) assert.notEqual(task?.status, TaskStatus.FAILED, task?.error ?? undefined)
      assert.notEqual(task?.status, TaskStatus.PAUSED, task?.error ?? undefined)
      return task?.status === (invalidDelivery ? TaskStatus.FAILED : TaskStatus.COMPLETED) && task.activeRunId === null
    })
    assert.deepEqual(executed, invalidDelivery ? [workspace] : [workspace, workspace])
    assert.equal((await checkpoints.get(scope, taskId))?.state.status, invalidDelivery ? 'failed' : 'completed')
    if (invalidDelivery) assert.equal((await checkpoints.get(scope, taskId))?.state.nodes[0]?.delivery?.validationAttempts, 5)
    const records = await runs.list(scope, taskId)
    assert.equal(records.length, invalidDelivery ? 2 : 3)
    for (const record of records) {
      assert.equal(record.workspaceDir, workspace)
      assert.equal(record.outcome, invalidDelivery ? 'failed' : 'completed')
      assert.deepEqual(record.owner, scope)
    }
    const paths = new ScopePath(root)
    assert.ok(paths.workPlanFile(scope, taskId).startsWith(join(root, 'task-data', 'v3')))
    assert.ok(!paths.ownerRoot(scope).includes(names.enterpriseName))
    const restarted = new TaskManager(root)
    await restarted.initialize()
    await restarted.setCurrentUser(scope.memberId, scope.enterpriseId, names)
    assert.equal((await restarted.getTask(taskId))?.workDir, workspace)
    assert.equal((await restarted.getTask(taskId))?.status, invalidDelivery ? TaskStatus.FAILED : TaskStatus.COMPLETED)
  })
}
