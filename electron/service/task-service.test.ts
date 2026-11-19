import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from '../runtime/task-manager'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { WorkspaceDirectoryStore } from '../data/workspace-directory-store'
import { TaskService, type TaskServiceDependencies } from './task-service'
import { MediaStore } from '../data/media-store'
import type { EmployeeRuntimeSnapshot } from '../common/platform/employee-runtime-contract'
import { ConversationService, type ConversationServiceDependencies } from './conversation-service'
import { AppError } from '../errors/app-error'

const owner: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const workspaceNames = { enterpriseName: 'Acme Studio', memberName: 'Alice' }

describe('task context usage access', () => {
  it('checks task ownership and rejects results after account switching', async () => {
    let current = { ...owner }
    let exists = true
    let finish!: (value: { tokens: number; contextWindow: number; percent: number }) => void
    let reads = 0
    const service = new TaskService({
      scope: { currentScope: () => current }, taskManager: { getTask: async () => exists ? { id: 'task' } : null },
      execution: async () => ({ getContextUsage: async () => { reads++; return new Promise(resolve => { finish = resolve }) } }),
    } as unknown as TaskServiceDependencies)
    exists = false
    await assert.rejects(service.contextUsage('task'), { code: 'NOT_FOUND' })
    assert.equal(reads, 0)
    exists = true
    const pending = service.contextUsage('task')
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    current = { memberId: 'different-member', enterpriseId: owner.enterpriseId }
    finish({ tokens: 32000, contextWindow: 128000, percent: 25 })
    await assert.rejects(pending, { code: 'AUTH_REQUIRED' })
  })
})

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

  it('creates distinct task workspaces beneath the configured default parent and can clear it', async () => {
    const { userDataDir, manager, service } = await harness()
    const parent = join(userDataDir, 'configured-parent')
    await mkdir(parent)
    await service.setDefaultWorkspaceDirectory(parent)
    assert.equal(await service.getDefaultWorkspaceDirectory(), parent)
    assert.equal(await service.prepareDirectorySelection(), parent)
    const first = await manager.createTask('first', 'goal')
    const second = await manager.createTask('second', 'goal')
    assert.equal(first.workDir, join(parent, first.id))
    assert.equal(second.workDir, join(parent, second.id))
    assert.notEqual(first.workDir, second.workDir)
    const restored = new TaskManager(userDataDir)
    await restored.setCurrentUser(owner.memberId, owner.enterpriseId, workspaceNames)
    assert.equal(await restored.getDefaultWorkspaceDirectory(), parent)
    const chosen = join(userDataDir, 'one-off')
    assert.equal((await manager.createTask('chosen', 'goal', chosen)).workDir, chosen)
    await service.setDefaultWorkspaceDirectory(null)
    assert.equal(await service.getDefaultWorkspaceDirectory(), null)
    const fallback = await manager.createTask('fallback', 'goal')
    assert.equal(fallback.workDir, join(new ScopePath(userDataDir).defaultWorkspaceRoot(owner, workspaceNames), fallback.id))
    assert.equal(await service.prepareDirectorySelection(), new ScopePath(userDataDir).defaultWorkspaceRoot(owner, workspaceNames))
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
import type { ClientTask, TaskExecutionEvent } from '../../src/shared/types'

const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const task: ClientTask = { id: 'task-a', title: 'Task', prompt: 'plain', status: 'pending', workDir: null, createdAt: 1, startedAt: null, completedAt: null, error: null, files: [], logs: [], ownerId: scope.memberId, ownerEnterpriseId: scope.enterpriseId, subscriptionId: 'sub-a', activeRunId: null }
const missing = { state: 'missing' as const }

describe('task timeline admission', () => {
  it('returns an empty timeline for the exact queued run before its record is created', async () => {
    const service = harness({
      taskManager: { async getTask() { return { ...task, activeRunId: 'queued-run' } } },
      taskRunStore: { async get() { return null } },
    })
    assert.deepEqual(await service.timeline(task.id, 'queued-run'), [])
  })

  it('still rejects missing historical runs and missing records of started or finished tasks', async () => {
    for (const status of ['pending', 'running', 'failed', 'completed'] as const) {
      const service = harness({
        taskManager: { async getTask() { return { ...task, status, activeRunId: 'queued-run' } } },
        taskRunStore: { async get() { return null } },
      })
      await assert.rejects(service.timeline(task.id, 'old-run'), { code: 'NOT_FOUND' })
      if (status !== 'pending') await assert.rejects(service.timeline(task.id, 'queued-run'), { code: 'NOT_FOUND' })
    }
  })

  it('reads persisted events even while the task is pending', async () => {
    const events = [{ type: 'arrangement_node_completed' }]
    const service = harness({
      taskManager: { async getTask() { return { ...task, activeRunId: 'queued-run' } } },
      taskRunStore: { async get() { return { runId: 'queued-run' } }, events: {
        async getTimeline(receivedScope: unknown, taskId: string, runId: string) {
          assert.deepEqual(receivedScope, scope)
          assert.equal(taskId, task.id)
          assert.equal(runId, 'queued-run')
          return events
        },
      } },
    })
    assert.deepEqual(await service.timeline(task.id, 'queued-run'), events)
  })

  it('recovers labels from the exact archived run for compact skill reads without opening a skill file', async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-skill-display-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'runtime', 'skills-v2', 'a'.repeat(64), 'opaque', 'nested')
    const runId = 'read-run'
    const installed = { capabilityId: 'cap-a', versionId: 'mine', baseSkillVersionId: 'v1', version: 'personal',
      source: 'owner-local' as const, name: 'opaque', description: 'Local description', content: 'PRIVATE CONTENT',
      sha256: 'a'.repeat(64), path }
    const runtimeSnapshot: EmployeeRuntimeSnapshot = {
      manifestVersion: 1, ...scope, subscriptionId: 'sub-a', employeeId: 'employee-a', templateVersion: '1',
      employeeVersion: '1', maxSteps: 10, systemPrompt: '', modelId: 'model-a', allowedModels: ['model-a'],
      skills: [installed], approvedSkills: [
        { capabilityId: 'cap-a', versionId: 'v1', version: '1', name: '促销机制设计',
          description: '设计套装优惠', content: 'PRIVATE APPROVED CONTENT' },
      ],
    }
    const media = new MediaStore(root)
    await media.saveSnapshot(scope, { version: 1, owner: scope, taskId: task.id, runId, subscriptionId: 'sub-a',
      systemPrompt: '', skills: [installed].map(({ path, sha256, version }) => ({ path, sha256, version })),
      capabilities: null, runtimeSnapshot, createdAt: 1 })
    const start = (sequence: number, file: string, subscriptionId = 'sub-a', toolName = 'read'): TaskExecutionEvent => ({
      taskId: task.id, runId, sequence, subscriptionId, occurredAt: sequence, type: 'tool_execution_start',
      data: { toolId: `read-${sequence}`, toolName, input: { path: file } },
    })
    const events = [start(1, join(path, 'SKILL.md')), start(2, join(root, 'opaque', 'nested', 'SKILL.md')),
      start(3, join(path, 'SKILL.md'), 'sub-b'), start(4, join(path, 'SKILL.md'), 'write')]
    const service = harness({ taskRunStore: { async get() { return { subscriptionId: 'sub-a' } },
      events: { async getTimeline() { return events } } }, runSnapshots: media })
    const result = await service.timeline(task.id, runId)
    assert.deepEqual(result[0].data, { ...events[0].data as object,
      skillDetails: { name: '促销机制设计', description: '设计套装优惠' } })
    assert.deepEqual(result.slice(1), events.slice(1))
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE CONTENT|PRIVATE APPROVED CONTENT|runtimeSnapshot/)
    assert.deepEqual(await service.timeline(task.id, 'no-snapshot'), events)
  })

  it('does not return projected skill details if the account changes while reading the archived run', async () => {
    const entered = deferred(), resume = deferred()
    let current = scope
    const service = harness({
      scope: { currentScope: () => current },
      taskRunStore: { async get() { return { subscriptionId: 'sub-a' } }, events: { async getTimeline() {
        return [{ taskId: task.id, runId: 'read-run', subscriptionId: 'sub-a', type: 'tool_execution_start',
          data: { toolName: 'read', input: { path: join(tmpdir(), 'skill', 'SKILL.md') } } }]
      } } },
      runSnapshots: { async getSnapshot() { entered.resolve(); await resume.promise; return null } },
    })
    const result = assert.rejects(service.timeline(task.id, 'read-run'), { code: 'AUTH_REQUIRED' })
    await entered.promise
    current = { ...scope, memberId: 'member-b' }
    resume.resolve()
    await result
  })
})

