/**
 * 缺陷回归测试 — docs/architecture/后端结构重构实施方案.md 第 2 章 C1..C9
 *
 * 每个用例都是"修复前必红、修复后必绿"的复现，用例名带缺陷编号。
 * 不变式基准在 concurrency-invariants.test.ts；这里只放触发缺陷的具体时序。
 */
import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus } from '../../src/shared/types'
import { TaskExecutionCoordinator, type EmployeeRuntimeConfig } from './task-execution-coordinator'
import { TaskManager } from './task-manager'
import { TaskRunStore } from './task-run-store'
import type { TaskOwnerScope } from './task-store'

const SCOPE: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

const GATEWAY = 'http://gateway.invalid'
const EMPLOYEES: Record<string, EmployeeRuntimeConfig> = {
  'employee-a': { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: GATEWAY },
  'employee-v': { subscriptionId: 'employee-v', modelId: 'model-v', gatewayUrl: GATEWAY },
}

const temporaryDirectories: string[] = []

async function makeUserDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-defects-'))
  temporaryDirectories.push(directory)
  return directory
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the expected state.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * 在 pump() 内部的 getTask 调用上挂起。
 *
 * C4 之后 pump() 里已经没有网络调用，唯一还能停住它的挂起点就是 getTask。按调用
 * 次数计数会随实现漂移（executeTask / admitTask / updateTaskStatus 都会调 getTask），
 * 所以直接认调用栈：只在调用方是 pump 时挂起。精确，且不会因为别处多调一次就失效。
 */
class GatedTaskManager extends TaskManager {
  private targetTaskId: string | null = null
  private resume: (() => void) | null = null

  suspendPumpOn(taskId: string): void {
    this.targetTaskId = taskId
  }

  get suspended(): boolean {
    return this.resume !== null
  }

  release(): void {
    const resume = this.resume
    this.resume = null
    resume?.()
  }

  override async getTask(taskId: string): ReturnType<TaskManager['getTask']> {
    if (taskId === this.targetTaskId && new Error().stack?.includes('.pump')) {
      this.targetTaskId = null
      await new Promise<void>(resolve => { this.resume = resolve })
    }
    return super.getTask(taskId)
  }
}

