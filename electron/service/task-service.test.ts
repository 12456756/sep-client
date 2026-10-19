import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from '../runtime/task-manager'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { WorkspaceDirectoryStore } from '../data/workspace-directory-store'
import { TaskService, type TaskServiceDependencies } from './task-service'

const owner: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const workspaceNames = { enterpriseName: 'Acme Studio', memberName: 'Alice' }

describe('directory selection starting path', () => {
  const directories: string[] = []
  after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

  async function harness() {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sep-directory-selection-'))
    directories.push(userDataDir)
    const manager = new TaskManager(userDataDir)
    await manager.initialize()
    await manager.setCurrentUser(owner.memberId, owner.enterpriseId, workspaceNames)
    const service = new TaskService({
      scope: { currentScope: () => manager.getCurrentUserScope() }, taskManager: manager,
    } as ConstructorParameters<typeof TaskService>[0])
    return { userDataDir, manager, service, clearScope: () => manager.clearCurrentUser() }
  }

  it('creates the default parent without creating or changing a task', async () => {
    const { userDataDir, manager, service } = await harness()
    const path = await service.prepareDirectorySelection()
    const expected = new ScopePath(userDataDir).defaultWorkspaceRoot(owner, workspaceNames)
    assert.equal(path, join(userDataDir, 'task-workspaces', 'v1', 'Acme Studio', 'Alice'))
    assert.equal(path, expected)
    assert.ok((await stat(path)).isDirectory())
    assert.deepEqual(await manager.getAllTasks(), [])
    const task = await manager.createTask('new task', 'goal')
    assert.equal(task.workDir, join(path, task.id))
  })

  it('starts from an existing chosen directory', async () => {
    const { userDataDir, service } = await harness()
    const chosen = join(userDataDir, 'chosen')
    await mkdir(chosen)
    assert.equal(await service.prepareDirectorySelection(chosen), chosen)
  })

  it('falls back for empty, missing, or non-directory paths', async () => {
    const { userDataDir, service } = await harness()
    const file = join(userDataDir, 'file.txt')
    await writeFile(file, 'fixture')
    const expected = new ScopePath(userDataDir).defaultWorkspaceRoot(owner, workspaceNames)
    for (const path of ['', '   ', join(userDataDir, 'missing'), file]) {
      assert.equal(await service.prepareDirectorySelection(path), expected)
    }
  })

  it('uses the currently authenticated owner workspace', async () => {
    const { userDataDir, manager, service } = await harness()
    const names = { enterpriseName: 'Other Company', memberName: 'Bob' }
    await manager.setCurrentUser('member-b', 'enterprise-b', names)
    assert.equal(await service.prepareDirectorySelection(), new ScopePath(userDataDir).defaultWorkspaceRoot({ memberId: 'member-b', enterpriseId: 'enterprise-b' }, names))
  })

  it('keeps workspace names during persistence recovery and task reload', async () => {
    const { userDataDir, manager, service } = await harness()
    const path = await service.prepareDirectorySelection()
    await manager.recoverPersistence()
    const task = await manager.createTask('conversation', 'goal')
    assert.equal(task.workDir, join(path, task.id))
    const restored = new TaskManager(userDataDir)
    await restored.setCurrentUser(owner.memberId, owner.enterpriseId, workspaceNames)
    assert.equal((await restored.getTask(task.id))?.workDir, task.workDir)
    assert.equal(await restored.prepareDirectorySelection(), path)
    assert.deepEqual(restored.getCurrentUserScope(), owner)
  })

  it('leaves an explicitly selected task workspace unchanged', async () => {
    const { userDataDir, manager } = await harness()
    const chosen = join(userDataDir, 'chosen')
    const task = await manager.createTask('arrangement', 'goal', chosen)
    assert.equal(task.workDir, chosen)
  })

  for (const operation of ['createTask', 'prepareDirectorySelection'] as const) {
    it(`rejects ${operation} if the owner changes during directory resolution`, async t => {
      const { userDataDir, manager } = await harness()
      const entered = deferred()
      const resume = deferred()
      t.mock.method(WorkspaceDirectoryStore.prototype, 'resolve', async () => {
        entered.resolve()
        await resume.promise
        return workspaceNames
      })
      const pending = operation === 'createTask'
        ? manager.createTask('old owner task', 'goal')
        : manager.prepareDirectorySelection()
      const rejected = assert.rejects(pending, /scope/i)
      await entered.promise
      await manager.setCurrentUser('member-b', 'enterprise-b', { enterpriseName: 'Other', memberName: 'Bob' })
      resume.resolve()
      await rejected
      assert.deepEqual(await manager.getAllTasks(), [])
      const path = new ScopePath(userDataDir).defaultWorkspaceRoot(owner, workspaceNames)
      assert.equal(await stat(path).then(() => true, () => false), false)
    })
  }

  it('rejects a cleared session before using a supplied directory', async () => {
    const { userDataDir, service, clearScope } = await harness()
    clearScope()
    await assert.rejects(() => service.prepareDirectorySelection(userDataDir), { code: 'AUTH_REQUIRED' })
  })
})

