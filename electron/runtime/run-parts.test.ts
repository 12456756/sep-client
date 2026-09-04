import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolApprovals } from './run-approvals'
import { WorkspaceLockManager } from './workspace-lock-manager'
import { RunQueue } from './run-queue'
import { createRunCompletion, WorkerRegistry } from './run-workers'
import { EventPipeline } from './run-events'
import type { ActiveRun, QueuedRun } from './run-types'
import type { TaskExecutionEvent } from '../../src/shared/types'

function queued(runId: string, taskId = `task-of-${runId}`): QueuedRun {
  return {
    taskId,
    runId,
    subscriptionId: 'employee-a',
    employee: { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: 'http://gateway' },
    prompt: 'hello',
    conversation: false,
  }
}

function activeRun(taskId: string, runId: string): ActiveRun {
  return {
    taskId,
    runId,
    subscriptionId: 'employee-a',
    releaseWorkspace: () => {},
    worker: { run: async () => {}, abort: async () => {}, dispose: async () => {} },
    control: 'none',
    completion: Promise.resolve(),
  }
}

function event(taskId: string, runId: string, type: string): TaskExecutionEvent {
  return { taskId, runId, subscriptionId: 'employee-a', sequence: 0, type, occurredAt: 1, data: null } as TaskExecutionEvent
}

const temporaryDirectories: string[] = []

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-coordinator-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('WorkspaceLockManager', () => {
  it('blocks equal and ancestor paths but permits disjoint paths', async () => {
    const root = await makeDirectory()
    const lockManager = new WorkspaceLockManager(root)
    const first = lockManager.acquire('run-a', root)
    assert.ok(first)
    assert.equal(lockManager.acquire('run-b', join(root, 'child')), null)
    assert.ok(lockManager.acquire('run-c', join(root, '..', 'different')))
    first?.()
    assert.ok(lockManager.acquire('run-b', join(root, 'child')))
  })

  it('normalizes Windows-style case variations', async () => {
    const root = await makeDirectory()
    const lockManager = new WorkspaceLockManager(root)
    const first = lockManager.acquire('run-a', root.toUpperCase())
    assert.ok(first)
    assert.equal(lockManager.acquire('run-b', root.toLowerCase()), null)
  })

  it('normalizes symlink aliases when present', async () => {
    const root = await makeDirectory()
    const real = join(root, 'real')
    const alias = join(root, 'alias')
    await mkdir(real)
    try {
      await symlink(real, alias, 'junction')
    } catch {
      return
    }
    const lockManager = new WorkspaceLockManager(root)
    assert.ok(lockManager.acquire('run-a', real))
    assert.equal(lockManager.acquire('run-b', alias), null)
  })
})

