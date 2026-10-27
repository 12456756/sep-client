import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStatus } from '../../src/shared/types'
import { TaskRunStore } from '../data/task-run-store'
import { effectivePermissionPolicy, type WorkPlan } from '../domain/arrangement-plan'
import { ConversationExecutor, type ConversationExecutorOptions } from './conversation-executor'
import { EventPipeline } from './run-events'
import { WorkerRegistry } from './run-workers'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'

const directories: string[] = []
const scope = { memberId: 'fixture-member', enterpriseId: 'fixture-enterprise' }
const employee = { subscriptionId: 'fixture-employee', modelId: 'fixture-model', gatewayUrl: 'http://gateway.invalid' }

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sep-run-finalization-'))
  directories.push(directory)
  const runs = new TaskRunStore(directory)
  const manager = new TaskManager(directory, null, undefined, runs)
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  const task = await manager.createTask('fixture task', 'fixture prompt', join(directory, 'workspace'), employee.subscriptionId)
  return { directory, runs, manager, task }
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for task finalization.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function conversationFixture() {
  const base = await fixture()
  const workers = new WorkerRegistry()
  const events = new EventPipeline({ handle: async () => {} })
  let released = 0
  let pumped = 0
  let disposed = 0
  let completion: Promise<void> | undefined
  const options: ConversationExecutorOptions = {
    taskManager: base.manager, taskRunStore: base.runs,
    getRefreshToken: () => 'fixture-token', onAuthenticationRequired() {},
    authorizeEmployee: async () => employee, workspaceRoot: () => base.directory,
    approvals: { request: async () => false }, events, workers,
    enqueue() {}, requestPump() { pumped++ },
    createWorker: () => ({
      async run() { completion = workers.active(base.task.id)?.completion },
      async abort() {}, dispose() { disposed++; return Promise.resolve() },
    }),
  }
  await base.manager.admitTask(base.task.id, 'fixture-run')
  return {
    ...base, options, workers,
    async execute() {
      await new ConversationExecutor(options).execute({
        taskId: base.task.id, runId: 'fixture-run', subscriptionId: employee.subscriptionId,
        employee, prompt: 'fixture prompt', conversation: false,
      }, base.task, () => { released++ })
    },
    async assertReleased() {
      assert.equal(workers.size, 0)
      assert.equal(released, 1)
      assert.equal(disposed, 1)
      assert.equal(pumped, 1)
      assert.ok(completion)
      await completion
    },
  }
}

describe('conversation finalization regressions', { timeout: 10_000 }, () => {
  it('releases ownership and completion when video cleanup rejects and worker disposal throws', async () => {
    const f = await conversationFixture()
    const createWorker = f.options.createWorker
    f.options.createWorker = options => {
      const worker = createWorker(options)
      return { ...worker, dispose() { void worker.dispose(); throw new Error('fixture disposal failure') } }
    }
    f.options.video = {
      async prepareRun() { return undefined }, async waitForRun() {}, async stopTask() {},
      async finishRun() { throw new Error('fixture video cleanup failure') },
    }
    await f.execute()
    await f.assertReleased()
    assert.equal((await f.manager.getTask(f.task.id))?.status, TaskStatus.COMPLETED)
  })

  it('settles as failed when the final event cannot be persisted', async () => {
    const f = await conversationFixture()
    f.options.events = {
      drain: async () => {}, forgetRun() {}, pendingSideEffects: () => [], takeResponse: () => '',
      enqueue: async () => { throw new Error('fixture event write failure') },
    }
    await f.execute()
    await f.assertReleased()
    const task = await f.manager.getTask(f.task.id)
    assert.equal(task?.status, TaskStatus.FAILED)
    assert.equal(task?.activeRunId, null)
    assert.equal((await f.runs.get(scope, f.task.id, 'fixture-run'))?.outcome, 'failed')
  })

  it('still settles the task when run finish cannot be persisted', async () => {
    const f = await conversationFixture()
    f.runs.finish = async () => { throw new Error('fixture run write failure') }
    await f.execute()
    await f.assertReleased()
    const task = await f.manager.getTask(f.task.id)
    assert.equal(task?.status, TaskStatus.FAILED)
    assert.equal(task?.activeRunId, null)
    assert.equal(task?.error, '工作运行结果保存失败，请联系平台管理员')
  })

  it('retries a failed task settle using the already completed run outcome', async () => {
    const f = await conversationFixture()
    const settle = f.manager.settleTaskRun.bind(f.manager)
    let calls = 0
    f.manager.settleTaskRun = async (...args) => {
      if (++calls === 1) throw new Error('fixture transient task write failure')
      return settle(...args)
    }
    await f.execute()
    await f.assertReleased()
    assert.equal(calls, 2)
    const task = await f.manager.getTask(f.task.id)
    assert.equal(task?.status, TaskStatus.COMPLETED)
    assert.equal(task?.activeRunId, null)
    assert.equal((await f.runs.get(scope, f.task.id, 'fixture-run'))?.outcome, 'completed')
  })

  it('keeps matching run evidence if all task settlement writes fail', async () => {
    const f = await conversationFixture()
    f.manager.settleTaskRun = async () => { throw new Error('fixture persistent task write failure') }
    await assert.rejects(f.execute(), /persistent task write failure/)
    await f.assertReleased()
    assert.equal((await f.manager.getTask(f.task.id))?.activeRunId, 'fixture-run')
    assert.equal((await f.runs.get(scope, f.task.id, 'fixture-run'))?.outcome, 'completed')
  })
})

