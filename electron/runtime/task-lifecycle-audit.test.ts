import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStatus } from '../../src/shared/types'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { TaskRunStore } from '../data/task-run-store'
import { TaskStore } from '../data/task-store'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sep-lifecycle-audit-'))
  roots.push(root)
  const runs = new TaskRunStore(root)
  const snapshots = new TaskStore(root)
  const checkpoints = new ArrangementCheckpointStore(root)
  const manager = new TaskManager(root, null, snapshots, runs, checkpoints)
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  const task = await manager.createTask('task', 'prompt')
  await manager.admitTask(task.id, 'run')
  await manager.updateTaskStatus(task.id, TaskStatus.RUNNING)
  await runs.create(scope, { taskId: task.id, runId: 'run', subscriptionId: 'sub', modelId: 'model',
    workspaceDir: task.workDir!, runtimeKey: 'runtime', prompt: 'prompt', executionKind: 'conversation' })
  await runs.finish(scope, task.id, 'run', 'completed')
  return { root, task, runs, snapshots, checkpoints, manager }
}

describe('task lifecycle audit races', () => {
  it('is read-only by default and does not write a snapshot on a repeated repair', async () => {
    const f = await fixture()
    const file = f.snapshots.getTaskFileForTesting(scope)
    const before = await readFile(file, 'utf8')
    const result = await f.manager.auditTaskLifecycles({ runtime: () => null })
    assert.equal(result.findings[0]?.finding.kind, 'terminal-evidence')
    assert.equal(result.reconciled, 0)
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })).reconciled, 1)
    const repaired = await readFile(file, 'utf8')
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })).reconciled, 0)
    assert.equal(await readFile(file, 'utf8'), repaired)
  })

  it('requires a current runtime probe even when the caller enables repair', async () => {
    const f = await fixture()
    assert.equal((await f.manager.auditTaskLifecycles({ reconcile: true })).reconciled, 0)
    assert.equal((await f.manager.getTask(f.task.id))?.activeRunId, 'run')
  })

  for (const action of ['pause', 'scope', 'retry'] as const) {
    it(`discards evidence when ${action} changes the task during a read`, async () => {
      const f = await fixture()
      const get = f.runs.get.bind(f.runs)
      let changed = false
      f.runs.get = async (...args) => {
        const run = await get(...args)
        if (!changed) {
          changed = true
          if (action === 'pause') await f.manager.pauseTask(f.task.id)
          else if (action === 'scope') f.manager.clearCurrentUser()
          else {
            await f.manager.settleTaskRun(f.task.id, 'run', TaskStatus.PENDING)
            await f.manager.admitTask(f.task.id, 'new-run')
          }
        }
        return run
      }
      const report = await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })
      assert.equal(report.reconciled, 0)
      if (action === 'scope') assert.equal(f.manager.getCurrentUserScope(), null)
      else {
        const current = await f.manager.getTask(f.task.id)
        assert.equal(current?.status, action === 'pause' ? TaskStatus.PAUSED : TaskStatus.PENDING)
        assert.equal(current?.activeRunId, action === 'pause' ? 'run' : 'new-run')
      }
    })
  }

  for (const action of ['ownership', 'archive'] as const) {
    it(`rechecks ${action} inside the serialized repair after reading evidence`, async () => {
      const f = await fixture()
      const get = f.runs.get.bind(f.runs)
      let reads = 0
      let owned = false
      f.runs.get = async (...args) => {
        const run = await get(...args)
        if (++reads === 2) {
          if (action === 'ownership') owned = true
          else f.manager.hideTaskRecord(f.task.id, scope)
        }
        return run
      }
      const report = await f.manager.auditTaskLifecycles({ reconcile: true,
        runtime: () => owned ? { runId: 'run', phase: 'finalizing' } : null })
      assert.equal(report.reconciled, 0)
      assert.equal((await f.manager.getTask(f.task.id))?.activeRunId, 'run')
      assert.equal((await f.runs.get(scope, f.task.id, 'run'))?.outcome, 'completed')
    })
  }

  it('preserves memory and allows a later repair after snapshot persistence fails', async () => {
    const f = await fixture()
    const save = f.snapshots.save.bind(f.snapshots)
    f.snapshots.save = async () => { throw new Error('injected write failure') }
    await assert.rejects(f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true }), /injected write failure/)
    assert.equal((await f.manager.getTask(f.task.id))?.status, TaskStatus.RUNNING)
    f.snapshots.save = save
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })).reconciled, 1)
  })

  it('requires the matching final arrangement checkpoint before completing its parent', async () => {
    const f = await fixture()
    await f.runs.create(scope, { taskId: f.task.id, runId: 'run', subscriptionId: 'sub', modelId: 'model',
      workspaceDir: f.task.workDir!, runtimeKey: 'runtime', prompt: 'prompt', executionKind: 'arrangement' })
    await f.runs.finish(scope, f.task.id, 'run', 'completed')
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })).reconciled, 0)
    await f.checkpoints.save(scope, { version: 1, taskId: f.task.id, owner: scope, planHash: 'plan',
      activeRunId: null, lastRunId: 'old-run', updatedAt: Date.now(),
      state: { status: 'completed', nodes: [], failureNodeIds: [], interruptionReason: null } })
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })).reconciled, 0)
    const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
    await f.checkpoints.save(scope, { ...checkpoint, lastRunId: 'run' })
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })).reconciled, 1)
    assert.equal((await f.manager.getTask(f.task.id))?.status, TaskStatus.COMPLETED)
  })

  for (const status of [TaskStatus.PENDING, TaskStatus.WAITING_APPROVAL]) {
    it(`repairs a ${status} snapshot that missed intermediate transitions using durable completion`, async () => {
      const f = await fixture()
      await f.manager.updateTaskStatus(f.task.id, status)
      const run = (await f.runs.get(scope, f.task.id, 'run'))!
      assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })).reconciled, 1)
      const repaired = (await f.manager.getTask(f.task.id))!
      assert.equal(repaired.status, TaskStatus.COMPLETED)
      assert.equal(repaired.activeRunId, null)
      assert.equal(repaired.lastRunStartedAt, run.startedAt)
      assert.equal(repaired.lastRunEndedAt, run.endedAt)
    })
  }

  it('resets the continuous missing-owner grace when a live owner is observed', async () => {
    const f = await fixture()
    await f.runs.create(scope, { taskId: f.task.id, runId: 'run', subscriptionId: 'sub', modelId: 'model',
      workspaceDir: f.task.workDir!, runtimeKey: 'runtime', prompt: 'prompt', executionKind: 'conversation' })
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, now: 0 })).findings[0]?.finding.kind, 'missing')
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => ({ runId: 'run', phase: 'running' }), now: 59_000 })).findings[0]?.finding.kind, 'live')
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, now: 60_000 })).findings[0]?.finding.kind, 'missing')
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, now: 119_999 })).findings[0]?.finding.kind, 'missing')
    assert.equal((await f.manager.auditTaskLifecycles({ runtime: () => null, now: 120_000 })).findings[0]?.finding.kind, 'suspected-lost')
    assert.equal((await f.runs.get(scope, f.task.id, 'run'))?.outcome, 'running')
  })

  it('yields after its time budget and resumes at the next task', async t => {
    const f = await fixture()
    const nextTask = await f.manager.createTask('next', 'prompt')
    let elapsed = 0
    t.mock.method(performance, 'now', () => elapsed)
    const get = f.runs.get.bind(f.runs)
    f.runs.get = async (...args) => { elapsed = 3; return get(...args) }
    const first = await f.manager.auditTaskLifecycles({ budgetMs: 2 })
    assert.deepEqual(first.findings.map(item => item.taskId), [f.task.id])
    const second = await f.manager.auditTaskLifecycles({ limit: 1 })
    assert.deepEqual(second.findings.map(item => item.taskId), [nextTask.id])
  })

  it('leaves fifteen legacy pending tasks untouched without submitting any work', async () => {
    const f = await fixture()
    await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })
    for (let index = 0; index < 15; index++) await f.manager.createTask(`legacy-${index}`, 'prompt')
    const file = f.snapshots.getTaskFileForTesting(scope)
    const before = await readFile(file, 'utf8')
    const report = await f.manager.auditTaskLifecycles({ runtime: () => null, reconcile: true })
    assert.equal(report.scanned, 15)
    assert.equal(report.reconciled, 0)
    assert.ok(report.findings.every(item => item.finding.kind === 'not-started'))
    assert.equal(await readFile(file, 'utf8'), before)
  })

  it('does not overlap periodic audits or submit work, and stops the timer with the runtime', async t => {
    const f = await fixture()
    t.mock.timers.enable({ apis: ['setInterval'] })
    let finishAudit!: () => void
    const audit = new Promise<void>(resolve => { finishAudit = resolve })
    let calls = 0
    t.mock.method(f.manager, 'auditTaskLifecycles', async () => {
      calls++
      await audit
      return { scanned: 0, limit: 50, findings: [], reconciled: 0 }
    })
    const runtime = new TaskRuntime({ taskManager: f.manager,
      getRefreshToken: () => { assert.fail('Audit must not request authentication') },
      onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
      resolveEmployee: () => { assert.fail('Audit must not resolve an employee') },
      createWorker: () => { assert.fail('Audit must not create a worker') },
    })
    try {
      t.mock.timers.tick(30_000)
      assert.equal(calls, 1)
      t.mock.timers.tick(90_000)
      assert.equal(calls, 1)
      finishAudit()
      await audit
      await runtime.stopAll()
      t.mock.timers.tick(120_000)
      assert.equal(calls, 1)
    } finally {
      finishAudit()
      await runtime.stopAll()
    }
  })
})