describe('ToolApprovals', () => {
  it('routes concurrent approvals by request ID', async () => {
    const requests: string[] = []
    const broker = new ToolApprovals({
      onRequest: request => requests.push(request.requestId),
      timeoutMs: 1_000,
    })
    const first = broker.request({ taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', toolName: 'write', input: {} })
    const second = broker.request({ taskId: 'task-b', runId: 'run-b', subscriptionId: 'employee-b', toolName: 'bash', input: {} })

    assert.equal(broker.respond({ requestId: requests[1], approved: false }), true)
    assert.equal(broker.respond({ requestId: requests[0], approved: true }), true)
    assert.equal(await first, true)
    assert.equal(await second, false)
    assert.equal(broker.size, 0)
  })

  it('denies timed out and cancelled approvals', async () => {
    const broker = new ToolApprovals({ onRequest: () => {}, timeoutMs: 5 })
    const timed = broker.request({ taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', toolName: 'write', input: {} })
    assert.equal(await timed, false)

    const pending = broker.request({ taskId: 'task-b', runId: 'run-b', subscriptionId: 'employee-b', toolName: 'edit', input: {} })
    broker.denyRun('run-b')
    assert.equal(await pending, false)
  })

  // C5：原来这里断言的是"只有一个 pending 时可以省略 requestId"。那个回退能批准错的
  // 调用——A 超时被自动拒绝后 B 进入 pending，用户点的是 A 的批准按钮，被批准的是 B。
  it('refuses a response without a requestId even when exactly one request is pending', async () => {
    const broker = new ToolApprovals({ onRequest: () => {}, timeoutMs: 1_000 })
    const only = broker.request({ taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', toolName: 'write', input: {} })

    assert.equal(broker.respond({ requestId: '', approved: true }), false)
    assert.equal(broker.size, 1, '缺 requestId 的响应不该消耗掉 pending 请求')

    broker.denyAll()
    assert.equal(await only, false)
  })

  it('refuses a response whose requestId is no longer pending', async () => {
    const delivered: string[] = []
    const broker = new ToolApprovals({
      onRequest: request => { delivered.push(request.requestId) },
      timeoutMs: 5,
    })
    const timedOut = broker.request({ taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', toolName: 'write', input: {} })
    assert.equal(await timedOut, false)

    // A 已超时拒绝，B 现在是唯一 pending。用户此刻点的是 A 的按钮。
    const next = broker.request({ taskId: 'task-b', runId: 'run-b', subscriptionId: 'employee-b', toolName: 'bash', input: {} })
    assert.equal(broker.respond({ requestId: delivered[0]!, approved: true }), false, 'A 的批准不得落到 B 上')
    assert.equal(broker.size, 1)

    broker.denyAll()
    assert.equal(await next, false, 'bash 未经用户批准就被放行')
  })
})

// C1：队列只能按 runId 寻址。这些用例断言的是"写不出按下标的 bug"，
// 而不只是"当前实现正确"。
describe('RunQueue', () => {
  it('takes by runId, and reports whether this call is the one that took it', () => {
    const queue = new RunQueue()
    queue.push(queued('run-a'))
    queue.push(queued('run-b'))

    assert.equal(queue.take('run-a'), true)
    assert.equal(queue.take('run-a'), false, '第二次 take 必须返回 false，否则同一 run 会被启动两次')
    assert.equal(queue.size, 1)
    assert.equal(queue.find('run-b')?.runId, 'run-b')
    assert.equal(queue.find('run-a'), undefined)
  })

  it('keeps the snapshot stable while the live queue is mutated underneath it', () => {
    const queue = new RunQueue()
    for (const runId of ['run-a', 'run-b', 'run-c']) queue.push(queued(runId))

    const seen: string[] = []
    for (const entry of queue.snapshot()) {
      // 模拟挂起点期间 pauseTask 同步移走了另一个条目。
      if (entry.runId === 'run-a') queue.take('run-b')
      seen.push(entry.runId)
    }

    assert.deepEqual(seen, ['run-a', 'run-b', 'run-c'], '快照必须完整走完，不受同步移除影响')
    assert.equal(queue.find('run-b'), undefined)
    assert.deepEqual([queue.take('run-b'), queue.take('run-c')], [false, true], '被别人取走的条目不得再次取到')
  })

  it('lists the run IDs belonging to one task without exposing an index', () => {
    const queue = new RunQueue()
    queue.push(queued('run-a', 'task-1'))
    queue.push(queued('run-b', 'task-2'))
    queue.push(queued('run-c', 'task-1'))

    assert.deepEqual(queue.runIdsFor('task-1'), ['run-a', 'run-c'])
    assert.deepEqual(queue.runIdsFor('task-missing'), [])
  })
})

describe('WorkerRegistry', () => {
  // C2：完成信号必须在建仓之前就可用，否则建仓抛出时等 completion 的人永远等不到。
  it('creates a completion signal that is settleable before anything else exists', async () => {
    const completion = createRunCompletion()
    let settled = false
    void completion.promise.then(() => { settled = true })

    completion.settle()
    completion.settle()
    await completion.promise
    assert.equal(settled, true)
  })

  it('holds at most one active run per task and only forgets the current one', () => {
    const registry = new WorkerRegistry()
    const first = activeRun('task-1', 'run-a')
    const second = activeRun('task-1', 'run-b')

    registry.register(first)
    assert.equal(registry.active('task-1'), first)
    assert.equal(registry.isCurrent(first), true)

    registry.register(second)
    assert.equal(registry.size, 1, '不变式 I1：同一 task 最多一条 active run')
    assert.equal(registry.isCurrent(first), false)

    registry.forget(first)
    assert.equal(registry.active('task-1'), second, '过期的 run 不得把后来者踢出注册表')

    registry.forget(second)
    assert.equal(registry.size, 0)
  })

  it('lists every active run across tasks', () => {
    const registry = new WorkerRegistry()
    registry.register(activeRun('task-1', 'run-a'))
    registry.register(activeRun('task-2', 'run-b'))
    assert.deepEqual(registry.list().map(run => run.runId).sort(), ['run-a', 'run-b'])
  })
})

describe('EventPipeline', () => {
  // 不变式 I4：同一 taskId 的事件严格按到达顺序处理。
  it('processes the events of one task in arrival order even when handling is slow', async () => {
    const handled: string[] = []
    const pipeline = new EventPipeline({
      handle: async received => {
        await new Promise(resolve => setTimeout(resolve, received.type === 'first' ? 20 : 0))
        handled.push(received.type)
      },
    })

    const all = [
      pipeline.enqueue(event('task-1', 'run-a', 'first')),
      pipeline.enqueue(event('task-1', 'run-a', 'second')),
      pipeline.enqueue(event('task-1', 'run-a', 'third')),
    ]
    await Promise.all(all)
    assert.deepEqual(handled, ['first', 'second', 'third'])
  })

  // C6 的另一半：链条错误交回调用方，不再被静默吞掉。
  it('hands a handler failure back to the caller and keeps the chain usable', async () => {
    const handled: string[] = []
    const pipeline = new EventPipeline({
      handle: async received => {
        if (received.type === 'boom') throw new Error('persist failed')
        handled.push(received.type)
      },
    })

    await assert.rejects(pipeline.enqueue(event('task-1', 'run-a', 'boom')), /persist failed/)
    await pipeline.enqueue(event('task-1', 'run-a', 'after'))
    assert.deepEqual(handled, ['after'])
  })

  // C6：drain 必须是屏障——等待期间接上来的新事件也要等到。
  it('drains events enqueued while the drain is already waiting', async () => {
    const handled: string[] = []
    const pipeline: EventPipeline = new EventPipeline({
      handle: async received => {
        handled.push(received.type)
        if (received.type === 'first') void pipeline.enqueue(event('task-1', 'run-a', 'follow-up'))
      },
    })

    void pipeline.enqueue(event('task-1', 'run-a', 'first'))
    await pipeline.drain('task-1')
    assert.deepEqual(handled, ['first', 'follow-up'], 'drain 期间接上来的事件也必须排空')
  })

  it('accumulates text deltas per run and yields them exactly once', () => {
    const pipeline = new EventPipeline({ handle: async () => {} })
    pipeline.appendResponse('run-a', 'Hello, ')
    pipeline.appendResponse('run-a', 'world')
    pipeline.appendResponse('run-b', 'other')

    assert.equal(pipeline.takeResponse('run-a'), 'Hello, world')
    assert.equal(pipeline.takeResponse('run-a'), undefined)
    assert.equal(pipeline.takeResponse('run-b'), 'other')
  })

  // 不变式 I7：只有副作用工具需要 SIDE_EFFECT_UNKNOWN；判定点只有一个。
  it('tracks only side-effecting tools as in-flight, and clears them on end', () => {
    const pipeline = new EventPipeline({ handle: async () => {} })
    pipeline.sideEffectStarted('run-a', 'tool-1', 'bash', 100)
    pipeline.sideEffectStarted('run-a', 'tool-2', 'read', 101)
    pipeline.sideEffectStarted('run-a', 'tool-3', 'write', 102)

    assert.deepEqual(
      pipeline.pendingSideEffects('run-a').map(([toolId, pending]) => [toolId, pending.toolName]),
      [['tool-1', 'bash'], ['tool-3', 'write']],
      'read 不是副作用工具，不该被登记',
    )

    pipeline.sideEffectEnded('run-a', 'tool-1')
    assert.deepEqual(pipeline.pendingSideEffects('run-a').map(([toolId]) => toolId), ['tool-3'])

    pipeline.forgetRun('run-a')
    assert.deepEqual(pipeline.pendingSideEffects('run-a'), [])
  })
})