/** 每个 taskId 一个放行钩子，便于只结束其中一个 run。 */
function makeWorkerFactory(started: string[]) {
  const releases = new Map<string, Array<() => void>>()
  return {
    releaseTask: (taskId: string) => {
      (releases.get(taskId) ?? []).splice(0).forEach(resolve => resolve())
    },
    releaseAll: () => {
      for (const hooks of releases.values()) hooks.splice(0).forEach(resolve => resolve())
    },
    create: (taskId: string) => async () => {
      started.push(taskId)
      await new Promise<void>(resolve => {
        const hooks = releases.get(taskId) ?? []
        hooks.push(resolve)
        releases.set(taskId, hooks)
      })
    },
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

describe('C1 — pump() 按下标 splice 队列会误删无关条目', () => {
  it('starts a queued run exactly once when an earlier queue entry is cancelled mid-pump', async () => {
    const userData = await makeUserDataDir()
    const manager = new GatedTaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')

    const shared = join(userData, 'shared-workspace')
    const holder = await manager.createTask('holder', 'a', shared, 'employee-a')
    const blocked = await manager.createTask('blocked', 'b', shared, 'employee-a')
    const victim = await manager.createTask('victim', 'c', join(userData, 'victim-workspace'), 'employee-v')

    const started: string[] = []
    const workers = makeWorkerFactory(started)
    const coordinator = new TaskExecutionCoordinator({
      taskManager: manager,
      taskRunStore: new TaskRunStore(userData),
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      resolveEmployee: id => EMPLOYEES[id] ?? null,
      createWorker: options => ({
        run: workers.create(options.context.taskId),
        async abort() { workers.releaseTask(options.context.taskId) },
        async dispose() {},
      }),
    })

    // holder 占住 shared-workspace 并阻塞。
    await coordinator.executeTask(holder.id)
    await waitFor(() => started.length === 1)

    // blocked 入队后因锁冲突留在队首。
    await coordinator.executeTask(blocked.id)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(started.length, 1, 'blocked 不该拿到锁')

    // victim 入队排在 blocked 之后；pump 停在 victim 的 getTask 上（下标 1）。
    manager.suspendPumpOn(victim.id)
    try {
      await coordinator.executeTask(victim.id)
      await waitFor(() => manager.suspended, 2_000)

      // pump 挂起期间移除队首：修复前 splice(1) 打偏，victim 启动后仍留在队列里。
      await coordinator.cancelTask(blocked.id)
      manager.release()
      await waitFor(() => started.includes(victim.id))

      // 只结束 holder，触发下一轮 pump。若 victim 仍在队列里，它会被二次启动
      // ——WorkspaceLockManager.acquire 对同一 runId 不判冲突，拦不住。
      workers.releaseTask(holder.id)
      await waitFor(async () => (await manager.getTask(holder.id))?.activeRunId === null)
      await new Promise(resolve => setTimeout(resolve, 120))

      const victimStarts = started.filter(id => id === victim.id).length
      assert.equal(victimStarts, 1, `victim 被启动 ${victimStarts} 次，队列条目寻址打偏`)

      const cancelled = await manager.getTask(blocked.id)
      assert.equal(cancelled?.status, TaskStatus.PENDING)
      assert.equal(cancelled?.activeRunId, null)
    } finally {
      manager.release()
      workers.releaseAll()
    }
    await waitFor(async () => (await manager.getAllTasks()).every(task => task.activeRunId === null))
  })
})

describe('C2 — 锁获取与 try/finally 之间的裸露区会永久泄漏工作区锁', () => {
  it('releases the workspace lock when createWorker throws during setup', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')

    const shared = join(userData, 'shared-workspace')
    const doomed = await manager.createTask('doomed', 'a', shared, 'employee-a')
    const followUp = await manager.createTask('follow-up', 'b', shared, 'employee-a')

    const started: string[] = []
    const workers = makeWorkerFactory(started)
    let failNext = true
    const coordinator = new TaskExecutionCoordinator({
      taskManager: manager,
      taskRunStore: new TaskRunStore(userData),
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      resolveEmployee: id => EMPLOYEES[id] ?? null,
      createWorker: options => {
        if (failNext) {
          failNext = false
          throw new Error('worker construction failed')
        }
        return {
          run: workers.create(options.context.taskId),
          async abort() { workers.releaseTask(options.context.taskId) },
          async dispose() {},
        }
      },
    })

    await coordinator.executeTask(doomed.id)
    await waitFor(async () => (await manager.getTask(doomed.id))?.activeRunId === null)
    assert.equal(started.length, 0, 'worker 构造失败，不该有 run 启动')
    assert.equal((await manager.getTask(doomed.id))?.status, TaskStatus.FAILED)

    // 修复前 releaseWorkspace 从未被调用，shared-workspace 被永久锁死，
    // 落在同一目录的后续任务会静默滞留队列。
    await coordinator.executeTask(followUp.id)
    await waitFor(() => started.includes(followUp.id), 2_000)

    workers.releaseAll()
    await waitFor(async () => (await manager.getTask(followUp.id))?.status === TaskStatus.COMPLETED)
  })
})

describe('C4 — authorizeEmployee 在调度循环内发网络请求', () => {
  it('authorizes once per run at enqueue time and never inside pump', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')

    const shared = join(userData, 'shared-workspace')
    const holder = await manager.createTask('holder', 'a', shared, 'employee-a')
    const queued = await manager.createTask('queued', 'b', shared, 'employee-a')

    const authorizations: string[] = []
    const skillPaths = [join(userData, 'runtime', 'skills', 'demo')]
    const contexts: Array<{ taskId: string; additionalSkillPaths?: string[] }> = []
    const started: string[] = []
    const workers = makeWorkerFactory(started)
    const coordinator = new TaskExecutionCoordinator({
      taskManager: manager,
      taskRunStore: new TaskRunStore(userData),
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      // 同步快照不带 additionalSkillPaths，正如 main.ts 里的 resolveEmployee。
      resolveEmployee: id => EMPLOYEES[id] ?? null,
      // 只有授权（含平台往返）才知道技能包路径。
      authorizeEmployee: async id => {
        authorizations.push(id)
        const employee = EMPLOYEES[id]
        return employee ? { ...employee, additionalSkillPaths: skillPaths } : null
      },
      createWorker: options => {
        contexts.push({
          taskId: options.context.taskId,
          additionalSkillPaths: options.context.additionalSkillPaths,
        })
        return {
          run: workers.create(options.context.taskId),
          async abort() { workers.releaseTask(options.context.taskId) },
          async dispose() {},
        }
      },
    })

    await coordinator.executeTask(holder.id)
    await waitFor(() => started.length === 1)
    // queued 会因锁冲突被 pump 反复看到；修复前每一轮都要打一次平台。
    await coordinator.executeTask(queued.id)
    await new Promise(resolve => setTimeout(resolve, 60))
    workers.releaseTask(holder.id)
    await waitFor(() => started.includes(queued.id))
    workers.releaseAll()
    await waitFor(async () => (await manager.getAllTasks()).every(task => task.activeRunId === null))

    assert.deepEqual(
      authorizations,
      ['employee-a', 'employee-a'],
      `每个 run 只应授权一次，实际 ${authorizations.length} 次`,
    )
    // 入队前授权拿到的配置必须随条目走到 worker，否则技能包路径在排队后就丢了。
    assert.equal(contexts.length, 2)
    for (const context of contexts) {
      assert.deepEqual(context.additionalSkillPaths, skillPaths, `${context.taskId} 丢了技能包路径`)
    }
  })
})

