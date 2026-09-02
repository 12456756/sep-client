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
 * 只在指定 subscriptionId 的第 N 次授权调用上挂起。
 * `executeTask` 与 `pump()` 各调一次 authorizeEmployee，靠序号就能精确停在 pump 里。
 */
function suspendOnNthAuthorization(subscriptionId: string, nth: number) {
  let seen = 0
  let release: (() => void) | null = null
  return {
    get suspended(): boolean { return release !== null },
    release: () => {
      const resume = release
      release = null
      resume?.()
    },
    authorize: async (id: string): Promise<EmployeeRuntimeConfig | null> => {
      if (id === subscriptionId && ++seen === nth) {
        await new Promise<void>(resolve => { release = resolve })
      }
      return EMPLOYEES[id] ?? null
    },
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
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')

    const shared = join(userData, 'shared-workspace')
    const holder = await manager.createTask('holder', 'a', shared, 'employee-a')
    const blocked = await manager.createTask('blocked', 'b', shared, 'employee-a')
    const victim = await manager.createTask('victim', 'c', join(userData, 'victim-workspace'), 'employee-v')

    const started: string[] = []
    const workers = makeWorkerFactory(started)
    // 第 1 次 employee-v 授权来自 executeTask，第 2 次来自 pump——停在后者。
    const gate = suspendOnNthAuthorization('employee-v', 2)
    const coordinator = new TaskExecutionCoordinator({
      taskManager: manager,
      taskRunStore: new TaskRunStore(userData),
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      resolveEmployee: id => EMPLOYEES[id] ?? null,
      authorizeEmployee: gate.authorize,
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

    // victim 入队排在 blocked 之后；pump 停在 victim 的授权挂起点（下标 1）。
    await coordinator.executeTask(victim.id)
    await waitFor(() => gate.suspended)

    // pump 挂起期间移除队首：修复前 splice(1) 打偏，victim 启动后仍留在队列里。
    await coordinator.cancelTask(blocked.id)
    gate.release()
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

    workers.releaseAll()
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
