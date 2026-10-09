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
import { ArrangementExecutor, buildArrangementNodePrompt } from './arrangement-executor'
import { silentTaskMonitor, type TaskMonitorPort, type MonitorTaskQueuedInput, type MonitorTaskContentInput } from '../domain/task-monitor'
import type { MonitorParticipation } from '../common/platform/client-monitor-contract'

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
    const arrangement = {
      ...plan(task.id),
      permissions: {
        ...plan(task.id).permissions,
        preset: 'full-local' as const,
        allowedTools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
        commandPolicy: 'confirm-each' as const,
      },
    }
    const checkpoints = new MemoryCheckpointStore()
    const events: TaskExecutionEvent[] = []
    const contexts: Array<Parameters<NonNullable<ConstructorParameters<typeof TaskRuntime>[0]['createWorker']>>[0]['context']> = []

    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: checkpoints,
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: event => events.push(event), onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      authorizeEmployee: async (subscriptionId, modelId) => {
        if (subscriptionId !== employee.subscriptionId) return null
        assert.ok(!modelId || arrangement.nodes.some(node => node.modelId === modelId))
        return { ...employee, modelId: modelId ?? employee.modelId }
      },
      createWorker: options => {
        contexts.push(options.context)
        const worker: TaskWorkerPort = {
          async run(prompt) {
            assert.match(prompt, /^你正在执行编排工作计划中的一个节点。/)
            assert.match(prompt, /没有可用的前置节点输出。/)
            assert.match(prompt, /节点执行指令：\ndo node A/)
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

    assert.deepEqual(contexts.map(context => context.modelId), ['node-model'])
    assert.equal(contexts[0]?.toolPolicy?.preset, 'full-local')
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
  it('loads each selected employee skills', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-employee-skills-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('employee skills', 'complete the work', undefined, employee.subscriptionId)
    const employeeSkills = new Map([
      [employee.subscriptionId, [join(userDataDir, 'skills', 'employee-a')]],
      ['employee-b', [join(userDataDir, 'skills', 'employee-b')]],
    ])
    const arrangement = twoNodePlan(task.id)
    arrangement.nodes = arrangement.nodes.map((node, index) => ({
      ...node,
      subscriptionId: index === 0 ? employee.subscriptionId : 'employee-b',
    }))
    const contexts: Array<Parameters<NonNullable<ConstructorParameters<typeof TaskRuntime>[0]['createWorker']>>[0]['context']> = []
    const authorizedSubscriptions: string[] = []
    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(arrangement),
      arrangementCheckpointStore: new MemoryCheckpointStore(),
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      authorizeEmployee: async subscriptionId => {
        authorizedSubscriptions.push(subscriptionId)
        const skillPaths = employeeSkills.get(subscriptionId)
        return skillPaths ? { ...employee, subscriptionId, additionalSkillPaths: [...skillPaths] } : null
      },
      createWorker: options => {
        contexts.push(options.context)
        return { async run() {}, async abort() {}, async dispose() {} }
      },
    })

    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)

    assert.deepEqual(contexts.map(context => context.subscriptionId), ['employee-a', 'employee-b'])
    for (const context of contexts) {
      assert.deepEqual(context.additionalSkillPaths, employeeSkills.get(context.subscriptionId))
    }
    assert.ok(authorizedSubscriptions.includes('employee-a'))
    assert.ok(authorizedSubscriptions.includes('employee-b'))
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
  monitor: TaskMonitorPort = silentTaskMonitor,
): TaskRuntime {
  return new TaskRuntime({
    taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: checkpoints,
    getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    resolveEmployee: id => arrangement.nodes.some(node => node.subscriptionId === id) ? { ...employee, subscriptionId: id } : null,
    authorizeEmployee: async (subscriptionId, modelId) => {
      if (!arrangement.nodes.some(node => node.subscriptionId === subscriptionId)) return null
      assert.ok(!modelId || arrangement.nodes.some(node => node.subscriptionId === subscriptionId && node.modelId === modelId))
      return { ...employee, subscriptionId, modelId: modelId ?? employee.modelId }
    },
    createWorker, monitor,
  })
}

function arrangementRetryApi(runtime: TaskRuntime): { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> } {
  return runtime as unknown as { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> }
}

