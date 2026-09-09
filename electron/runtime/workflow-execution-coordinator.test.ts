import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus, type TaskExecutionEvent } from '../../src/shared/types'
import { TaskManager } from './task-manager'
import { TaskExecutionCoordinator } from './task-execution-coordinator'
import { TaskRunStore } from '../data/task-run-store'
import type { WorkPlan } from '../domain/arrangement-plan'
import type { WorkflowCheckpointStorePort } from '../data/workflow-checkpoint-store'
import type { EmployeeRuntimeConfig, TaskWorkerPort } from './run-types'
import type { TaskOwnerScope } from '../data/scope-path'

const scope: TaskOwnerScope = { memberId: 'member-workflow', enterpriseId: 'enterprise-workflow' }
const employee: EmployeeRuntimeConfig = {
  subscriptionId: 'employee-a', modelId: 'primary-model', gatewayUrl: 'http://gateway.invalid',
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition.')
}

function plan(taskId: string): WorkPlan {
  return {
    id: taskId, schemaVersion: 1, sourceDraftId: 'draft-a', sourceDraftRevision: 1,
    owner: scope, mode: 'auto', title: 'Workflow', goal: 'complete the work', conversation: null,
    nodes: [{
      id: 'node-a', subscriptionId: employee.subscriptionId, modelId: 'node-model', title: 'Node A',
      instruction: 'do node A', expectedOutput: 'a result', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
    }],
    workspace: { mode: 'shared', path: null },
    permissions: {
      preset: 'workspace-edit', allowedTools: ['read', 'write'], allowedPaths: [], deniedPaths: [],
      requireApprovalFor: ['write'], commandPolicy: 'disabled', approvalMode: 'auto-approve',
    },
    confirmedInputs: [], planHash: 'plan-hash', createdAt: Date.now(),
  }
}

class MemoryPlanStore {
  constructor(private readonly value: WorkPlan) {}
  async get(): Promise<WorkPlan> { return structuredClone(this.value) }
  async save(): Promise<void> {}
}

class MemoryCheckpointStore implements WorkflowCheckpointStorePort {
  value: Awaited<ReturnType<WorkflowCheckpointStorePort['get']>> = null
  async save(_scope: TaskOwnerScope, checkpoint: NonNullable<Awaited<ReturnType<WorkflowCheckpointStorePort['get']>>>): Promise<void> { this.value = structuredClone(checkpoint) }
  async get(): Promise<Awaited<ReturnType<WorkflowCheckpointStorePort['get']>>> { return this.value ? structuredClone(this.value) : null }
}

describe('TaskExecutionCoordinator workflow integration', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  it('executes a saved orchestration plan with node model and persists parent workflow events', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-workflow-integration-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('workflow', 'ignored task prompt', undefined, employee.subscriptionId)
    const workflow = plan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    const events: TaskExecutionEvent[] = []
    const contexts: string[] = []

    const coordinator = new TaskExecutionCoordinator({
      taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(workflow), workflowCheckpointStore: checkpoints,
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: event => events.push(event), onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      createWorker: options => {
        contexts.push(options.context.modelId)
        const worker: TaskWorkerPort = {
          async run(prompt) {
            assert.match(prompt, /NODE INSTRUCTION:\ndo node A/)
            await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'node result' } })
          },
          async abort() {},
          async dispose() {},
        }
        return worker
      },
    })

    await coordinator.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)

    assert.deepEqual(contexts, ['node-model'])
    assert.ok(events.some(event => event.type === 'workflow_node_started'))
    assert.ok(events.some(event => event.type === 'workflow_node_completed'))
    const runs = await runStore.list(scope, task.id)
    assert.equal(runs.length, 2)
    const parent = runs.find(run => run.id === task.activeRunId) ?? runs.find(run => run.subscriptionId === employee.subscriptionId && run.modelId === employee.modelId)
    assert.ok(parent)
    const timeline = await runStore.events.getTimeline(scope, task.id, parent!.id)
    assert.ok(timeline.some(event => event.type === 'workflow_node_completed'))
    assert.equal(checkpoints.value?.state.status, 'completed')
  })
})



function twoNodePlan(taskId: string): WorkPlan {
  return {
    ...plan(taskId),
    nodes: [
      {
        id: 'node-a', subscriptionId: employee.subscriptionId, modelId: 'node-model-a', title: 'Node A',
        instruction: 'do node A', expectedOutput: 'a result', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
      },
      {
        id: 'node-b', subscriptionId: employee.subscriptionId, modelId: 'node-model-b', title: 'Node B',
        instruction: 'do node B', expectedOutput: 'b result', dependsOn: ['node-a'], skillIds: [], requiresUserConfirmation: false,
      },
    ],
  }
}

