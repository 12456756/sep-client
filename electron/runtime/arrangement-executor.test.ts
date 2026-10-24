import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { MediaHostTools, MediaRunPort } from '../domain/media-tools'
import type { VideoHostTools, VideoRunPort } from '../domain/video-tools'
import { DeliveryExecutionError } from '../domain/arrangement-delivery'

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
    owner: scope, mode: 'manual', title: 'Arrangement', goal: 'complete the work', conversation: null,
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
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))) })

  it('passes per-node prompts and media bindings and blocks downstream nodes until image delivery', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-'))
    directories.push(userDataDir)
    const manager = new TaskManager(userDataDir)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('media arrangement', 'work', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    const prepared: Array<Parameters<MediaRunPort['prepareRun']>[0]> = []
    const started: string[] = []
    let waiting = false
    let deliver!: () => void
    const delivery = new Promise<void>(resolve => { deliver = resolve })
    const host: MediaHostTools = { names: ['media_get_job'], execute: async () => null }
    const runtime = new TaskRuntime({
      taskManager: manager, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: new MemoryCheckpointStore(),
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
      resolveEmployee: () => employee,
      authorizeEmployee: async (subscriptionId, modelId) => ({ ...employee, subscriptionId, modelId: modelId ?? employee.modelId, systemPrompt: `Instructions for ${modelId}` }),
      media: {
        async prepareRun(input) { prepared.push(input); return host },
        async waitForRun(taskId, runId) { assert.equal(taskId, task.id); if (runId === prepared[0]?.runId) { waiting = true; await delivery } },
        async stopTask() { deliver() },
      },
      createWorker: options => {
        assert.equal(options.context.systemPrompt, `Instructions for ${options.context.modelId}`)
        assert.equal(options.context.mediaTools, host)
        return { async run() {
          started.push(options.context.modelId)
        }, async abort() {}, async dispose() {} }
      },
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => waiting)
      assert.deepEqual(started, ['node-model-a'])
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.RUNNING)
      assert.equal(prepared[0].toolPolicy?.preset, 'workspace-edit')
      deliver()
      await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
      assert.deepEqual(started, ['node-model-a', 'node-model-b'])
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.COMPLETED)
    } finally { deliver(); await runtime.stopAll() }
  })

  it('pauses an arrangement awaiting media and denies a pending node media approval', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-pause-'))
    directories.push(userDataDir)
    const manager = new TaskManager(userDataDir)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('media pause', 'work', undefined, employee.subscriptionId)
    const arrangement = plan(task.id)
    let prepared: Parameters<MediaRunPort['prepareRun']>[0] | undefined
    let waiting = false
    let deliver!: () => void
    const delivery = new Promise<void>(resolve => { deliver = resolve })
    const stopped: string[] = []
    let approvalRequested = false
    const runtime = new TaskRuntime({
      taskManager: manager, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: new MemoryCheckpointStore(),
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => { approvalRequested = true },
      resolveEmployee: () => employee, authorizeEmployee: async () => employee,
      media: { async prepareRun(input) { prepared = input; return undefined }, async waitForRun() { waiting = true; await delivery }, async stopTask(id) { stopped.push(id); deliver() } },
      createWorker: () => ({ async run() {}, async abort() {}, async dispose() {} }),
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => waiting)
      const approval = prepared!.requestApproval({ taskId: task.id, runId: prepared!.runId, subscriptionId: employee.subscriptionId, toolName: 'media_generate_image', input: { quote: { amount: '1', currency: 'credits' } } })
      await waitFor(() => approvalRequested)
      await runtime.pauseTask(task.id)
      assert.equal(await approval, false)
      assert.deepEqual(stopped, [task.id])
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.PAUSED)
    } finally { deliver(); await runtime.stopAll() }
  })

  it('passes per-node prompts and video bindings and blocks downstream nodes until video delivery', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-video-'))
    directories.push(userDataDir)
    const manager = new TaskManager(userDataDir)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('video arrangement', 'work', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    const prepared: Array<Parameters<VideoRunPort['prepareRun']>[0]> = []
    const started: string[] = []
    let waiting = false
    let deliver!: () => void
    const delivery = new Promise<void>(resolve => { deliver = resolve })
    const host: VideoHostTools = { names: ['video_get_job'], execute: async () => null }
    const runtime = new TaskRuntime({
      taskManager: manager, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: new MemoryCheckpointStore(),
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
      resolveEmployee: () => employee,
      authorizeEmployee: async (subscriptionId, modelId) => ({ ...employee, subscriptionId, modelId: modelId ?? employee.modelId, systemPrompt: `Instructions for ${modelId}` }),
      video: {
        async prepareRun(input) { prepared.push(input); return host },
        async waitForRun(taskId, runId) { assert.equal(taskId, task.id); if (runId === prepared[0]?.runId) { waiting = true; await delivery } },
        async stopTask() { deliver() },
      },
      createWorker: options => {
        assert.equal(options.context.systemPrompt, `Instructions for ${options.context.modelId}`)
        assert.equal(options.context.videoTools, host)
        return { async run() { started.push(options.context.modelId) }, async abort() {}, async dispose() {} }
      },
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => waiting)
      assert.deepEqual(started, ['node-model-a'])
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.RUNNING)
      assert.equal(prepared[0].toolPolicy?.preset, 'workspace-edit')
      deliver()
      await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
      assert.deepEqual(started, ['node-model-a', 'node-model-b'])
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.COMPLETED)
    } finally { deliver(); await runtime.stopAll() }
  })

  it('pauses an arrangement awaiting video and denies a pending node video approval', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-video-pause-'))
    directories.push(userDataDir)
    const manager = new TaskManager(userDataDir)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('video pause', 'work', undefined, employee.subscriptionId)
    const arrangement = plan(task.id)
    let prepared: Parameters<VideoRunPort['prepareRun']>[0] | undefined
    let waiting = false
    let deliver!: () => void
    const delivery = new Promise<void>(resolve => { deliver = resolve })
    const stopped: string[] = []
    let approvalRequested = false
    const runtime = new TaskRuntime({
      taskManager: manager, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: new MemoryCheckpointStore(),
      getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => { approvalRequested = true },
      resolveEmployee: () => employee, authorizeEmployee: async () => employee,
      video: { async prepareRun(input) { prepared = input; return undefined }, async waitForRun() { waiting = true; await delivery }, async stopTask(id) { stopped.push(id); deliver() } },
      createWorker: () => ({ async run() {}, async abort() {}, async dispose() {} }),
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => waiting)
      const approval = prepared!.requestApproval({ taskId: task.id, runId: prepared!.runId, subscriptionId: employee.subscriptionId, toolName: 'video_from_image', input: { quote: { amount: '1', currency: 'credits' } } })
      await waitFor(() => approvalRequested)
      await runtime.pauseTask(task.id)
      assert.equal(await approval, false)
      assert.deepEqual(stopped, [task.id])
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.PAUSED)
    } finally { deliver(); await runtime.stopAll() }
  })

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
  onEvent: (event: TaskExecutionEvent) => void = () => {},
  authorizeEmployee?: (subscriptionId: string, modelId?: string) => Promise<EmployeeRuntimeConfig | null>,
): TaskRuntime {
  return new TaskRuntime({
    taskManager: manager, taskRunStore: runStore, workPlanStore: new MemoryPlanStore(arrangement), arrangementCheckpointStore: checkpoints,
    getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent, onApprovalRequest: () => {},
    resolveEmployee: id => arrangement.nodes.some(node => node.subscriptionId === id) ? { ...employee, subscriptionId: id } : null,
    authorizeEmployee: authorizeEmployee ?? (async (subscriptionId, modelId) => {
      if (!arrangement.nodes.some(node => node.subscriptionId === subscriptionId)) return null
      assert.ok(!modelId || arrangement.nodes.some(node => node.subscriptionId === subscriptionId && node.modelId === modelId))
      return { ...employee, subscriptionId, modelId: modelId ?? employee.modelId }
    }),
    createWorker, monitor,
  })
}

