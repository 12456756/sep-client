import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus, type ClientTask } from '../../src/shared/types'
import { TaskPersistenceError, TaskStore } from './task-store'
import { TaskRunStore } from './task-run-store'
import { TaskScopeError } from './scope-path'
import { TaskAdmissionError, TaskManager } from '../runtime/task-manager'

const temporaryDirectories: string[] = []

async function makeUserDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-tasks-'))
  temporaryDirectories.push(directory)
  return directory
}

function task(
  owner: { memberId: string; enterpriseId: string },
  id: string,
  status: ClientTask['status'] = TaskStatus.PENDING,
): ClientTask {
  return {
    id,
    title: `Task ${id}`,
    prompt: 'test prompt',
    status,
    workDir: null,
    createdAt: 1,
    startedAt: status === TaskStatus.RUNNING ? 2 : null,
    completedAt: null,
    error: null,
    files: [],
    logs: [],
    ownerId: owner.memberId,
    ownerEnterpriseId: owner.enterpriseId,
    subscriptionId: null,
    activeRunId: null,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('TaskStore', () => {
  it('persists start failure health and queue time across reloads', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const original = task(scope, 'legacy-pending')
    original.executionHealth = 'start-failed'
    original.startFailureAt = 10
    original.error = 'authorization unavailable'
    original.queuedAt = 8
    await store.save(scope, [original])
    const [loaded] = await store.load(scope)
    assert.equal(loaded?.executionHealth, 'start-failed')
    assert.equal(loaded?.startFailureAt, 10)
    assert.equal(loaded?.queuedAt, 8)
  })

  it('normalizes legacy and invalid pin timestamps while preserving valid pins', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const legacy = task(scope, 'legacy')
    const pinned = { ...task(scope, 'pinned'), pinnedAt: Date.now() - 10 }
    const laterClock = { ...task(scope, 'later-clock'), pinnedAt: Date.now() + 3_600_000 }
    const invalid = { ...task(scope, 'invalid'), pinnedAt: Number.POSITIVE_INFINITY }
    await store.save(scope, [legacy, pinned, laterClock, invalid])
    const loaded = await store.load(scope)
    assert.equal(loaded.find(item => item.id === 'legacy')?.pinnedAt, null)
    assert.equal(loaded.find(item => item.id === 'pinned')?.pinnedAt, pinned.pinnedAt)
    assert.equal(loaded.find(item => item.id === 'later-clock')?.pinnedAt, laterClock.pinnedAt)
    assert.equal(loaded.find(item => item.id === 'invalid')?.pinnedAt, null)
  })

  it('isolates task files by enterprise and member', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const first = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const second = { memberId: 'member-b', enterpriseId: 'enterprise-a' }

    await Promise.all([
      store.save(first, [task(first, 'a')]),
      store.save(second, [task(second, 'b')]),
    ])

    assert.deepEqual((await store.load(first)).map(item => item.id), ['a'])
    assert.deepEqual((await store.load(second)).map(item => item.id), ['b'])
    assert.notEqual(store.getTaskFileForTesting(first), store.getTaskFileForTesting(second))
  })

  it('serializes writes within one scope', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

    await Promise.all([
      store.save(scope, [task(scope, 'first')]),
      store.save(scope, [task(scope, 'second')]),
    ])

    assert.deepEqual((await store.load(scope)).map(item => item.id), ['second'])
  })

  it('removes the deprecated global tasks file without importing it', async () => {
    const userData = await makeUserDataDir()
    const legacyFile = join(userData, 'tasks.json')
    await writeFile(legacyFile, JSON.stringify({ version: 1, tasks: [task({ memberId: 'old', enterpriseId: 'old' }, 'old')] }))

    const store = new TaskStore(userData)
    await store.initialize()

    await assert.rejects(stat(legacyFile))
    assert.deepEqual(await store.load({ memberId: 'old', enterpriseId: 'old' }), [])
  })

  it('quarantines malformed scope data', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const file = store.getTaskFileForTesting(scope)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '{not-json')

    assert.deepEqual(await store.load(scope), [])
    await assert.rejects(stat(file))
    const files = await readFile(join(file, '..'), 'utf8').catch(() => '')
    assert.equal(files, '')
  })

  it('rejects unsafe scope identifiers', async () => {
    const store = new TaskStore(await makeUserDataDir())
    await store.initialize()
    await assert.rejects(store.load({ memberId: '../escape', enterpriseId: 'enterprise-a' }), TaskScopeError)
    await assert.rejects(store.load({ memberId: '', enterpriseId: 'enterprise-a' }), TaskScopeError)
  })

  it('starts with empty v3 storage after deleting v2 data', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const v2 = join(userData, 'task-data', 'v2')
    await mkdir(v2, { recursive: true })
    await writeFile(join(v2, 'stale.json'), 'stale')
    const freshStore = new TaskStore(userData)
    await freshStore.initialize()
    assert.deepEqual(await freshStore.load(scope), [])
    await assert.rejects(stat(v2))
  })

  it('uses a valid backup when the primary file is malformed', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    await store.save(scope, [task(scope, 'kept')])
    const file = store.getTaskFileForTesting(scope)
    await writeFile(file, '{broken')
    await writeFile(`${file}.bak`, JSON.stringify({ version: 3, owner: scope, updatedAt: 2, tasks: [task(scope, 'backup')] }))

    assert.deepEqual((await store.load(scope)).map(item => item.id), ['backup'])
  })
})

