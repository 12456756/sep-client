/**
 * 并发不变式测试 — docs/architecture/后端结构重构实施方案.md 第 7 章 I1..I9
 *
 * 这些断言是**行为基准**：重构前后都必须通过。原行为基准文档已删除，
 * 此文件与该方案第 2、7 章共同承担基准职责。
 *
 * 覆盖范围说明：这里断言的是"今天已经成立"的性质。每个缺陷（C1..C9）触发条件下的
 * 回归测试属于 Phase 1，与缺陷修复同一提交落地，见各测试注释里的标注。
 */
import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus, type TaskExecutionEvent } from '../../src/shared/types'
import { ApprovalBroker } from './approval-runtime'
import { TaskExecutionCoordinator } from './task-execution-coordinator'
import type { EmployeeRuntimeConfig } from './run-contracts'
import { TaskManager } from './task-manager'
import { TaskRunStore } from '../data/task-run-store'
import { TaskStore, type TaskStorePort } from '../data/task-store'
import type { TaskOwnerScope } from '../data/scope-path'

const SCOPE: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const EMPLOYEE: EmployeeRuntimeConfig = {
  subscriptionId: 'employee-a',
  modelId: 'model-a',
  gatewayUrl: 'http://gateway.invalid',
}

const temporaryDirectories: string[] = []

async function makeUserDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-invariants-'))
  temporaryDirectories.push(directory)
  return directory
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the expected state.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

interface Harness {
  manager: TaskManager
  runStore: TaskRunStore
  coordinator: TaskExecutionCoordinator
  /** 每个 fake worker 启动时记录的 taskId，按启动顺序。 */
  started: string[]
  /** 已被 handleWorkerEvent 处理完的事件，按处理顺序。 */
  handled: TaskExecutionEvent[]
  /** 放行一个阻塞中的 worker.run()。 */
  releaseAll: () => void
  userData: string
}

interface HarnessOptions {
  /** fake worker 的 run 体；默认阻塞直到 releaseAll。 */
  run?: (
    context: { taskId: string; runId: string; subscriptionId: string },
    emit: (event: Omit<TaskExecutionEvent, 'subscriptionId'>) => Promise<void>,
    blockUntilReleased: () => Promise<void>,
  ) => Promise<void>
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const userData = await makeUserDataDir()
  const manager = new TaskManager(userData)
  await manager.initialize()
  await manager.setCurrentUser(SCOPE.memberId, SCOPE.enterpriseId)
  const runStore = new TaskRunStore(userData)
  const started: string[] = []
  const handled: TaskExecutionEvent[] = []
  const releases: Array<() => void> = []

  const coordinator = new TaskExecutionCoordinator({
    taskManager: manager,
    taskRunStore: runStore,
    getRefreshToken: () => 'refresh-token',
    onAuthenticationRequired: () => {},
    onEvent: event => { handled.push(event) },
    onApprovalRequest: () => {},
    resolveEmployee: id => id === EMPLOYEE.subscriptionId ? EMPLOYEE : null,
    createWorker: workerOptions => ({
      async run() {
        const { taskId, runId, subscriptionId } = workerOptions.context
        started.push(taskId)
        const emit = async (event: Omit<TaskExecutionEvent, 'subscriptionId'>) => {
          await workerOptions.onEvent({ ...event, subscriptionId } as TaskExecutionEvent)
        }
        const blockUntilReleased = () => new Promise<void>(resolve => releases.push(resolve))
        if (options.run) return options.run({ taskId, runId, subscriptionId }, emit, blockUntilReleased)
        await blockUntilReleased()
      },
      async abort() { releases.splice(0).forEach(resolve => resolve()) },
      async dispose() {},
    }),
  })

  return {
    manager, runStore, coordinator, started, handled, userData,
    releaseAll: () => releases.splice(0).forEach(resolve => resolve()),
  }
}

describe('I1 — 同一 taskId 最多一个 active run', () => {
  it('rejects a second admission while a run is already active', async () => {
    const harness = await makeHarness()
    const task = await harness.manager.createTask('one', 'prompt', undefined, EMPLOYEE.subscriptionId)

    await harness.coordinator.executeTask(task.id)
    await waitFor(() => harness.started.length === 1)

    await assert.rejects(() => harness.coordinator.executeTask(task.id))
    assert.equal(harness.started.length, 1)
    assert.equal((await harness.manager.getTask(task.id))?.activeRunId !== null, true)

    harness.releaseAll()
    await waitFor(async () => (await harness.manager.getTask(task.id))?.activeRunId === null)
  })
})