describe('task start failure recording', () => {
  it('does not replace an existing failure when the media replay guard rejects the retry', async () => {
    let recorded = false
    const guarded = harness({
      taskManager: { async getTask() { return task }, async recordStartFailure() { recorded = true } },
      conversationQueue: { async resume() { throw new AppError('MEDIA_REPLAY_BLOCKED') } },
    })
    await assert.rejects(guarded.retry(task.id), { code: 'MEDIA_REPLAY_BLOCKED' })
    assert.equal(recorded, false)
  })
  for (const fails of [false, true]) it(`routes an empty conversation retry through its queue and records admission failure=${fails}`, async () => {
    const failure = new Error('worker unavailable')
    let recorded: string | undefined
    let resumed = 0
    const service = harness({
      taskManager: { async getTask() { return task }, async recordStartFailure(_id: string, error: string) { recorded = error } },
      conversationQueue: {
        async view() { return { paused: true, items: [], failed: null } },
        async resume(id: string, options: unknown) {
          assert.equal(id, task.id); assert.deepEqual(options, { retryOriginal: true }); resumed++
          if (fails) throw failure
        },
      },
      execution: async () => { assert.fail('conversation retry must be owned by the queue') },
    })
    if (fails) await assert.rejects(service.retry(task.id), error => error === failure)
    else await service.retry(task.id)
    assert.equal(resumed, 1)
    assert.equal(recorded, fails ? 'Error: worker unavailable' : undefined)
  })

  it('records sanitized failure details when initial execution cannot start', async () => {
    const failure = new Error('Bearer private-secret')
    let recorded: { taskId: string; error: string } | undefined
    const service = harness({
      taskManager: {
        async getTask() { return task },
        async recordStartFailure(taskId: string, error: string) { recorded = { taskId, error }; return true },
      },
      taskMetadataStore: { async load() { return null } },
      execution: async () => ({ async executeTask() { throw failure } }),
    })

    await assert.rejects(service.execute(task.id), error => error === failure)
    assert.deepEqual(recorded, { taskId: task.id, error: 'Error: Bearer [redacted]' })
  })

  it('records retry admission failures and keeps the retry context', async () => {
    const failure = new Error('worker unavailable')
    let recorded: { taskId: string; error: string } | undefined
    let retryOptions: unknown
    const service = harness({
      taskManager: {
        async getTask() { return { ...task, subscriptionId: 'sub-a' } },
        async recordStartFailure(taskId: string, error: string) { recorded = { taskId, error }; return true },
      },
      taskMetadataStore: { async load() { return { version: 1, taskId: task.id, kind: 'conversation', participantSubscriptionIds: ['sub-a'], currentSubscriptionId: 'sub-a', createdAt: 1 } } },
      employees: { async authorize() { return true } },
      execution: async () => ({ async retryTask(_taskId: string, options: unknown) { retryOptions = options; throw failure } }),
    })

    await assert.rejects(service.retry(task.id), error => error === failure)
    assert.deepEqual(retryOptions, { conversation: true })
    assert.deepEqual(recorded, { taskId: task.id, error: 'Error: worker unavailable' })
  })
})

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
    workPlans: { async diagnose() { return missing }, async get() { return null } },
    employees: { async authorize() { return true } },
    taskRunStore: {}, execution: async () => ({}), ...extra,
  } as unknown as TaskServiceDependencies)
}