describe('TaskManager start failure lifecycle', () => {
  it('preserves the run start time when a run resumes after approval', async t => {
    let now = 100
    t.mock.method(Date, 'now', () => now++)
    const manager = new TaskManager(await makeUserDataDir())
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const created = await manager.createTask('Task', 'Prompt')
    await manager.admitTask(created.id, 'run-a')
    await manager.updateTaskStatus(created.id, TaskStatus.RUNNING)
    const firstStart = (await manager.getTask(created.id))?.currentRunStartedAt
    await manager.updateTaskStatus(created.id, TaskStatus.WAITING_APPROVAL)
    await manager.updateTaskStatus(created.id, TaskStatus.RUNNING)
    assert.equal((await manager.getTask(created.id))?.currentRunStartedAt, firstStart)
  })

  it('records a pre-admission failure and clears it when the task is admitted', async () => {
    const manager = new TaskManager(await makeUserDataDir())
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const created = await manager.createTask('Task', 'Prompt')
    assert.equal(await manager.recordStartFailure(created.id, 'authorization unavailable'), true)
    const failed = await manager.getTask(created.id)
    assert.equal(failed?.executionHealth, 'start-failed')
    assert.equal(failed?.error, 'authorization unavailable')
    assert.equal(failed?.startedAt, null)
    assert.equal(failed?.activeRunId, null)
    await manager.admitTask(created.id, 'run-retry')
    const admitted = await manager.getTask(created.id)
    assert.equal(admitted?.executionHealth, undefined)
    assert.equal(admitted?.error, null)
    assert.equal(admitted?.activeRunId, 'run-retry')
  })
})