describe('arrangement finalization regressions', { timeout: 10_000 }, () => {
  for (const failure of ['video-cleanup', 'parent-run-finish', 'task-settle'] as const) {
    it(`releases the workspace and settles after ${failure} fails`, async () => {
      const f = await fixture()
      const arrangement: WorkPlan = {
        id: f.task.id, schemaVersion: 1, sourceDraftId: 'fixture-draft', sourceDraftRevision: 1,
        owner: scope, mode: 'manual', title: 'fixture plan', goal: 'fixture goal', conversation: null,
        nodes: [{ id: 'fixture-node', subscriptionId: employee.subscriptionId, modelId: employee.modelId,
          title: 'fixture node', instruction: 'fixture instruction', expectedOutput: 'fixture result',
          dependsOn: [], skillIds: [], requiresUserConfirmation: false }],
        workspace: { mode: 'shared', path: null }, permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'auto-approve' }),
        confirmedInputs: [], planHash: 'fixture-hash', createdAt: Date.now(),
      }
      const finish = f.runs.finish.bind(f.runs)
      f.runs.finish = async (...args) => {
        if (failure === 'parent-run-finish' && args[1] === f.task.id && args[2] === (await f.manager.getTask(f.task.id))?.activeRunId) {
          throw new Error('fixture parent finish failure')
        }
        return finish(...args)
      }
      const settle = f.manager.settleTaskRun.bind(f.manager)
      let settlementFailed = false
      f.manager.settleTaskRun = async (...args) => {
        if (failure === 'task-settle' && !settlementFailed) {
          settlementFailed = true
          throw new Error('fixture transient task write failure')
        }
        return settle(...args)
      }
      let disposed = 0
      let starts = 0
      const runtime = new TaskRuntime({
        taskManager: f.manager, taskRunStore: f.runs, getRefreshToken: () => 'fixture-token',
        onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
        resolveEmployee: () => employee, authorizeEmployee: async () => employee,
        workPlanStore: { get: async (_scope, taskId) => taskId === f.task.id ? structuredClone(arrangement) : null, save: async () => {} },
        video: {
          async prepareRun() { return undefined }, async waitForRun() {}, async stopTask() {},
          async finishRun() { if (failure === 'video-cleanup') throw new Error('fixture video cleanup failure') },
        },
        createWorker: () => ({ async run() { starts++ }, async abort() {}, async dispose() { disposed++ } }),
      })
      try {
        const next = await f.manager.createTask('next task', 'fixture next', f.task.workDir ?? undefined, employee.subscriptionId)
        await runtime.executeTask(f.task.id)
        await runtime.executeTask(next.id, { conversation: true })
        await waitFor(async () => (await f.manager.getTask(next.id))?.status === TaskStatus.COMPLETED)
        const task = await f.manager.getTask(f.task.id)
        assert.equal(task?.status, failure === 'parent-run-finish' ? TaskStatus.FAILED : TaskStatus.COMPLETED)
        assert.equal(task?.activeRunId, null)
        await runtime.stopAll()
        assert.equal(starts, 2)
        assert.equal(disposed, 2)
      } finally { await runtime.stopAll() }
    })
  }
})