import { TaskCreationGate } from './task-creation-gate'
import type { ClientTask } from '../../src/shared/types'

const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const task: ClientTask = { id: 'task-a', title: 'Task', prompt: 'plain', status: 'pending', workDir: null, createdAt: 1, startedAt: null, completedAt: null, error: null, files: [], logs: [], ownerId: scope.memberId, ownerEnterpriseId: scope.enterpriseId, subscriptionId: 'sub-a', activeRunId: null }
const missing = { state: 'missing' as const }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
function harness(extra: Record<string, unknown> = {}) {
  return new TaskService({
    scope: { currentScope: () => scope },
    taskManager: { async getTask() { return task }, async getAllTasks() { return [task] }, async createTask() { return task } },
    taskMetadataStore: { async diagnose() { return missing }, async save() {} },
    workPlans: { async diagnose() { return missing } },
    employees: { async authorize() { return true } },
    taskRunStore: {}, execution: async () => ({}), ...extra,
  } as unknown as TaskServiceDependencies)
}

it('projects get and list without mutating raw tasks or treating unavailable plan dependencies as absent', async () => {
  const service = harness()
  assert.deepEqual((await service.get(task.id)).workType, { state: 'resolved', kind: 'conversation' })
  assert.deepEqual((await service.list())[0]?.workType, { state: 'resolved', kind: 'conversation' })
  assert.equal(task.workType, undefined)
  assert.deepEqual((await harness({ workPlans: undefined }).get(task.id)).workType, { state: 'unavailable' })
  assert.deepEqual((await harness({ workPlans: { async diagnose() { throw new Error('IO failure') } } }).get(task.id)).workType, { state: 'unavailable' })
})

it('queries wait for create metadata saving and return the saved kind', async () => {
  const gate = new TaskCreationGate()
  const saving = deferred()
  const entered = deferred()
  const order: string[] = []
  let kind: 'arrangement' | null = null
  const service = harness({ creationGate: gate, taskMetadataStore: {
    async save() { order.push('save'); entered.resolve(); await saving.promise; kind = 'arrangement' },
    async diagnose() { order.push('read'); return kind ? { state: 'found', value: { kind } } : missing },
  } })
  const creation = service.create({ title: 'Task', prompt: 'plain', subscriptionId: 'sub-a' }, 'arrangement')
  await entered.promise
  let returned = false
  const queries = Promise.all([service.get(task.id), service.list()]).then(result => { returned = true; return result })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(returned, false)
  assert.deepEqual(order, ['save'])
  saving.resolve()
  const created = await creation
  const [one, list] = await queries
  assert.deepEqual(created.workType, { state: 'resolved', kind: 'arrangement' })
  assert.deepEqual(one.workType, created.workType)
  assert.deepEqual(list[0]?.workType, created.workType)
})