describe('TaskManager user scope', () => {
  it('clears the previous user before loading another scope', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    const first = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const second = { memberId: 'member-b', enterpriseId: 'enterprise-a' }

    await manager.setCurrentUser(first.memberId, first.enterpriseId)
    await manager.createTask('first', 'prompt')
    await manager.setCurrentUser(second.memberId, second.enterpriseId)
    assert.deepEqual(await manager.getAllTasks(), [])
    await manager.setCurrentUser(first.memberId, first.enterpriseId)
    assert.equal((await manager.getAllTasks()).length, 1)
  })

  it('recovers active tasks to interrupted exactly once', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    await store.save(scope, [task(scope, 'running', TaskStatus.RUNNING), task(scope, 'waiting', TaskStatus.WAITING_APPROVAL)])

    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const recovered = await manager.getAllTasks()
    assert.deepEqual(recovered.map(item => item.status), [TaskStatus.INTERRUPTED, TaskStatus.INTERRUPTED])
    assert.equal(recovered[0]?.logs.length, 1)
    assert.equal(recovered[0]?.lastRunStartedAt, 2)
    assert.ok(Number.isFinite(recovered[0]?.lastRunEndedAt))

    const reloaded = new TaskStore(userData)
    await reloaded.initialize()
    const persisted = await reloaded.load(scope)
    assert.equal(persisted[0]?.logs.length, 1)
  })

  it('audits a bounded rotating set and is read-only by default', async () => {
    const userData = await makeUserDataDir()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    for (let index = 0; index < 5; index++) {
      const item = await manager.createTask('stale-' + index, 'prompt')
      await manager.admitTask(item.id, 'run-' + index)
      await manager.updateTaskStatus(item.id, TaskStatus.RUNNING)
    }
    const first = await manager.auditTaskLifecycles({ limit: 2, now: 9_999_999, missingGraceMs: 0 })
    const second = await manager.auditTaskLifecycles({ limit: 2, now: 9_999_999, missingGraceMs: 0 })
    assert.equal(first.scanned, 2)
    assert.equal(second.scanned, 2)
    assert.equal(first.findings.every(item => item.finding.kind === 'missing' || item.finding.kind === 'suspected-lost'), true)
    assert.equal(second.findings.some(item => first.findings.some(previous => previous.taskId === item.taskId)), false)
    assert.equal((await manager.getAllTasks()).every(item => item.status === TaskStatus.RUNNING), true)
  })

  it('reconciles a matching completed conversation run without executing it again', async () => {
    const userData = await makeUserDataDir()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const created = await manager.createTask('recoverable', 'prompt')
    await manager.admitTask(created.id, 'run-complete')
    await manager.updateTaskStatus(created.id, TaskStatus.RUNNING)
    const runStore = new TaskRunStore(userData)
    await runStore.create(scope, { taskId: created.id, runId: 'run-complete', subscriptionId: 'sub', modelId: 'model',
      runtimeKey: 'sub:model', workspaceDir: 'workspace', prompt: 'prompt', executionKind: 'conversation' })
    await runStore.finish(scope, created.id, 'run-complete', 'completed')
    const endedAt = (await runStore.get(scope, created.id, 'run-complete'))!.endedAt!
    const result = await manager.auditTaskLifecycles({ now: endedAt + 1, runtime: () => null, reconcile: true })
    const recovered = await manager.getTask(created.id)
    assert.equal(result.reconciled, 1)
    assert.equal(recovered?.status, TaskStatus.COMPLETED)
    assert.equal(recovered?.activeRunId, null)
    assert.equal(recovered?.lastRunId, 'run-complete')
    assert.equal(recovered?.lastRunEndedAt, endedAt)
  })

  it('diagnoses missing ownership after grace without modifying unknown results or intentional pauses', async () => {
    const userData = await makeUserDataDir()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const lost = await manager.createTask('lost', 'prompt')
    await manager.admitTask(lost.id, 'run-lost')
    await manager.updateTaskStatus(lost.id, TaskStatus.RUNNING)
    const runs = new TaskRunStore(userData)
    await runs.create(scope, { taskId: lost.id, runId: 'run-lost', subscriptionId: 'sub', modelId: 'model', runtimeKey: 'r', workspaceDir: 'w', prompt: 'p' })
    const lostAt = (await runs.get(scope, lost.id, 'run-lost'))!.startedAt + 60_001
    const waiting = await manager.createTask('paused', 'prompt')
    await manager.admitTask(waiting.id, 'run-paused')
    await manager.pauseTask(waiting.id)
    const first = await manager.auditTaskLifecycles({ runtime: () => null, now: lostAt - 60_000, missingGraceMs: 60_000, reconcile: true })
    assert.equal(first.findings.find(item => item.taskId === lost.id)?.finding.kind, 'missing')
    const result = await manager.auditTaskLifecycles({ runtime: () => null, now: lostAt, missingGraceMs: 60_000, reconcile: true })
    assert.equal(result.findings.find(item => item.taskId === lost.id)?.finding.kind, 'suspected-lost')
    assert.equal(result.reconciled, 0)
    assert.equal((await manager.getTask(lost.id))?.status, TaskStatus.RUNNING)
    assert.equal((await runs.get(scope, lost.id, 'run-lost'))?.outcome, 'running')
    assert.equal((await manager.getTask(waiting.id))?.status, TaskStatus.PAUSED)
    assert.equal((await manager.getTask(waiting.id))?.activeRunId, 'run-paused')
  })

  it('recovers a task admitted before a crash even if it never reached running', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const admitted = task(scope, 'admitted', TaskStatus.PENDING)
    admitted.startedAt = 2
    admitted.activeRunId = 'run-a'
    await store.save(scope, [admitted])

    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const recovered = await manager.getTask('admitted')
    assert.equal(recovered?.status, TaskStatus.INTERRUPTED)
    assert.equal(recovered?.activeRunId, null)
    assert.equal(recovered?.lastRunStartedAt, null, 'a retry admitted before its worker starts must not inherit the previous run start')
    assert.ok(Number.isFinite(recovered?.lastRunEndedAt))
  })

  it('clears a paused task run left behind by a crash during pause cleanup', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const paused = task(scope, 'paused-with-run', TaskStatus.PAUSED)
    paused.startedAt = 1
    paused.activeRunId = 'run-a'
    await store.save(scope, [paused])

    const manager = new TaskManager(userData)
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const recovered = await manager.getTask(paused.id)
    assert.equal(recovered?.status, TaskStatus.PAUSED)
    assert.equal(recovered?.activeRunId, null)
    assert.equal(recovered?.lastRunId, 'run-a')
    assert.equal(recovered?.lastRunStartedAt, null)
    assert.ok(Number.isFinite(recovered?.lastRunEndedAt))
  })

  it('rejects operations without an active scope', async () => {
    const manager = new TaskManager(await makeUserDataDir())
    await manager.initialize()
    await assert.rejects(manager.getAllTasks(), TaskScopeError)
    await assert.rejects(manager.createTask('title', 'prompt'), TaskScopeError)
  })

  it('does not keep a mutation when persistence fails', async () => {
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const failingStore = {
      async initialize() {},
      async load() { return [] },
      async save() { throw new TaskPersistenceError('injected failure') },
    }
    const manager = new TaskManager('unused', null, failingStore)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    await assert.rejects(manager.createTask('title', 'prompt'), TaskPersistenceError)
    assert.deepEqual(await manager.getAllTasks(), [])
  })

  it('admits only one execution when submissions race', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const created = await manager.createTask('title', 'prompt')

    const results = await Promise.allSettled([
      manager.admitTask(created.id, 'run-a'),
      manager.admitTask(created.id, 'run-b'),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    assert.ok(rejected?.reason instanceof TaskAdmissionError)
    assert.equal((await manager.getTask(created.id))?.activeRunId, 'run-a')
  })

  it('releases a queued admission when the run is settled back to pending', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const created = await manager.createTask('title', 'prompt')
    await manager.admitTask(created.id, 'run-a')
    // Mirrors TaskRuntime.cancelTask for a run that is still queued.
    assert.equal(await manager.settleTaskRun(created.id, 'run-a', TaskStatus.PENDING), true)
    const settled = await manager.getTask(created.id)
    assert.equal(settled?.status, TaskStatus.PENDING)
    assert.equal(settled?.activeRunId, null)
  })
})

