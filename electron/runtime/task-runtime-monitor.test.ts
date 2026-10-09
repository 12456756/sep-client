import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import { TaskRunStore } from '../data/task-run-store'
import { TaskRuntime } from './task-runtime'
import { silentTaskMonitor, type MonitorTaskFinishedInput, type MonitorTaskQueuedInput } from '../domain/task-monitor'

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for monitor lifecycle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

it('reports real RUNNING/FAILED after settlement and never completes on partial output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-monitor-runtime-'))
  try {
    const manager = new TaskManager(root)
    await manager.initialize(); await manager.setCurrentUser('member', 'enterprise')
    const task = await manager.createTask('task', 'prompt', join(root, 'workspace'), 'sub')
    const output: string[] = []
    const finished: MonitorTaskFinishedInput[] = []
    const localAtReport: string[] = []
    const started: string[] = []
    const queued: MonitorTaskQueuedInput[] = []
    const runtime = new TaskRuntime({ taskManager: manager, taskRunStore: new TaskRunStore(root),
      getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
      resolveEmployee: () => ({ subscriptionId: 'sub', modelId: 'model', gatewayUrl: 'http://not-used' }),
      monitor: { ...silentTaskMonitor,
        async taskQueued(input) { queued.push(input) },
        async taskStarted(input) { started.push(input.runId) },
        async taskOutput(input) { output.push(input.content) },
        async taskFinished(input) { finished.push(input); localAtReport.push((await manager.getTask(input.taskId))!.status) },
      },
      createWorker: options => ({
        async run() {
          await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: 'sub', sequence: 0, type: 'text_delta', occurredAt: Date.now(), data: { text: 'x'.repeat(12000) } })
          throw new Error('mock failure')
        }, async abort() {}, async dispose() {},
      }),
    })
    await runtime.executeTask(task.id)
    await waitFor(() => finished.length > 0 && localAtReport.length > 0)
    assert.equal(started.length, 1)
    assert.equal(queued[0].protocolVersion, 2)
    assert.ok(Number.isFinite(queued[0].queuedAt))
    assert.deepEqual(queued[0].participation, { executionId: started[0], subscriptionId: 'sub', title: 'task', modelId: 'model' })
    assert.equal(output[0].length, 12000)
    assert.deepEqual(finished.map(input => input.status), ['FAILED'])
    assert.deepEqual(localAtReport, ['failed'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('settles local execution while all monitor network promises remain pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-monitor-best-effort-'))
  try {
    const manager = new TaskManager(root)
    await manager.initialize(); await manager.setCurrentUser('member', 'enterprise')
    const task = await manager.createTask('task', 'actual prompt', join(root, 'workspace'), 'sub')
    const pending = new Promise<void>(() => {})
    const calls: string[] = []
    const runtime = new TaskRuntime({ taskManager: manager, taskRunStore: new TaskRunStore(root),
      getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
      resolveEmployee: () => ({ subscriptionId: 'sub', modelId: 'model', gatewayUrl: 'http://not-used' }),
      monitor: { ...silentTaskMonitor,
        taskQueued() { calls.push('queued'); return pending },
        taskInput(input) { assert.equal(input.content, 'actual prompt'); calls.push('input'); return pending },
        taskStarted() { calls.push('started'); return pending },
        taskOutput(input) { assert.equal(input.content, 'actual output'); calls.push('output'); return pending },
        taskFinished(input) { assert.equal(input.status, 'COMPLETED'); calls.push('finished'); return pending },
      },
      createWorker: options => ({
        async run(prompt) {
          assert.equal(prompt, 'actual prompt')
          await options.onEvent({ taskId: task.id, runId: options.context.runId, subscriptionId: 'sub', sequence: 0,
            type: 'text_delta', occurredAt: Date.now(), data: { text: 'actual output' } })
        }, async abort() {}, async dispose() {},
      }),
    })
    await runtime.executeTask(task.id)
    await waitFor(() => calls.includes('finished'))
    assert.equal((await manager.getTask(task.id))?.status, 'completed')
    assert.deepEqual(calls, ['queued', 'input', 'started', 'output', 'finished'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const [control, expected] of [['pauseTask', 'PAUSED'], ['cancelTask', 'CANCELLED'], ['stopAll', 'PAUSED']] as const) {
  it(`reports ${expected} for ${control} only after the real run ends`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-monitor-control-'))
    try {
      const manager = new TaskManager(root)
      await manager.initialize(); await manager.setCurrentUser('member', 'enterprise')
      const task = await manager.createTask('task', 'prompt', join(root, 'workspace'), 'sub')
      let running = false
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const finished: MonitorTaskFinishedInput[] = []
      const runtime = new TaskRuntime({ taskManager: manager, taskRunStore: new TaskRunStore(root),
        getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
        resolveEmployee: () => ({ subscriptionId: 'sub', modelId: 'model', gatewayUrl: 'http://not-used' }),
        monitor: { ...silentTaskMonitor, async taskFinished(input) { finished.push(input) } },
        createWorker: () => ({ async run() { running = true; await gate }, async abort() { release() }, async dispose() {} }),
      })
      await runtime.executeTask(task.id); await waitFor(() => running)
      assert.equal(finished.length, 0)
      if (control === 'stopAll') await runtime.stopAll()
      else await runtime[control](task.id)
      assert.deepEqual(finished.map(input => input.status), [expected])
      assert.equal((await manager.getTask(task.id))!.status, control === 'stopAll' ? 'interrupted' : 'paused')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
