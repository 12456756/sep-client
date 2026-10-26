import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { ClientTask } from '../../src/shared/types'
import { MediaStore } from '../data/media-store'
import { MOCK_MEDIA_PNG } from '../data/mock-media-gateway'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { TaskStore, type TaskStorePort } from '../data/task-store'
import { ScopePath } from '../data/scope-path'
import { MediaService } from '../service/media-service'
import { TaskService } from '../service/task-service'
import { TaskManager, TaskStatus } from './task-manager'

const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.ok(resolve(root).startsWith(`${await realpath(tmpdir())}${sep}`))
    assert.ok(root.includes('sep-record-visibility-'))
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-record-visibility-'))
  roots.push(root)
  const lists: ClientTask[][] = []
  const updates: ClientTask[] = []
  const notifier = {
    taskListUpdated(tasks: ClientTask[]) { lists.push(tasks) },
    taskUpdated(task: ClientTask) { updates.push(task) },
  }
  const manager = new TaskManager(root, notifier)
  await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
  const store = new MediaStore(root)
  const media = new MediaService({
    scope: { currentScope: () => manager.getCurrentUserScope() }, store,
    getTask: id => manager.getTask(id), authorize: async () => null, requestApproval: async () => false,
  })
  const service = new TaskService({
    scope: { currentScope: () => manager.getCurrentUserScope() }, taskManager: manager,
    taskRunStore: new TaskRunStore(root), taskMetadataStore: new TaskMetadataStore(root),
    employees: { authorize: async () => true } as never,
    execution: async () => { throw new Error('No execution or network is used by this fixture.') }, media,
  })
  const task = await manager.createTask('media record', 'goal', undefined, 'employee-a')
  const path = join(root, 'reference.png')
  await writeFile(path, MOCK_MEDIA_PNG)
  const asset = await store.importReference(owner, task.id, path)
  const deliverable = join(task.workDir!, 'result.md')
  await writeFile(deliverable, 'User deliverable must survive record deletion.')
  return { root, manager, store, media, service, task, asset, path, deliverable, lists, updates, notifier }
}