describe('C6 — 事件序号分配是 O(n^2) 文件读，且失败被静默吞掉', () => {
  const RUN = { taskId: 'task-seq', runId: 'run-seq', subscriptionId: 'employee-a' }

  async function seedRun(userData: string, store: TaskRunStore): Promise<void> {
    await store.create(SCOPE, {
      ...RUN,
      modelId: 'model-a',
      runtimeKey: 'employee-a:model-a',
      workspaceDir: userData,
      prompt: 'prompt',
    })
  }

  function delta(text: string) {
    return { ...RUN, sequence: 0, type: 'text_delta' as const, occurredAt: Date.now(), data: { text } }
  }

  it('continues the sequence after a restart instead of restarting from 1', async () => {
    const userData = await makeUserDataDir()
    const first = new TaskRunStore(userData)
    await seedRun(userData, first)
    for (let index = 0; index < 5; index += 1) await first.appendEvent(SCOPE, delta(`a-${index}`))

    // 新实例 = 进程重启后续写。游标必须从文件尾部重建，否则序号会从 1 重来并撞号。
    const second = new TaskRunStore(userData)
    assert.equal((await second.appendEvent(SCOPE, delta('b-0'))).sequence, 6)

    const timeline = await second.getTimeline(SCOPE, RUN.taskId, RUN.runId)
    assert.deepEqual(timeline.map(event => event.sequence), [1, 2, 3, 4, 5, 6])
  })

  it('recovers the highest sequence from a file larger than the tail budget', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskRunStore(userData)
    await seedRun(userData, store)
    // 每条约 30KB，三条就超过 64KB 的尾部预算，回读时开头的半行会被切掉。
    for (let index = 0; index < 3; index += 1) await store.appendEvent(SCOPE, delta('x'.repeat(30_000)))

    const restarted = new TaskRunStore(userData)
    assert.equal((await restarted.appendEvent(SCOPE, delta('after'))).sequence, 4, '尾部回读没拿到最大序号')
  })

  it('reports a failed event append instead of leaving an unhandled rejection', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const task = await manager.createTask('doomed', 'prompt', undefined, 'employee-a')

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const coordinator = new TaskExecutionCoordinator({
        taskManager: manager,
        taskRunStore: new TaskRunStore(userData),
        getRefreshToken: () => 'refresh-token',
        onAuthenticationRequired: () => {},
        onEvent: () => {},
        onApprovalRequest: () => {},
        resolveEmployee: id => EMPLOYEES[id] ?? null,
        createWorker: options => ({
          async run() {
            // subscriptionId 与持久化的 run 不符 -> appendEvent 抛 TaskScopeError。
            await options.onEvent({
              taskId: options.context.taskId,
              runId: options.context.runId,
              subscriptionId: 'employee-imposter',
              sequence: 0,
              type: 'text_delta',
              occurredAt: Date.now(),
              data: { text: 'nope' },
            })
          },
          async abort() {},
          async dispose() {},
        }),
      })

      await coordinator.executeTask(task.id)
      await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
      await new Promise(resolve => setTimeout(resolve, 80))

      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.FAILED)
      assert.deepEqual(unhandled, [], '事件落盘失败变成了未处理拒绝')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