it('releases failed creations and keeps visible failed tasks unavailable', async () => {
  const gate = new TaskCreationGate()
  const service = harness({ creationGate: gate, taskMetadataStore: { async diagnose() { return missing }, async save() { throw new Error('disk full') } } })
  await assert.rejects(service.create({ title: 'Task', prompt: 'plain', subscriptionId: 'sub-a' }, 'arrangement'), /disk full/)
  for (let i = 0; i < 2; i += 1) assert.deepEqual((await service.get(task.id)).workType, { state: 'unavailable' })
  assert.deepEqual((await service.list())[0]?.workType, { state: 'unavailable' })
})

it('retries projection when a new creation overlaps reads and rejects changed scope', async () => {
  const gate = new TaskCreationGate()
  let reads = 0
  const service = harness({ creationGate: gate, taskMetadataStore: { async diagnose() {
    reads += 1
    if (reads === 1) { const lease = gate.begin(scope); lease.finish(true) }
    return missing
  } } })
  await service.get(task.id)
  assert.equal(reads, 2)
  let current = scope
  const switched = harness({ scope: { currentScope: () => current }, taskMetadataStore: { async diagnose() { current = { ...scope, memberId: 'other' }; return missing } } })
  await assert.rejects(switched.get(task.id), { code: 'AUTH_REQUIRED' })
})

it('registers before the first visible-task event and releases even if createTask throws', async () => {
  const gate = new TaskCreationGate()
  const entered = deferred()
  const visible = deferred()
  let kind: 'conversation' | null = null
  let query: ReturnType<TaskService['get']> | undefined
  let returned = false
  const service = harness({ creationGate: gate,
    taskManager: { async getTask() { return task }, async createTask() {
      query = service.get(task.id).then(value => { returned = true; return value })
      entered.resolve()
      await visible.promise
      return task
    } },
    taskMetadataStore: { async save() { kind = 'conversation' }, async diagnose() { return kind ? { state: 'found', value: { kind } } : missing } },
  })
  const creation = service.create({ title: 'Task', prompt: 'plain', subscriptionId: 'sub-a' }, 'conversation')
  await entered.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(returned, false)
  visible.resolve()
  await creation
  assert.deepEqual((await query)?.workType, { state: 'resolved', kind: 'conversation' })
  const failed = harness({ creationGate: gate, taskManager: { async createTask() { throw new Error('create failed') } } })
  await assert.rejects(failed.create({ title: 'Task', prompt: 'plain', subscriptionId: 'sub-a' }, 'conversation'), /create failed/)
  await gate.waitForIdle(scope)
})

it('does not wait on another scope and keeps one broken record from failing the whole list', async () => {
  const gate = new TaskCreationGate()
  const other = gate.begin({ ...scope, enterpriseId: 'other' })
  const service = harness({ creationGate: gate, taskManager: { async getAllTasks() { return [task, { ...task, id: 'task-b' }] } },
    taskMetadataStore: { async diagnose(_scope: unknown, id: string) {
      if (id === task.id) throw new Error('broken')
      return { state: 'found', value: { kind: 'arrangement' } }
    } },
  })
  try {
    assert.deepEqual((await service.list()).map(value => value.workType), [{ state: 'unavailable' }, { state: 'resolved', kind: 'arrangement' }])
  } finally {
    other.finish(true)
  }
})

it('archives media tasks without deleting their history and filters them from the active list', async () => {
  const archived = new Set<string>()
  let deletions = 0
  const service = harness({
    taskManager: { async getTask() { return task }, async getAllTasks() { return [task] }, async deleteTask() { deletions++; return true } },
    media: {
      async archiveIfMedia(id: string) { archived.add(id); return true },
      async isArchived(id: string) { return archived.has(id) },
    },
  })
  await service.delete(task.id)
  assert.equal(deletions, 0)
  assert.deepEqual(await service.list(), [])
  assert.equal((await service.get(task.id)).id, task.id)
})

it('preserves ordinary task deletion and the running-task guard when media is absent', async () => {
  let allowed = true
  let deletions = 0
  const service = harness({
    taskManager: { async deleteTask() { deletions++; return allowed } },
    media: { async archiveIfMedia() { return false } },
  })
  await service.delete(task.id)
  allowed = false
  await assert.rejects(service.delete(task.id), { code: 'INVALID_STATE' })
  assert.equal(deletions, 2)
})