describe('deleted work record visibility', () => {
  it('updates title and pin without changing lifecycle revision and persists both fields', async () => {
    const f = await fixture()
    const original = await f.manager.getTask(f.task.id)
    assert.ok(original)
    const updated = await f.manager.updateTaskDetails(f.task.id, { title: 'Renamed work', pinned: true })
    assert.equal(updated.title, 'Renamed work')
    assert.equal(typeof updated.pinnedAt, 'number')
    assert.equal(updated.stateRevision, original.stateRevision)
    assert.equal(f.updates.at(-1)?.pinnedAt, updated.pinnedAt)
    const reloaded = new TaskManager(f.root)
    await reloaded.setCurrentUser(owner.memberId, owner.enterpriseId)
    const persisted = await reloaded.getTask(f.task.id)
    assert.equal(persisted?.title, 'Renamed work')
    assert.equal(persisted?.pinnedAt, updated.pinnedAt)
  })

  it('keeps pinning idempotent and supports unpinning without changing lifecycle revision', async () => {
    const f = await fixture()
    const initial = await f.manager.getTask(f.task.id)
    const first = await f.manager.updateTaskDetails(f.task.id, { pinned: true })
    const second = await f.manager.updateTaskDetails(f.task.id, { pinned: true })
    assert.equal(first.pinnedAt, second.pinnedAt)
    assert.equal(second.stateRevision, initial?.stateRevision)
    const unpinned = await f.manager.updateTaskDetails(f.task.id, { pinned: false })
    assert.equal(unpinned.pinnedAt, null)
    assert.equal(unpinned.stateRevision, initial?.stateRevision)
  })

  it('does not report or retain an update when the authenticated scope changes mid-flight', async () => {
    const f = await fixture()
    const foreignScope = { memberId: 'member-b', enterpriseId: 'enterprise-b' }
    const foreignStore = new TaskStore(f.root)
    await foreignStore.initialize()
    await foreignStore.save(foreignScope, [{
      ...f.task,
      title: 'Foreign scope title',
      pinnedAt: null,
      ownerId: foreignScope.memberId,
      ownerEnterpriseId: foreignScope.enterpriseId,
    }])
    f.updates.length = 0
    const update = f.manager.updateTaskDetails(f.task.id, { title: 'stale scope update', pinned: true })
    const rejected = assert.rejects(update)
    f.lists.length = 0
    await f.manager.setCurrentUser(foreignScope.memberId, foreignScope.enterpriseId)
    await rejected
    assert.deepEqual(f.updates, [])
    const foreignTask = await f.manager.getTask(f.task.id)
    assert.equal(foreignTask?.title, 'Foreign scope title')
    assert.equal(foreignTask?.pinnedAt, null)
  })

  it('rejects detail updates for hidden records', async () => {
    const f = await fixture()
    f.updates.length = 0
    f.manager.hideTaskRecord(f.task.id, owner)
    await assert.rejects(
      f.manager.updateTaskDetails(f.task.id, { title: 'should stay hidden' }),
    )
    assert.deepEqual(f.updates, [])
  })

  it('preserves concurrent lifecycle mutation while updating details', async () => {
    const f = await fixture()
    await f.manager.admitTask(f.task.id, 'run-a')
    const [, updated] = await Promise.all([
      f.manager.updateTaskStatus(f.task.id, TaskStatus.RUNNING),
      f.manager.updateTaskDetails(f.task.id, { title: 'Running work', pinned: true }),
    ])
    const current = await f.manager.getTask(f.task.id)
    assert.equal(current?.status, TaskStatus.RUNNING)
    assert.equal(current?.title, 'Running work')
    assert.equal(typeof current?.pinnedAt, 'number')
    assert.ok((current?.stateRevision ?? 0) >= 1)
    assert.equal(updated.title, 'Running work')
  })

  it('does not notify or mutate when task detail persistence fails', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-record-visibility-failing-'))
    roots.push(root)
    const backing = new TaskStore(root)
    let writes = 0
    const failing: TaskStorePort = {
      initialize: () => backing.initialize(),
      load: scope => backing.load(scope),
      save: async (scope, tasks) => { if (writes++ === 0) return backing.save(scope, tasks); throw new Error('persistence failure') },
    }
    const updates: ClientTask[] = []
    const manager = new TaskManager(root, { taskListUpdated() {}, taskUpdated(task) { updates.push(task) } }, failing)
    await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
    const task = await manager.createTask('original', 'goal')
    updates.length = 0
    await assert.rejects(manager.updateTaskDetails(task.id, { title: 'must not persist', pinned: true }))
    const current = await manager.getTask(task.id)
    assert.equal(current?.title, 'original')
    assert.equal(current?.pinnedAt ?? null, null)
    assert.deepEqual(updates, [])
  })

  it('notifies removal immediately without deleting task history or generated files', async () => {
    const f = await fixture()
    await f.manager.updateTaskStatus(f.task.id, TaskStatus.PAUSED)
    f.lists.length = 0
    await f.service.delete(f.task.id)
    assert.equal(f.lists.length, 1, 'Archive must notify the renderer that the record was removed.')
    assert.deepEqual(f.lists[0], [])
    assert.deepEqual(await f.service.list(), [])
    assert.equal((await f.manager.getTask(f.task.id))?.id, f.task.id)
    assert.deepEqual(await f.store.readAsset(owner, f.task.id, f.asset.localAssetId), MOCK_MEDIA_PNG)
    assert.equal(await readFile(f.deliverable, 'utf8'), 'User deliverable must survive record deletion.')
  })

  it('does not re-add an archived record when its original run emits another update', async () => {
    const f = await fixture()
    await f.manager.admitTask(f.task.id, 'run-a')
    await f.manager.updateTaskStatus(f.task.id, TaskStatus.RUNNING)
    await f.service.delete(f.task.id)
    f.updates.length = 0
    await f.manager.addTaskLog(f.task.id, 'Original run still has a durable receipt.')
    assert.deepEqual(f.updates, [])
    assert.equal((await f.manager.getTask(f.task.id))?.activeRunId, 'run-a')
  })

  it('keeps archived records out of a list pushed after an unrelated deletion', async () => {
    const f = await fixture()
    await f.service.delete(f.task.id)
    const other = await f.manager.createTask('another record', 'goal')
    await f.manager.updateTaskStatus(other.id, TaskStatus.PAUSED)
    assert.equal(await f.manager.deleteTask(other.id), true)
    assert.deepEqual(f.lists.at(-1), [])
  })

  it('loads existing archive markers before publishing records after restart', async () => {
    const f = await fixture()
    await f.manager.updateTaskStatus(f.task.id, TaskStatus.PAUSED)
    // Covers markers written by older clients, before push filtering existed.
    await f.media.archiveIfMedia(f.task.id)
    f.lists.length = 0
    const reloaded = new TaskManager(f.root, f.notifier)
    await reloaded.setCurrentUser(owner.memberId, owner.enterpriseId)
    assert.equal(f.lists.some(list => list.some(task => task.id === f.task.id)), false)
    assert.equal((await reloaded.getTask(f.task.id))?.id, f.task.id)
    f.updates.length = 0
    await reloaded.addTaskLog(f.task.id, 'Recovery evidence remains available internally.')
    assert.deepEqual(f.updates, [])
    assert.equal(await readFile(f.deliverable, 'utf8'), 'User deliverable must survive record deletion.')
  })

  it('does not apply one owner archive marker to another owner with the same task id', async () => {
    const f = await fixture()
    await f.service.delete(f.task.id)
    const other = { memberId: 'member-b', enterpriseId: 'enterprise-b' }
    const snapshots = new TaskStore(f.root)
    await snapshots.initialize()
    await snapshots.save(other, [{ ...f.task, ownerId: other.memberId, ownerEnterpriseId: other.enterpriseId }])
    await f.manager.setCurrentUser(other.memberId, other.enterpriseId)
    assert.equal(f.lists.at(-1)?.[0]?.id, f.task.id)
    await f.manager.addTaskLog(f.task.id, 'Another owner visible record.')
    assert.equal(f.updates.at(-1)?.ownerId, other.memberId)
    await f.manager.setCurrentUser(owner.memberId, owner.enterpriseId)
    assert.deepEqual(f.lists.at(-1), [])
  })

  it('does not republish a record when its archive marker cannot be read', async () => {
    const f = await fixture()
    await f.media.archiveIfMedia(f.task.id)
    const archive = join(new ScopePath(f.root).mediaRoot(owner, f.task.id), 'archive.json')
    await writeFile(archive, '{broken')
    f.lists.length = 0
    const reloaded = new TaskManager(f.root, f.notifier)
    await reloaded.setCurrentUser(owner.memberId, owner.enterpriseId)
    assert.equal(f.lists.some(list => list.some(task => task.id === f.task.id)), false)
    assert.equal((await reloaded.getTask(f.task.id))?.id, f.task.id)
  })

  it('does not restore the signed-out owner when archive reads finish late', async () => {
    const f = await fixture()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const reloaded = new TaskManager(f.root, f.notifier, undefined, undefined, undefined, {
      async isArchived() { enter(); await released; return true },
    })
    const loading = reloaded.setCurrentUser(owner.memberId, owner.enterpriseId)
    const rejected = assert.rejects(loading, /Task scope changed/)
    await entered
    reloaded.clearCurrentUser()
    release()
    await rejected
    assert.equal(reloaded.getCurrentUserScope(), null)
    assert.deepEqual(f.lists.at(-1), [])
  })

  it('rejects stale-owner or missing-task visibility changes', async () => {
    const f = await fixture()
    assert.throws(() => f.manager.hideTaskRecord('missing', owner), /Task not found/)
    assert.throws(() => f.manager.hideTaskRecord(f.task.id, { ...owner, memberId: 'other' }), /authenticated task scope/)
    f.manager.clearCurrentUser()
    assert.throws(() => f.manager.hideTaskRecord(f.task.id, owner), /authenticated task scope/)
  })
})
