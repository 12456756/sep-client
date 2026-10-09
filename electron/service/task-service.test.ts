import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { TaskService, type TaskServiceDependencies } from './task-service'
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