function coordinatorForWorkflow(
  manager: TaskManager,
  runStore: TaskRunStore,
  checkpoints: MemoryCheckpointStore,
  workflow: WorkPlan,
  createWorker: (options: Parameters<NonNullable<ConstructorParameters<typeof TaskExecutionCoordinator>[0]['createWorker']>>[0]) => TaskWorkerPort,
): TaskExecutionCoordinator {
  return new TaskExecutionCoordinator({
    taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(workflow), workflowCheckpointStore: checkpoints,
    getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    resolveEmployee: id => id === employee.subscriptionId ? employee : null,
    createWorker,
  })
}

function workflowRetryApi(coordinator: TaskExecutionCoordinator): { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> } {
  return coordinator as unknown as { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> }
}

describe('TaskExecutionCoordinator workflow controls', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  it('retries only the failed node and then schedules its dependents', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-workflow-retry-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('workflow', 'ignored', undefined, employee.subscriptionId)
    const workflow = twoNodePlan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    const attempts = new Map<string, number>()
    const executedModels: string[] = []
    const coordinator = coordinatorForWorkflow(manager, runStore, checkpoints, workflow, options => {
      executedModels.push(options.context.modelId)
      return {
        async run(prompt) {
          const nodeId = /CURRENT NODE:\n([^ ]+)/.exec(prompt)?.[1] ?? 'unknown'
          const attempt = (attempts.get(nodeId) ?? 0) + 1
          attempts.set(nodeId, attempt)
          if (nodeId === 'Node' || prompt.includes('Node A')) {
            if (attempt === 1) throw new Error('node-a failed')
            await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'A recovered' } })
            return
          }
          await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'B complete' } })
        },
        async abort() {},
        async dispose() {},
      }
    })

    await coordinator.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)
    assert.equal(checkpoints.value?.state.status, 'waiting-user')
    assert.equal(checkpoints.value?.state.nodes.find(node => node.nodeId === 'node-a')?.status, 'failed')
    assert.equal(checkpoints.value?.state.nodes.find(node => node.nodeId === 'node-b')?.status, 'blocked')

    await workflowRetryApi(coordinator).retryTask(task.id, { conversation: false, nodeId: 'node-a' })
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual(executedModels, ['node-model-a', 'node-model-a', 'node-model-b'])
    assert.equal(checkpoints.value?.state.status, 'completed')
    assert.ok(checkpoints.value?.state.nodes.every(node => node.status === 'completed'))
  })

  it('requires explicit resume for an interrupted workflow and does not rerun completed nodes', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-workflow-resume-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('workflow', 'ignored', undefined, employee.subscriptionId)
    const workflow = twoNodePlan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    let release: (() => void) | null = null
    let runCount = 0
    const coordinator = coordinatorForWorkflow(manager, runStore, checkpoints, workflow, options => ({
      async run() {
        runCount++
        if (runCount === 1) await new Promise<void>(resolve => { release = resolve })
        else await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'resumed' } })
      },
      async abort() { release?.(); release = null },
      async dispose() {},
    }))

    await coordinator.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.RUNNING)
    await coordinator.stopAll()
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.INTERRUPTED)
    assert.equal(checkpoints.value?.state.status, 'interrupted')

    await workflowRetryApi(coordinator).retryTask(task.id, { conversation: false })
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.equal(checkpoints.value?.state.status, 'completed')
  })

  it('stops an active workflow, persists stopped state, and rejects a later retry', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-workflow-stop-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('workflow', 'ignored', undefined, employee.subscriptionId)
    const workflow = plan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    let release: (() => void) | null = null
    const coordinator = coordinatorForWorkflow(manager, runStore, checkpoints, workflow, _options => ({
      async run() { await new Promise<void>(resolve => { release = resolve }) },
      async abort() { release?.(); release = null },
      async dispose() {},
    }))

    await coordinator.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.RUNNING)
    await coordinator.stopWorkflow(task.id, 'user stopped')
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.PAUSED)
    assert.equal(checkpoints.value?.state.status, 'stopped')
    await assert.rejects(() => workflowRetryApi(coordinator).retryTask(task.id, { conversation: false, nodeId: 'node-a' }))
  })
})