function arrangementRetryApi(runtime: TaskRuntime): { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> } {
  return runtime as unknown as { retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string }): Promise<void> }
}

describe('TaskRuntime arrangement controls', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  it('does not prepare tool hosts after knowledge retrieval resolves for an aborted node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-search-abort-'))
    directories.push(root)
    const arrangement = plan('task')
    arrangement.nodes[0].knowledgeQuery = 'Internal policy'
    let prepared = 0
    let workers = 0
    const executor = new ArrangementExecutor({
      scope: null, taskManager: new TaskManager(root), taskRunStore: null, checkpointStore: null,
      workspaceRoot: root, arrangementSubscriptionId: employee.subscriptionId,
      getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, async onApprovalRequest() { return true },
      async onEvent() {}, async authorizeEmployee() { return employee },
      knowledgeSearch: async (_query, signal) => {
        await executor.abort()
        assert.equal(signal?.aborted, true)
        return { status: 'NO_MATCH', actualStrategy: 'hybrid', degraded: false, partial: false, durationMs: 1, results: [] }
      },
      media: { async prepareRun() { prepared++; return undefined }, async waitForRun() {}, async stopTask() {} },
      createWorker: () => {
        workers++
        return { async run() {}, async abort() {}, async dispose() {} }
      },
    })
    await executor.execute(arrangement, 'task', 'run')
    assert.equal(prepared, 0)
    assert.equal(workers, 0)
  })

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
    const approvals = states.filter(state => state.event.type.startsWith('approval_') && state.participation)
    assert.equal(approvals.length, 6)
    assert.ok(approvals.every(state => state.participation && queued.some(input => input.runId === state.event.runId)))
    assert.deepEqual(approvals.map(state => state.participation?.status), ['WAITING_APPROVAL', 'RUNNING', 'WAITING_APPROVAL', 'RUNNING', 'WAITING_APPROVAL', 'RUNNING'])
    const aggregateApprovals = states.filter(state => state.event.type.startsWith('approval_') && !state.participation)
    assert.equal(aggregateApprovals.length, 6)
    assert.ok(aggregateApprovals.every(state => queued.some(input => input.runId === state.event.runId)))
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

  it('reports only the aggregate parent approval transitions for parallel nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-approval-monitor-'))
    directories.push(root)
    const runStore = new TaskRunStore(root)
    const manager = new TaskManager(root, null, undefined, runStore)
    await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const base = twoNodePlan(task.id)
    const arrangement: WorkPlan = { ...base, nodes: base.nodes.map(node => ({ ...node, dependsOn: [] })) }
    const parentRunIds: string[] = []
    const monitorEvents: Array<{ event: TaskExecutionEvent; participation?: MonitorParticipation }> = []
    const releases = new Map<string, () => void>()
    const runtime = runtimeForArrangement(manager, runStore, new MemoryCheckpointStore(), arrangement, options => ({
      async run() {
        const nodeId = options.context.modelId === 'node-model-a' ? 'node-a' : 'node-b'
        const requestId = `approval-${nodeId}`
        await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 1, type: 'approval_requested', occurredAt: Date.now(), data: { requestId } })
        await new Promise<void>(resolve => releases.set(nodeId, resolve))
        await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 2, type: 'approval_resolved', occurredAt: Date.now(), data: { requestId, approved: true } })
      },
      async abort() {}, async dispose() {},
    }), { ...silentTaskMonitor,
      async taskEvent(event, participation) {
        monitorEvents.push({ event, participation })
        if (!participation && (event.type === 'approval_requested' || event.type === 'approval_resolved')) parentRunIds.push(event.runId)
      },
    })

    await runtime.executeTask(task.id)
    await waitFor(() => releases.size === 2)
    releases.get('node-a')!()
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.WAITING_APPROVAL)
    releases.get('node-b')!()
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)

    const aggregateApprovals = monitorEvents.filter(({ event, participation }) =>
      !participation && (event.type === 'approval_requested' || event.type === 'approval_resolved'))
    assert.deepEqual(aggregateApprovals.map(({ event }) => event.type), ['approval_requested', 'approval_resolved'])
    assert.equal(new Set(parentRunIds).size, 1)
    assert.ok(parentRunIds[0])
  })

  it('does not create node participation or content outbox inputs when authorization fails before start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-authorization-failure-'))
    directories.push(root)
    const runStore = new TaskRunStore(root)
    const manager = new TaskManager(root, null, undefined, runStore)
    await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = plan(task.id)
    const events: TaskExecutionEvent[] = []
    const monitorEvents: Array<{ event: TaskExecutionEvent; participation?: MonitorParticipation }> = []
    const inputs: MonitorTaskContentInput[] = []
    const outputs: MonitorTaskContentInput[] = []
    let workers = 0
    const runtime = runtimeForArrangement(manager, runStore, new MemoryCheckpointStore(), arrangement, () => {
      workers++
      return { async run() {}, async abort() {}, async dispose() {} }
    }, { ...silentTaskMonitor,
      async taskEvent(event, participation) { monitorEvents.push({ event, participation }) },
      async taskInput(input) { inputs.push(input) },
      async taskOutput(input) { outputs.push(input) },
    }, event => events.push(event), async (subscriptionId, modelId) => {
      if (modelId) return null
      return { ...employee, subscriptionId }
    })

    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)

    assert.ok(events.some(event => event.type === 'arrangement_node_failed'))
    assert.equal(workers, 0)
    assert.equal(monitorEvents.filter(({ participation }) => participation).length, 0)
    assert.equal(inputs.filter(input => input.participation).length, 0)
    assert.equal(outputs.filter(output => output.participation).length, 0)
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

  it('passes only the final successful answer to the dependent node after a streamed retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-final-output-'))
    directories.push(root)
    const arrangement = twoNodePlan('task')
    const prompts: string[] = []
    const executor = new ArrangementExecutor({
      scope: null, taskManager: new TaskManager(root), taskRunStore: null, checkpointStore: null,
      workspaceRoot: root, arrangementSubscriptionId: 'employee-a',
      getRefreshToken: () => 'mock', onAuthenticationRequired() {}, async onApprovalRequest() { return true },
      async onEvent() {}, async authorizeEmployee() { return employee },
      createWorker: options => ({ async run(prompt) {
        prompts.push(prompt)
        const emit = (type: TaskExecutionEvent['type'], data: unknown) => options.onEvent({ taskId: 'task',
          runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 0, occurredAt: Date.now(), type, data })
        if (options.context.modelId === 'node-model-a') {
          await emit('text_delta', { text: 'failed fragment' })
          await emit('turn_end', { message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'failed fragment' }] } })
          await emit('turn_start', {})
          await emit('text_delta', { text: 'checking files' })
          await emit('turn_end', { message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'checking files' }] } })
          await emit('turn_start', {})
          await emit('text_delta', { text: 'final answer' })
          await emit('turn_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final answer' }] } })
        }
      }, async abort() {}, async dispose() {} }),
    })
    const result = await executor.execute(arrangement, 'task', 'parent')
    assert.equal(result.status, 'completed')
    assert.equal(result.state.nodes[0]?.output, 'final answer')
    assert.match(prompts[1], /final answer/)
    assert.doesNotMatch(prompts[1], /failed fragment|checking files/)
  })

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

  it('retries parallel failures by task ID while preserving a completed node', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-parallel-retry-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    arrangement.nodes[1].dependsOn = []
    arrangement.nodes.push({ ...arrangement.nodes[0], id: 'done', modelId: 'done-model' })
    const checkpoints = new MemoryCheckpointStore()
    const attempts = new Map<string, number>()
    const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, options => ({
      async run() {
        const model = options.context.modelId
        const attempt = (attempts.get(model) ?? 0) + 1
        attempts.set(model, attempt)
        if (model !== 'done-model' && attempt === 1) throw new Error('429: Too Many Requests')
        await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: employee.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: model } })
      },
      async abort() {},
      async dispose() {},
    }))
    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)
    assert.equal(checkpoints.value?.state.status, 'waiting-user')
    assert.deepEqual(checkpoints.value?.state.failureNodeIds, ['node-a', 'node-b'])
    const failedCheckpoint = structuredClone(checkpoints.value)
    await assert.rejects(() => runtime.retryTask(task.id, { nodeId: 'done' }), { code: 'INVALID_STATE' })
    assert.deepEqual(checkpoints.value, failedCheckpoint)
    await runtime.retryTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual([...attempts].sort(), [['done-model', 1], ['node-model-a', 2], ['node-model-b', 2]])
    assert.equal(checkpoints.value?.state.nodes.find(item => item.nodeId === 'done')?.output, 'done-model')
  })

  it('keeps an unselected parallel failure retryable after a targeted retry succeeds', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-targeted-retry-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    arrangement.nodes[1].dependsOn = []
    const checkpoints = new MemoryCheckpointStore()
    const attempts = new Map<string, number>()
    const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, options => ({
      async run() {
        const model = options.context.modelId
        const attempt = (attempts.get(model) ?? 0) + 1
        attempts.set(model, attempt)
        if (attempt === 1) throw new Error('429: Too Many Requests')
      },
      async abort() {},
      async dispose() {},
    }))
    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)
    await runtime.retryTask(task.id, { nodeId: 'node-a' })
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)
    assert.equal(checkpoints.value?.state.status, 'waiting-user')
    assert.equal(checkpoints.value?.state.nodes.find(node => node.nodeId === 'node-a')?.status, 'completed')
    assert.equal(checkpoints.value?.state.nodes.find(node => node.nodeId === 'node-b')?.status, 'failed')
    assert.deepEqual(checkpoints.value?.state.failureNodeIds, ['node-b'])
    assert.deepEqual([...attempts].sort(), [['node-model-a', 2], ['node-model-b', 1]])
    await runtime.retryTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual([...attempts].sort(), [['node-model-a', 2], ['node-model-b', 2]])
  })

  it('retries a single failed node by task ID without rerunning its completed dependency', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-arrangement-task-retry-'))
    directories.push(userDataDir)
    const runStore = new TaskRunStore(userDataDir)
    const manager = new TaskManager(userDataDir, null, undefined, runStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('arrangement', 'ignored', undefined, employee.subscriptionId)
    const arrangement = twoNodePlan(task.id)
    const checkpoints = new MemoryCheckpointStore()
    const attempts = new Map<string, number>()
    const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, options => ({
      async run(prompt) {
        const model = options.context.modelId
        const attempt = (attempts.get(model) ?? 0) + 1
        attempts.set(model, attempt)
        if (model === 'node-model-b') {
          assert.match(prompt, /saved output/)
          if (attempt === 1) throw new Error('429: Too Many Requests')
        }
        await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: employee.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: 'saved output' } })
      },
      async abort() {},
      async dispose() {},
    }))
    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.PAUSED)
    await runtime.retryTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual([...attempts], [['node-model-a', 1], ['node-model-b', 2]])
  })

  for (const outcome of ['repaired', 'invalid'] as const) {
    it(`manually retries terminal delivery failure with its saved session (${outcome})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'sep-delivery-manual-retry-'))
      directories.push(root)
      const runStore = new TaskRunStore(root)
      const manager = new TaskManager(root, null, undefined, runStore)
      await manager.initialize()
      await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
      const task = await manager.createTask('arrangement', 'goal', undefined, employee.subscriptionId)
      const arrangement = twoNodePlan(task.id)
      arrangement.mode = 'auto'
      arrangement.workspace.path = root
      arrangement.nodes = arrangement.nodes.map(node => ({ ...node, objective: `Finish ${node.id}`,
        deliverables: [{ id: 'report', name: node.title, format: 'txt', path: `${node.id}.txt`,
          contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }],
      }))
      const checkpoints = new MemoryCheckpointStore()
      let sessionFile: string | undefined
      let failedNodeRuns = 0
      let completedNodeRuns = 0
      const runtime = runtimeForArrangement(manager, runStore, checkpoints, arrangement, options => ({
        async run(prompt) {
          const id = options.context.arrangementNodeId!
          if (id === 'node-a') completedNodeRuns++
          else {
            failedNodeRuns++
            if (failedNodeRuns === 1) {
              sessionFile = join(options.context.sessionDir, 'session.jsonl')
              await mkdir(options.context.sessionDir, { recursive: true })
              await writeFile(sessionFile, JSON.stringify({ type: 'session', id: 'logical-b' })+'\n')
              await options.onSessionCreated?.({ sessionId: 'logical-b', sessionFile })
            } else {
              assert.equal(options.context.resumeSessionFile, sessionFile)
              assert.match(prompt, /你的最终提交未通过校验[\s\S]*本次尚未检查实际文件/)
              const node = arrangement.nodes.find(item => item.id === id)!
              const system = options.context.fixedSystemPrompt!
              for (const value of [node.objective!, node.instruction, node.expectedOutput, JSON.stringify(node.deliverables, null, 2)]) {
                assert.ok(system.includes(value), `Resumed system must contain ${value}`)
              }
              assert.ok(system.includes(`当前节点：${node.title}（${id}）`))
              assert.match(prompt, /继续完成未完成的工作/)
              assert.match(system, /不得修改前置最终成果或指定快照/)
              assert.equal(checkpoints.value?.state.nodes[1]?.delivery?.validationAttempts, 0)
            }
          }
          for (let iteration = 1; iteration <= 7; iteration++) {
            await options.onModelRequest?.('execution')
            const valid = id === 'node-a' || (failedNodeRuns > 1 && outcome === 'repaired' && iteration === 2)
            if (valid) await writeFile(join(root, `${id}.txt`), 'Saved findings '+id)
            const correction = await options.onResponseSettled?.({ text: valid
              ? JSON.stringify({ nodeId: id, summary: `Done ${id}`, finalDeliverables: [{ id: 'report', path: `${id}.txt` }] })
              : '', stopReason: 'stop' })
            if (!correction) return
          }
          // Simulate an actual terminal storage failure, not a validation limit.
          throw new DeliveryExecutionError('Delivery storage is unavailable.')
        }, async abort() {}, async dispose() {},
      }))
      await runtime.executeTask(task.id)
      await waitFor(async () => {
        const current = await manager.getTask(task.id)
        return current?.status === TaskStatus.FAILED && !current.activeRunId
      })
      const original = structuredClone(checkpoints.value!)
      const savedSession = await readFile(sessionFile!, 'utf8')
      const originalRun = await runStore.get(scope, task.id, original.state.nodes[1]!.sessionRunId!)
      assert.equal(original.state.status, 'failed')
      assert.equal(original.state.nodes[1]?.delivery?.validationAttempts, 7)
      assert.equal(original.state.nodes[1]?.modelRequestProgress?.executionRounds, 7)
      await assert.rejects(runtime.retryTask(task.id, { nodeId: 'node-a' }), { code: 'INVALID_STATE' })
      assert.deepEqual(checkpoints.value, original)
      const admit = manager.admitTask.bind(manager)
      manager.admitTask = async () => { throw new Error('admission rejected') }
      await assert.rejects(runtime.retryTask(task.id), /admission rejected/)
      assert.deepEqual(checkpoints.value, original)
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.FAILED)
      manager.admitTask = admit
      await runtime.retryTask(task.id)
      await waitFor(async () => {
        const current = await manager.getTask(task.id)
        return current?.status === (outcome === 'repaired' ? TaskStatus.COMPLETED : TaskStatus.FAILED) && !current.activeRunId
      })
      assert.equal(completedNodeRuns, 1)
      assert.equal(failedNodeRuns, 2)
      assert.deepEqual(checkpoints.value?.state.nodes[0], original.state.nodes[0])
      assert.equal(checkpoints.value?.state.nodes[1]?.delivery?.validationAttempts, outcome === 'repaired' ? 2 : 7)
      assert.equal(checkpoints.value?.state.nodes[1]?.modelRequestProgress?.executionRounds, outcome === 'repaired' ? 9 : 14)
      assert.equal(await readFile(sessionFile!, 'utf8'), savedSession)
      assert.deepEqual(await runStore.get(scope, task.id, originalRun!.id), originalRun)
    })
  }

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
    await waitFor(async () => release !== null && (await manager.getTask(task.id))?.status === TaskStatus.RUNNING)
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
