import { after, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from '../runtime/task-manager'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { AttachmentStore } from '../data/attachment-store'
import { AttachmentService } from './attachment-service'
import { TaskService, type TaskExecutionPort, type TaskServiceDependencies } from './task-service'
import type { WorkPlan } from '../domain/arrangement-plan'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const roots: string[] = []
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sep-rerun-'))
  roots.push(root)
  const manager = new TaskManager(root)
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId, { enterpriseName: 'Acme', memberName: 'Alice' })
  const metadata = new TaskMetadataStore(root)
  const plans = new WorkPlanStore(root)
  const attachments = new AttachmentStore(root)
  const original = await manager.createTask('智能行李箱策划案', '给我一个策划案', undefined, 'sub-a')
  const plan: WorkPlan = {
    id: original.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope,
    mode: 'manual', title: original.title, goal: original.prompt, conversation: null,
    nodes: [{ id: 'n1', subscriptionId: 'sub-a', modelId: 'model', title: '策划', instruction: '编写策划案', expectedOutput: '报告', dependsOn: [], skillIds: [], requiresUserConfirmation: false }],
    workspace: { mode: 'shared', path: original.workDir },
    permissions: { preset: 'read-only', allowedTools: ['read'], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' },
    confirmedInputs: ['使用已确认的要求'], planHash: 'original-hash', createdAt: 1,
  }
  await plans.save(scope, plan)
  await metadata.save(scope, { version: 1, taskId: original.id, kind: 'arrangement', participantSubscriptionIds: ['sub-a'], currentSubscriptionId: 'sub-a', createdAt: 1 })
  await manager.updateTaskStatus(original.id, 'running')
  await manager.updateTaskStatus(original.id, 'completed')
  const executed: string[] = []
  const execution = { async executeTask(id: string) { executed.push(id) } } as unknown as TaskExecutionPort
  const employees = { async authorize() { return true } }
  const deps: TaskServiceDependencies = { scope: { currentScope: () => manager.getCurrentUserScope() }, taskManager: manager, taskRunStore: {} as never, taskMetadataStore: metadata, workPlans: plans,
    employees: employees as unknown as TaskServiceDependencies['employees'], attachments: new AttachmentService(attachments), execution: async () => execution }
  return { manager, metadata, plans, attachments, employees, original, plan, executed, deps, service: new TaskService(deps) }
}

test('re-execution starts a fresh isolated task from the confirmed plan and survives reload', async () => {
  const h = await setup()
  const next = await h.service.rerun(h.original.id, 'request-1')
  assert.notEqual(next.id, h.original.id)
  assert.notEqual(next.workDir, h.original.workDir)
  assert.deepEqual(next.files, [])
  assert.equal(next.activeRunId, null)
  assert.deepEqual(next.executionGroup, { rootTaskId: h.original.id, number: 2 })
  const copied = await h.plans.get(scope, next.id)
  assert.deepEqual(copied?.nodes, h.plan.nodes)
  assert.deepEqual(copied?.confirmedInputs, h.plan.confirmedInputs)
  assert.equal(copied?.workspace.path, next.workDir)
  assert.notEqual(copied?.planHash, h.plan.planHash)
  assert.deepEqual(await h.plans.get(scope, h.original.id), h.plan)
  assert.deepEqual(h.executed, [next.id])
  assert.equal((await new TaskService(h.deps).get(next.id)).executionGroup?.number, 2)
  assert.equal((await h.manager.getTask(h.original.id))?.status, 'completed')
})

test('same request is idempotent after reload; concurrent starts and active group starts are rejected', async () => {
  const h = await setup()
  const [a, b] = await Promise.all([h.service.rerun(h.original.id, 'request-1'), h.service.rerun(h.original.id, 'request-1')])
  assert.equal(a.id, b.id)
  assert.equal((await new TaskService(h.deps).rerun(h.original.id, 'request-1')).id, a.id)
  assert.deepEqual(h.executed, [a.id])
  await assert.rejects(h.service.rerun(h.original.id, 'request-2'), { code: 'INVALID_STATE' })
  await h.manager.updateTaskStatus(a.id, 'running')
  await h.manager.updateTaskStatus(a.id, 'completed')
  const third = await h.service.rerun(a.id, 'request-3')
  assert.deepEqual(third.executionGroup, { rootTaskId: h.original.id, number: 3 })
})