it('queue reads support legacy conversations and reject arrangements or unavailable type evidence', async () => {
  let reads = 0
  const make = (tasks: TaskService) => new ConversationService({
    scope: { currentScope: () => scope }, tasks,
    queue: { async view() { reads++; return { paused: false, items: [], failed: null } } },
  } as unknown as ConversationServiceDependencies)
  assert.deepEqual(await make(harness()).queue({ taskId: task.id, action: 'get' }), { paused: false, items: [], failed: null })
  await assert.rejects(() => make(harness({ workPlans: { async diagnose() { return { state: 'found', value: { mode: 'auto' } } } } })).queue({ taskId: task.id, action: 'get' }))
  await assert.rejects(() => make(harness({ workPlans: undefined })).queue({ taskId: task.id, action: 'get' }))
  assert.equal(reads, 1)
})

it('retries a general conversation without employee authorization or skill preparation', async () => {
  let retryOptions: unknown
  const service = harness({
    taskMetadataStore: { async load() { return { kind: 'conversation' } } },
    workPlans: { async get() { return { mode: 'conversation', conversation: { kind: 'general', modelId: 'model-a' } } } },
    employees: { async authorize() { assert.fail('general retry must use model-only runtime authorization') } },
    execution: async () => ({ async retryTask(taskId: string, options: unknown) { assert.equal(taskId, task.id); retryOptions = options } }),
  })
  await service.retry(task.id)
  assert.deepEqual(retryOptions, { conversation: true })
})

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
  const hidden: string[] = []
  const service = harness({
    taskManager: { async getTask() { return task }, async getAllTasks() { return [task] }, async deleteTask() { deletions++; return true },
      hideTaskRecord(id: string, receivedScope: unknown) { assert.deepEqual(receivedScope, scope); hidden.push(id) } },
    media: {
      async archiveIfMedia(id: string) { archived.add(id); return true },
      async isArchived(id: string) { return archived.has(id) },
    },
  })
  await service.delete(task.id)
  assert.equal(deletions, 0)
  assert.deepEqual(hidden, [task.id])
  assert.deepEqual(await service.list(), [])
  assert.equal((await service.get(task.id)).id, task.id)
})