describe('TaskRuntime arrangement controls', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  it('attributes exact dependency prompts, partial outputs and approvals to distinct node attempts under each parent run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-monitor-'))
    directories.push(root)
    const runStore = new TaskRunStore(root)
    const manager = new TaskManager(root, null, undefined, runStore)
    await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    arrangement.nodes[1].subscriptionId = 'employee-b'
    const queued: MonitorTaskQueuedInput[] = []
    const inputs: MonitorTaskContentInput[] = []
    const outputs: MonitorTaskContentInput[] = []
    const states: Array<{ event: TaskExecutionEvent; participation?: MonitorParticipation }> = []
    const prompts: string[] = []
    let attempts = 0
    const runtime = runtimeForArrangement(manager, runStore, new MemoryCheckpointStore(), arrangement, options => ({
      async run(prompt) {
        prompts.push(prompt)
        const nodeA = options.context.modelId === 'node-model-a'
        if (nodeA) attempts++
        const event = (type: TaskExecutionEvent['type'], data: unknown): TaskExecutionEvent => ({
          taskId: task.id, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 0, type, occurredAt: Date.now(), data,
        })
        await options.onEvent(event('approval_requested', null))
        await options.onEvent(event('approval_resolved', null))
        await options.onEvent(event('text_delta', { text: nodeA ? attempts === 1 ? 'partial A' : 'A recovered' : 'B complete' }))
        if (nodeA && attempts === 1) throw new Error('first attempt failed')
      }, async abort() {}, async dispose() {},
    }), { ...silentTaskMonitor,
      async taskQueued(input) { queued.push(input) },
      async taskInput(input) { inputs.push(input) },
      async taskOutput(input) { outputs.push(input) },
      async taskEvent(event, participation) { states.push({ event, participation }) },
    })
    await runtime.executeTask(task.id)
    await waitFor(() => outputs.some(output => output.content === 'partial A'))
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)
    await arrangementRetryApi(runtime).retryTask(task.id, { conversation: false, nodeId: 'node-a' })
    await waitFor(() => outputs.some(output => !output.participation && output.content.includes('B complete')))
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.equal(queued.length, 2)
    assert.ok(queued.every(input => input.protocolVersion === 2 && input.participation === undefined))
    assert.notEqual(queued[0].runId, queued[1].runId)
    const nodeInputs = inputs.filter(input => input.participation)
    const nodeOutputs = outputs.filter(output => output.participation)
    assert.deepEqual(nodeInputs.map(input => input.content), prompts)
    assert.deepEqual(nodeOutputs.map(output => output.content), ['partial A', 'A recovered', 'B complete'])
    assert.equal(new Set(nodeInputs.map(input => input.participation!.executionId)).size, 3)
    assert.deepEqual(nodeInputs.map(input => input.runId), [queued[0].runId, queued[1].runId, queued[1].runId])
    assert.deepEqual(nodeOutputs.map(output => output.participation!.status), ['FAILED', 'COMPLETED', 'COMPLETED'])
    assert.equal(nodeInputs[2].participation?.subscriptionId, 'employee-b')
    assert.equal(nodeInputs[2].content, buildArrangementNodePrompt(arrangement, arrangement.nodes[1], [{ node: arrangement.nodes[0], output: 'A recovered' }]))
    for (const output of nodeOutputs) {
      assert.ok(output.participation?.startedAt)
      assert.ok(output.participation?.completedAt)
      assert.ok(Date.parse(output.participation!.startedAt!) <= Date.parse(output.participation!.completedAt!))
      assert.equal(output.participation?.executionId, nodeInputs.find(input => input.participation?.executionId === output.participation?.executionId)?.participation?.executionId)
    }
    const approvals = states.filter(state => state.event.type.startsWith('approval_'))
    assert.equal(approvals.length, 6)
    assert.ok(approvals.every(state => state.participation && queued.some(input => input.runId === state.event.runId)))
    assert.deepEqual(approvals.map(state => state.participation?.status), ['WAITING_APPROVAL', 'RUNNING', 'WAITING_APPROVAL', 'RUNNING', 'WAITING_APPROVAL', 'RUNNING'])
    const nodeB = states.find(state => state.event.type === 'arrangement_node_started' && state.participation?.nodeId === 'node-b')!
    assert.equal(nodeB.event.subscriptionId, employee.subscriptionId)
    assert.equal((nodeB.event.data as { subscriptionId: string }).subscriptionId, 'employee-b')
  })

  it('keeps the parent arrangement waiting until all parallel node approvals resolve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-approval-aggregation-'))
    directories.push(root)
    const runStore = new TaskRunStore(root)
    const manager = new TaskManager(root, null, undefined, runStore)
    await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const base = twoNodePlan(task.id)
    const arrangement: WorkPlan = { ...base, nodes: base.nodes.map(node => ({ ...node, dependsOn: [] })) }
    const requested = new Set<string>()
    const resolved = new Set<string>()
    const releases = new Map<string, () => void>()
    const runtime = runtimeForArrangement(manager, runStore, new MemoryCheckpointStore(), arrangement, options => ({
      async run() {
        const nodeId = options.context.modelId === 'node-model-a' ? 'node-a' : 'node-b'
        const requestId = `approval-${nodeId}`
        await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 1, type: 'approval_requested', occurredAt: Date.now(), data: { requestId } })
        requested.add(nodeId)
        await new Promise<void>(resolve => releases.set(nodeId, resolve))
        await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 2, type: 'approval_resolved', occurredAt: Date.now(), data: { requestId, approved: true } })
        resolved.add(nodeId)
      },
      async abort() {}, async dispose() {},
    }))

    await runtime.executeTask(task.id)
    await waitFor(() => requested.size === 2 && releases.size === 2)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.WAITING_APPROVAL)

    releases.get('node-a')!()
    await waitFor(() => resolved.has('node-a'))
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.WAITING_APPROVAL)

    releases.get('node-b')!()
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual([...resolved].sort(), ['node-a', 'node-b'])
  })

  for (const outcome of ['denied', 'throws', 'aborted-before-start', 'aborted-after-output'] as const) {
    it(`records known ${outcome} node outcome without guessing a start time`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-outcome-'))
      directories.push(root)
      const manager = new TaskManager(root)
      const events: TaskExecutionEvent[] = []
      let workers = 0
      const executor = new ArrangementExecutor({
        scope: null, taskManager: manager, taskRunStore: null, checkpointStore: null,
        workspaceRoot: root, arrangementSubscriptionId: 'parent-sub',
        getRefreshToken: () => 'mock', onAuthenticationRequired() {}, async onApprovalRequest() { return true },
        async onEvent(event) { events.push(event) },
        async authorizeEmployee(subscriptionId, modelId) {
          assert.equal(subscriptionId, 'employee-a'); assert.equal(modelId, 'node-model')
          if (outcome === 'denied') return null
          if (outcome === 'throws') throw new Error('authorization failed')
          if (outcome === 'aborted-before-start') await executor.abort()
          return employee
        },
        createWorker: options => {
          workers++
          return { async run() {
            await options.onEvent({ taskId: 'task', runId: options.context.runId, subscriptionId: 'employee-a', sequence: 0,
              type: 'text_delta', occurredAt: Date.now(), data: { text: 'partial' } })
            await executor.abort()
          }, async abort() {}, async dispose() {} }
        },
      })
      await executor.execute(plan('task'), 'task', 'parent-run')
      const terminal = events.find(event => event.type === 'arrangement_node_failed')!
      const data = terminal.data as { status: string; startedAt?: string; completedAt: string; output: string | null; nodeRunId: string; subscriptionId: string }
      assert.ok(data.nodeRunId); assert.ok(Number.isFinite(Date.parse(data.completedAt)))
      assert.equal(data.subscriptionId, 'employee-a'); assert.equal(terminal.subscriptionId, 'parent-sub')
      assert.equal(terminal.runId, 'parent-run')
      assert.equal(data.status, outcome.startsWith('aborted') ? 'PAUSED' : 'FAILED')
      assert.equal(workers, outcome === 'aborted-after-output' ? 1 : 0)
      assert.equal(Boolean(data.startedAt), outcome === 'aborted-after-output')
      assert.equal(data.output, outcome === 'aborted-after-output' ? 'partial' : null)
      assert.ok(events.every(event => event.type !== 'arrangement_node_completed'))
    })
  }

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
          const nodeId = /当前节点：\n([^（]+)/.exec(prompt)?.[1]?.trim() ?? 'unknown'
          const attempt = (attempts.get(nodeId) ?? 0) + 1
          attempts.set(nodeId, attempt)
          if (nodeId === 'Node A') {
            if (attempt === 1) throw new Error('node-a failed')
            await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'A recovered' } })
            return
          }
          assert.match(prompt, /^你正在执行编排工作计划中的一个节点。/)
          assert.match(prompt, /前置节点输出：\n前置节点：Node A（node-a）\nA recovered/)
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
    const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, options => ({
      async run() {
        await options.onEvent({
          taskId: options.context.taskId,
          runId: options.context.runId,
          subscriptionId: options.context.subscriptionId,
          sequence: 1,
          type: 'tool_execution_start',
          occurredAt: Date.now(),
          data: { toolId: 'tool-1', toolName: 'write', input: { path: 'unfinished.txt' } },
        })
        await new Promise<void>(resolve => { release = resolve })
      },
      async abort() { release?.(); release = null },
      async dispose() {},
    }))

    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.RUNNING)
    await waitFor(() => ((runtime as unknown as { pendingFileTools: Map<string, unknown> }).pendingFileTools.size === 1))
    await runtime.stopArrangement(task.id, 'user stopped')
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.PAUSED)
    assert.equal(checkpoints.value?.state.status, 'stopped')
    assert.equal((runtime as unknown as { pendingFileTools: Map<string, unknown> }).pendingFileTools.size, 0)
    await assert.rejects(() => arrangementRetryApi(runtime).retryTask(task.id, { conversation: false, nodeId: 'node-a' }))
  })
})