describe('I2 — 重叠工作目录不得同时被两个 run 持有', () => {
  it('serializes a parent workspace against its child workspace', async () => {
    const harness = await makeHarness()
    const parent = join(harness.userData, 'workspace')
    const child = join(parent, 'nested')
    const first = await harness.manager.createTask('parent', 'a', parent, EMPLOYEE.subscriptionId)
    const second = await harness.manager.createTask('child', 'b', child, EMPLOYEE.subscriptionId)

    await Promise.all([
      harness.coordinator.executeTask(first.id),
      harness.coordinator.executeTask(second.id),
    ])
    await waitFor(() => harness.started.length === 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(harness.started.length, 1, '父子目录的两个 run 同时启动了')

    harness.releaseAll()
    await waitFor(() => harness.started.length === 2)
    harness.releaseAll()
    await waitFor(async () =>
      (await harness.manager.getAllTasks()).every(task => task.activeRunId === null))
    assert.deepEqual(new Set(harness.started), new Set([first.id, second.id]))
  })
})

describe('I3 — 每个 run 的事件按 sequence 严格单调递增落盘', () => {
  it('assigns strictly increasing sequences to 50 concurrently appended events', async () => {
    const userData = await makeUserDataDir()
    const runStore = new TaskRunStore(userData)
    const taskId = 'task-seq'
    const runId = 'run-seq'
    await runStore.create(SCOPE, {
      taskId, runId,
      subscriptionId: EMPLOYEE.subscriptionId,
      modelId: EMPLOYEE.modelId,
      runtimeKey: `${EMPLOYEE.subscriptionId}:${EMPLOYEE.modelId}`,
      workspaceDir: userData,
      prompt: 'prompt',
    })

    await Promise.all(Array.from({ length: 50 }, (_unused, index) => runStore.events.appendEvent(SCOPE, {
      taskId, runId,
      subscriptionId: EMPLOYEE.subscriptionId,
      sequence: 0,
      type: 'text_delta',
      occurredAt: Date.now(),
      data: { text: `chunk-${index}` },
    })))

    const timeline = await runStore.events.getTimeline(SCOPE, taskId, runId)
    assert.equal(timeline.length, 50)
    const sequences = timeline.map(event => event.sequence)
    assert.deepEqual(sequences, Array.from({ length: 50 }, (_unused, index) => index + 1))
    assert.equal(new Set(sequences).size, 50, 'sequence 出现重复')
  })
})

describe('I4 — 同一 taskId 的事件处理严格串行', () => {
  it('handles a burst of events in emission order without interleaving', async () => {
    const order: string[] = []
    const harness = await makeHarness({
      run: async (context, emit) => {
        const bursts = Array.from({ length: 12 }, (_unused, index) => index + 1)
        // 不 await：全部同时投进 enqueueEvent，交由 eventChains 串行化。
        const pending = bursts.map(async index => {
          order.push(`emit-${index}`)
          await emit({
            taskId: context.taskId,
            runId: context.runId,
            sequence: 0,
            type: 'text_delta',
            occurredAt: Date.now(),
            data: { text: `chunk-${index}` },
          } as Omit<TaskExecutionEvent, 'subscriptionId'>)
        })
        await Promise.all(pending)
      },
    })
    const task = await harness.manager.createTask('burst', 'prompt', undefined, EMPLOYEE.subscriptionId)

    await harness.coordinator.executeTask(task.id)
    await waitFor(async () => (await harness.manager.getTask(task.id))?.activeRunId === null)

    const texts = harness.handled
      .filter(event => event.type === 'text_delta')
      .map(event => (event.data as { text: string }).text)
    assert.deepEqual(texts, Array.from({ length: 12 }, (_unused, index) => `chunk-${index + 1}`))
    const timeline = await harness.runStore.events.getTimeline(SCOPE, task.id, harness.handled[0]!.runId)
    assert.deepEqual(timeline.map(event => event.sequence), timeline.map((_unused, index) => index + 1))
  })
})

describe('I5 — 同一 scope 的任务快照写入严格串行', () => {
  it('never overlaps two save() calls and keeps every mutation', async () => {
    const userData = await makeUserDataDir()
    const inner = new TaskStore(userData)
    let inFlight = 0
    let maxInFlight = 0
    let saves = 0
    const serializing: TaskStorePort = {
      initialize: () => inner.initialize(),
      load: scope => inner.load(scope),
      async save(scope, tasks) {
        inFlight += 1
        saves += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        try {
          await inner.save(scope, tasks)
        } finally {
          inFlight -= 1
        }
      },
    }
    const manager = new TaskManager(userData, null, serializing)
    await manager.initialize()
    await manager.setCurrentUser(SCOPE.memberId, SCOPE.enterpriseId)
    const task = await manager.createTask('logs', 'prompt')

    await Promise.all(Array.from({ length: 20 }, (_unused, index) =>
      manager.addTaskLog(task.id, `entry-${index}`)))

    assert.equal(maxInFlight, 1, `save() 并发重叠，最大并发 ${maxInFlight}`)
    assert.ok(saves >= 21, `save() 调用次数异常：${saves}`)
    const logs = (await manager.getTask(task.id))?.logs ?? []
    assert.equal(logs.length, 20, '并发写入丢日志')
    assert.deepEqual(
      new Set(logs.map(log => log.message)),
      new Set(Array.from({ length: 20 }, (_unused, index) => `entry-${index}`)),
    )
  })
})

describe('I6 — activeRunId 非空 ⟺ run 在队列中或在 active 中', () => {
  it('clears activeRunId once the run settles', async () => {
    const harness = await makeHarness()
    const task = await harness.manager.createTask('lifecycle', 'prompt', undefined, EMPLOYEE.subscriptionId)

    assert.equal((await harness.manager.getTask(task.id))?.activeRunId, null)
    await harness.coordinator.executeTask(task.id)
    await waitFor(() => harness.started.length === 1)
    assert.notEqual((await harness.manager.getTask(task.id))?.activeRunId, null)

    harness.releaseAll()
    await waitFor(async () => (await harness.manager.getTask(task.id))?.activeRunId === null)
    assert.equal((await harness.manager.getTask(task.id))?.status, TaskStatus.COMPLETED)
  })

  it('clears activeRunId when a queued run is paused before it starts', async () => {
    const harness = await makeHarness()
    const workspace = join(harness.userData, 'shared')
    const blocker = await harness.manager.createTask('blocker', 'a', workspace, EMPLOYEE.subscriptionId)
    const queued = await harness.manager.createTask('queued', 'b', workspace, EMPLOYEE.subscriptionId)

    await harness.coordinator.executeTask(blocker.id)
    await waitFor(() => harness.started.length === 1)
    await harness.coordinator.executeTask(queued.id)
    assert.notEqual((await harness.manager.getTask(queued.id))?.activeRunId, null)

    await harness.coordinator.pauseTask(queued.id)
    const paused = await harness.manager.getTask(queued.id)
    assert.equal(paused?.activeRunId, null, '排队条目被移出队列后 activeRunId 仍非空')
    assert.equal(paused?.status, TaskStatus.PAUSED)

    harness.releaseAll()
    await waitFor(async () => (await harness.manager.getTask(blocker.id))?.activeRunId === null)
    assert.equal(harness.started.length, 1, '已暂停的排队条目仍被启动')
  })
})

describe('I7 — 停机时每个 in-flight 副作用工具都产出一条 SIDE_EFFECT_UNKNOWN', () => {
  it('records SIDE_EFFECT_UNKNOWN for each unfinished side-effect tool on stopAll', async () => {
    const harness = await makeHarness({
      run: async (context, emit, blockUntilReleased) => {
        for (const [toolId, toolName] of [['tool-1', 'write'], ['tool-2', 'bash']] as const) {
          await emit({
            taskId: context.taskId,
            runId: context.runId,
            sequence: 0,
            type: 'tool_execution_start',
            occurredAt: Date.now(),
            data: { toolId, toolName },
          } as Omit<TaskExecutionEvent, 'subscriptionId'>)
        }
        await blockUntilReleased()
      },
    })
    const task = await harness.manager.createTask('shutdown', 'prompt', undefined, EMPLOYEE.subscriptionId)

    await harness.coordinator.executeTask(task.id)
    await waitFor(async () => (await harness.manager.getTask(task.id))?.status === TaskStatus.RUNNING)
    await waitFor(() => harness.handled.filter(event => event.type === 'tool_execution_start').length === 2)

    await harness.coordinator.stopAll()

    const runs = await harness.runStore.list(SCOPE, task.id)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.outcome, 'interrupted')
    const timeline = await harness.runStore.events.getTimeline(SCOPE, task.id, runs[0]!.id)
    const unknown = timeline.filter(event => event.type === 'SIDE_EFFECT_UNKNOWN')
    assert.equal(unknown.length, 2, '未为每个 in-flight 副作用工具产出 SIDE_EFFECT_UNKNOWN')
    assert.deepEqual(
      new Set(unknown.map(event => (event.data as { toolId: string }).toolId)),
      new Set(['tool-1', 'tool-2']),
    )
  })
})