it('does not hide a record when archival fails or the authenticated owner changes', async () => {
  for (const changedScope of [false, true]) {
    let activeScope = scope
    let hidden = false
    const service = harness({
      scope: { currentScope: () => activeScope },
      taskManager: { hideTaskRecord() { hidden = true } },
      media: { async archiveIfMedia() {
        if (!changedScope) throw new Error('archive write failed')
        activeScope = { ...scope, memberId: 'member-b' }
        return true
      } },
    })
    await assert.rejects(service.delete(task.id), changedScope ? { code: 'AUTH_REQUIRED' } : /archive write failed/)
    assert.equal(hidden, false)
  }
})

it('preserves ordinary task deletion and the running-task guard when media is absent', async () => {
  let allowed = true
  let activeRunId: string | null = 'run-a'
  let deletions = 0
  const service = harness({
    taskManager: {
      async deleteTask() { deletions++; return allowed },
      async getTask() { return { ...task, activeRunId } },
    },
    media: { async archiveIfMedia() { return false } },
  })
  await service.delete(task.id)
  allowed = false
  await assert.rejects(service.delete(task.id), { code: 'INVALID_STATE', message: '任务正在执行，无法删除。' })
  activeRunId = null
  await assert.rejects(service.delete(task.id), { code: 'INVALID_STATE', message: '工作状态已变化，无法删除，请刷新后重试。' })
  assert.equal(deletions, 3)
})
