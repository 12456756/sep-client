import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus, type TaskExecutionEvent } from '../../src/shared/types'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import { TaskRunStore } from '../data/task-run-store'
import type { WorkPlan } from '../domain/arrangement-plan'
import type { ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import type { EmployeeRuntimeConfig, TaskWorkerPort } from './run-types'
import type { TaskOwnerScope } from '../data/scope-path'

const scope: TaskOwnerScope = { memberId: 'member-arrangement', enterpriseId: 'enterprise-arrangement' }
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
    owner: scope, mode: 'auto', title: 'Arrangement', goal: 'complete the work', conversation: null,
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

class MemoryCheckpointStore implements ArrangementCheckpointStorePort {
  value: Awaited<ReturnType<ArrangementCheckpointStorePort['get']>> = null
  async save(_scope: TaskOwnerScope, checkpoint: NonNullable<Awaited<ReturnType<ArrangementCheckpointStorePort['get']>>>): Promise<void> { this.value = structuredClone(checkpoint) }
  async get(): Promise<Awaited<ReturnType<ArrangementCheckpointStorePort['get']>>> { return this.value ? structuredClone(this.value) : null }
}

describe('TaskRuntime arrangement integration', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  it('executes a saved arrangement plan with node model and persists parent arrangement events', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-integration-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored task prompt', undefined, employee.subscriptionId)
    const arrangement = plan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    const events: TaskExecutionEvent[] = []
    const contexts: string[] = []

    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: checkpoints,
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: event => events.push(event), onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      createWorker: options => {
        contexts.push(options.context.modelId)
        const worker: TaskWorkerPort = {
          async run(prompt) {
            assert.match(prompt, /^You are executing one node inside an orchestrated work plan\./)
            assert.match(prompt, /No prerequisite node output is available\./)
            assert.match(prompt, /NODE INSTRUCTION:\ndo node A/)
            await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'node result' } })
          },
          async abort() {},
          async dispose() {},
        }
        return worker
      },
    })

    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)

    assert.deepEqual(contexts, ['node-model'])
    assert.ok(events.some(event => event.type === 'arrangement_node_started'))
    assert.ok(events.some(event => event.type === 'arrangement_node_completed'))
    const runs = await runStore.list(scope, task.id)
    assert.equal(runs.length, 2)
    const parent = runs.find(run => run.id === task.activeRunId) ?? runs.find(run => run.subscriptionId === employee.subscriptionId && run.modelId === employee.modelId)
    assert.ok(parent)
    const timeline = await runStore.events.getTimeline(scope, task.id, parent!.id)
    assert.ok(timeline.some(event => event.type === 'arrangement_node_completed'))
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

function runtimeForArrangement(
  manager: TaskManager,
  runStore: TaskRunStore,
  checkpoints: MemoryCheckpointStore,
  arrangement: WorkPlan,
  createWorker: (options: Parameters<NonNullable<ConstructorParameters<typeof TaskRuntime>[0]['createWorker']>>[0]) => TaskWorkerPort,
): TaskRuntime {
  return new TaskRuntime({
    taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: checkpoints,
    getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    resolveEmployee: id => id === employee.subscriptionId ? employee : null,
    createWorker,
  })
}

function arrangementRetryApi(runtime: TaskRuntime): { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> } {
  return runtime as unknown as { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> }
}

describe('TaskRuntime arrangement controls', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  it('retries only the failed node and then schedules its dependents', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-retry-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    const attempts = new Map<string, number>()
    const executedModels: string[] = []
    const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, options => {
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
          assert.match(prompt, /^You are executing one node inside an orchestrated work plan\./)
          assert.match(prompt, /PREREQUISITE OUTPUTS:\nPREREQUISITE: Node A \(node-a\)\nA recovered/)
          await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'B complete' } })
        },
        async abort() {},
        async dispose() {},
      }
    })

    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)
    assert.equal(checkpoints.value?.state.status, 'waiting-user')
    assert.equal(checkpoints.value?.state.nodes.find(node => node.nodeId === 'node-a')?.status, 'failed')
    assert.equal(checkpoints.value?.state.nodes.find(node => node.nodeId === 'node-b')?.status, 'blocked')

    await arrangementRetryApi(runtime).retryTask(task.id, { conversation: false, nodeId: 'node-a' })
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual(executedModels, ['node-model-a', 'node-model-a', 'node-model-b'])
    assert.equal(checkpoints.value?.state.status, 'completed')
    assert.ok(checkpoints.value?.state.nodes.every(node => node.status === 'completed'))
  })

  it('requires explicit resume for an interrupted arrangement and does not rerun completed nodes', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-resume-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    let release: (() => void) | null = null
    let runCount = 0
    const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, options => ({
      async run() {
        runCount++
        if (runCount === 1) await new Promise<void>(resolve => { release = resolve })
        else await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'resumed' } })
      },
      async abort() { release?.(); release = null },
      async dispose() {},
    }))

    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.RUNNING)
    await runtime.stopAll()
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.INTERRUPTED)
    assert.equal(checkpoints.value?.state.status, 'interrupted')

    await arrangementRetryApi(runtime).retryTask(task.id, { conversation: false })
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.equal(checkpoints.value?.state.status, 'completed')
  })

  it('stops an active arrangement, persists stopped state, and rejects a later retry', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-stop-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = plan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    let release: (() => void) | null = null
    const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, _options => ({
      async run() { await new Promise<void>(resolve => { release = resolve }) },
      async abort() { release?.(); release = null },
      async dispose() {},
    }))

    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.RUNNING)
    await runtime.stopArrangement(task.id, 'user stopped')
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.PAUSED)
    assert.equal(checkpoints.value?.state.status, 'stopped')
    await assert.rejects(() => arrangementRetryApi(runtime).retryTask(task.id, { conversation: false, nodeId: 'node-a' }))
  })
})