describe('I8 — 审批超时后自动拒绝，且拒绝后不可被追认', () => {
  it('auto-denies on timeout and refuses a late approval for the same requestId', async () => {
    const delivered: string[] = []
    const resolutions: Array<{ requestId: string; approved: boolean; reason: string }> = []
    const broker = new ApprovalBroker({
      timeoutMs: 30,
      onRequest: request => { delivered.push(request.requestId) },
      onResolved: (request, approved, reason) =>
        resolutions.push({ requestId: request.requestId, approved, reason }),
    })

    const decision = broker.request({
      taskId: 'task-a', runId: 'run-a', subscriptionId: EMPLOYEE.subscriptionId,
      toolName: 'bash', input: {},
    })

    assert.equal(await decision, false, '超时未自动拒绝')
    await waitFor(() => resolutions.length === 1)
    assert.deepEqual(resolutions[0], { requestId: delivered[0]!, approved: false, reason: 'timeout' })
    assert.equal(broker.size, 0)
    assert.equal(
      broker.respond({ requestId: delivered[0]!, approved: true }),
      false,
      '超时拒绝后仍可被追认',
    )
    assert.equal(resolutions.length, 1, '追认产生了第二次结果')
  })
})

describe('I9 — run 的终态只写一次', () => {
  it('accepts the first terminal transition and rejects every later one', async () => {
    const userData = await makeUserDataDir()
    const runStore = new TaskRunStore(userData)
    const taskId = 'task-terminal'
    const runId = 'run-terminal'
    await runStore.create(SCOPE, {
      taskId, runId,
      subscriptionId: EMPLOYEE.subscriptionId,
      modelId: EMPLOYEE.modelId,
      runtimeKey: `${EMPLOYEE.subscriptionId}:${EMPLOYEE.modelId}`,
      workspaceDir: userData,
      prompt: 'prompt',
    })

    assert.equal(await runStore.finish(SCOPE, taskId, runId, 'completed'), true)
    assert.equal(await runStore.finish(SCOPE, taskId, runId, 'failed', 'late failure'), false)
    assert.equal(await runStore.finish(SCOPE, taskId, runId, 'cancelled'), false)

    const record = await runStore.get(SCOPE, taskId, runId)
    assert.equal(record?.outcome, 'completed')
    assert.equal(record?.error, null)
    assert.notEqual(record?.endedAt, null)
  })

  it('keeps the first outcome when concurrent settles race', async () => {
    const userData = await makeUserDataDir()
    const runStore = new TaskRunStore(userData)
    const taskId = 'task-race'
    const runId = 'run-race'
    await runStore.create(SCOPE, {
      taskId, runId,
      subscriptionId: EMPLOYEE.subscriptionId,
      modelId: EMPLOYEE.modelId,
      runtimeKey: `${EMPLOYEE.subscriptionId}:${EMPLOYEE.modelId}`,
      workspaceDir: userData,
      prompt: 'prompt',
    })

    const outcomes = await Promise.all([
      runStore.finish(SCOPE, taskId, runId, 'completed'),
      runStore.finish(SCOPE, taskId, runId, 'failed', 'boom'),
      runStore.finish(SCOPE, taskId, runId, 'cancelled'),
    ])
    assert.equal(outcomes.filter(Boolean).length, 1, '终态被写入多次')
    const record = await runStore.get(SCOPE, taskId, runId)
    assert.ok(['completed', 'failed', 'cancelled'].includes(record?.outcome ?? ''))
  })
})
