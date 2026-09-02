import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus, type ClientTask } from '../../src/shared/types'
import { TaskPersistenceError, TaskScopeError, TaskStore } from './task-store'
import { TaskAdmissionError, TaskManager } from './task-manager'

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

    const reloaded = new TaskStore(userData)
    await reloaded.initialize()
    const persisted = await reloaded.load(scope)
    assert.equal(persisted[0]?.logs.length, 1)
  })

  it('recovers a task admitted before a crash even if it never reached running', async () => {
    const userData = await makeUserDataDir()
    const store = new TaskStore(userData)
    await store.initialize()
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const admitted = task(scope, 'admitted', TaskStatus.PENDING)
    admitted.activeRunId = 'run-a'
    await store.save(scope, [admitted])

    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const recovered = await manager.getTask('admitted')
    assert.equal(recovered?.status, TaskStatus.INTERRUPTED)
    assert.equal(recovered?.activeRunId, null)
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
    // Mirrors TaskExecutionCoordinator.cancelTask for a run that is still queued.
    assert.equal(await manager.settleTaskRun(created.id, 'run-a', TaskStatus.PENDING), true)
    const settled = await manager.getTask(created.id)
    assert.equal(settled?.status, TaskStatus.PENDING)
    assert.equal(settled?.activeRunId, null)
  })
})