test('re-execution copies frozen attachments even when the import session no longer exists', async () => {
  const h = await setup()
  const session = await h.attachments.begin(scope, { kind: 'draft', draftId: 'draft', expectedRevision: 1 })
  const bytes = Buffer.from('confirmed source material')
  const item = await h.attachments.importBytes(scope, session.sessionId, bytes, 'requirements.txt', 'text/plain')
  const snapshot = await h.attachments.freeze(scope, h.original.id, session.sessionId, [item])
  await h.attachments.cancel(scope, session.sessionId)
  await h.plans.save(scope, { ...h.plan, inputSnapshot: snapshot })
  const next = await h.service.rerun(h.original.id, 'request-1')
  assert.deepEqual(await h.attachments.readTask(scope, next.id, item.attachmentId), bytes)
  assert.deepEqual((await h.plans.get(scope, next.id))?.inputSnapshot?.attachments, snapshot.attachments)
})

test('unavailable employees, missing plans, conversations and other owners cannot create an execution', async () => {
  for (const kind of ['employee', 'plan', 'conversation', 'scope'] as const) {
    const h = await setup()
    if (kind === 'employee') h.employees.authorize = async () => false
    if (kind === 'plan') h.plans.get = async () => null
    if (kind === 'conversation') await h.metadata.save(scope, { version: 1, taskId: h.original.id, kind: 'conversation', participantSubscriptionIds: [], currentSubscriptionId: null, createdAt: 1 })
    if (kind === 'scope') await h.manager.setCurrentUser('other', scope.enterpriseId)
    await assert.rejects(h.service.rerun(h.original.id, 'request-1'))
    assert.deepEqual(h.executed, [])
    if (kind !== 'scope') assert.equal((await h.manager.getAllTasks()).length, 1)
  }
})

test('deleting a topic removes all execution records together and refuses active members', async () => {
  const h = await setup()
  const next = await h.service.rerun(h.original.id, 'request-1')
  // Simulate admission happening just before deletion commits.
  const originalDelete = h.manager.deleteTaskRecords.bind(h.manager)
  h.manager.deleteTaskRecords = async (...args) => {
    await h.manager.updateTaskStatus(next.id, 'running')
    return originalDelete(...args)
  }
  await assert.rejects(h.service.deleteExecutionGroup(next.id), { code: 'INVALID_STATE' })
  assert.equal((await h.manager.getAllTasks()).length, 2)
  h.manager.deleteTaskRecords = originalDelete
  await h.manager.updateTaskStatus(next.id, 'completed')
  await h.service.deleteExecutionGroup(h.original.id)
  assert.equal((await h.manager.getAllTasks()).length, 0)
})

test('a failed plan copy removes the unfinished record and leaves the original usable', async () => {
  const h = await setup()
  const save = h.plans.save.bind(h.plans)
  h.plans.save = async () => { throw new Error('disk unavailable') }
  await assert.rejects(h.service.rerun(h.original.id, 'request-1'), /disk unavailable/)
  assert.deepEqual((await h.manager.getAllTasks()).map(item => item.id), [h.original.id])
  assert.deepEqual(h.executed, [])
  h.plans.save = save
  assert.equal((await h.service.rerun(h.original.id, 'request-1')).executionGroup?.number, 2)
})

test('start rejection keeps a visible failed execution and a repeat request never starts it twice', async () => {
  const h = await setup()
  let starts = 0
  h.deps.execution = async () => ({ async executeTask() { starts++; throw new Error('worker unavailable') } }) as unknown as TaskExecutionPort
  await assert.rejects(h.service.rerun(h.original.id, 'request-1'), /worker unavailable/)
  const next = await h.service.rerun(h.original.id, 'request-1')
  assert.equal(next.executionHealth, 'start-failed')
  assert.equal(next.executionGroup?.number, 2)
  assert.equal(starts, 1)
  assert.ok(await h.plans.get(scope, next.id))
})

test('changing the owner during employee validation cannot create a task for either owner', async () => {
  const h = await setup()
  h.employees.authorize = async () => {
    await h.manager.setCurrentUser('other', scope.enterpriseId)
    return true
  }
  await assert.rejects(h.service.rerun(h.original.id, 'request-1'), { code: 'AUTH_REQUIRED' })
  assert.deepEqual(await h.manager.getAllTasks(), [])
  await h.manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  assert.equal((await h.manager.getAllTasks()).length, 1)
})
