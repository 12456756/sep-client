import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkPlanStore } from '../data/work-plan-store'
import { ScheduledTaskStore } from '../data/scheduled-task-store'
import { effectivePermissionPolicy, type WorkPlan } from '../domain/arrangement-plan'
import { ScheduledWorkSource } from './scheduled-work-source'
import { ScheduledTaskService } from './scheduled-task-service'
import { validateScheduledSource } from '../domain/scheduled-work-source'
import { ScopePath } from '../data/scope-path'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
test('confirmed work becomes an independent enabled schedule without planning, and retries never duplicate it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-schedule-work-'))
  const plans = new WorkPlanStore(root), storage = new ScheduledTaskStore(root)
  let authorized = true
  const original: WorkPlan = { id: 'original', schemaVersion: 2, sourceDraftId: 'draft', sourceDraftRevision: 1,
    owner: scope, mode: 'auto', title: 'Original title', goal: 'Produce a report', conversation: null,
    nodes: [{ id: 'writer', subscriptionId: 'sub', modelId: 'model', title: 'Write', objective: 'Report', instruction: 'Write a report', expectedOutput: 'File',
      deliverables: [{ id: 'report', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Findings'], acceptanceCriteria: ['Has findings'] }],
      dependsOn: [], skillIds: ['old-skill'], knowledgeQuery: 'report background' }],
    workspace: { mode: 'shared', path: root }, permissions: { ...effectivePermissionPolicy({ preset: 'workspace-edit' }), deniedPaths: ['D:/private'], commandPolicy: 'disabled' },
    confirmedInputs: ['Confirmed business requirement'], planHash: 'original-hash', createdAt: 1 }
  await plans.save(scope, original)
  const source = new ScheduledWorkSource({ workPlans: plans, storage,
    tasks: { getTask: async id => id === 'original' ? { id } : null },
    metadata: { load: async () => ({ kind: 'arrangement' }) },
  })
  const service = new ScheduledTaskService({ repository: storage, scope: { currentScope: () => scope }, source, now: () => 1000,
    employee: async () => { if (!authorized) return null; return {} },
    planner: async () => { assert.fail('must never replan an imported work') },
    runner: { async prepare() {}, async launch() {}, async inspect() { return { state: 'running' } }, async cancel() {} } })
  t.after(async () => { service.stop(); await rm(root, { recursive: true, force: true }) })
  const context = await service.workSource('original')
  const request = { requestId: '11111111-1111-4111-8111-111111111111', taskId: 'original', expectedPlanHash: context.planHash,
    name: 'Scheduled title', scheduledAt: 2000, timezone: 'Asia/Shanghai', recurrence: { frequency: 'daily' as const, interval: 1 } }
  const [created, repeated] = await Promise.all([service.createFromWork(request), service.createFromWork(request)])
  assert.equal(created.id, repeated.id)
  assert.equal(created.enabled, true)
  assert.equal(created.nextRunAt, 2000)
  assert.equal((await service.list()).definitions.length, 1)
  for (const mutation of [
    { mode: 'conversation' }, { owner: { memberId: 'other', enterpriseId: 'enterprise' } },
    { permissions: { ...original.permissions, preset: 'read-only' } },
    { nodes: [null] },
    { nodes: [{ ...original.nodes[0], objective: undefined }] },
    { nodes: [{ ...original.nodes[0], mediaRequirements: [{ id: 'video', kind: 'video', operation: 'edit', inputFrom: { artifactId: 'old-output' } }] }] },
    { nodes: [{ ...original.nodes[0], inputRefs: [{ kind: 'attachment', required: true, purpose: 'reference', attachment: { attachmentId: 'missing', sha256: 'a'.repeat(64) } }] }] },
  ]) assert.throws(() => validateScheduledSource({ ...original, ...mutation } as WorkPlan, scope))
  assert.equal(created.plan?.kind, 'arrangement')
  if (created.plan?.kind !== 'arrangement') assert.fail('arrangement required')
  const copied = await source.load(scope, created.plan.source!)
  assert.deepEqual(copied.permissions, original.permissions)
  assert.deepEqual(copied.confirmedInputs, original.confirmedInputs)
  assert.equal(copied.nodes[0]!.knowledgeQuery, 'report background')
  assert.deepEqual(copied.nodes[0]!.skillIds, [])
  original.nodes[0]!.instruction = 'Changed original'
  await plans.save(scope, original)
  assert.equal((await source.load(scope, created.plan.source!)).nodes[0]!.instruction, 'Write a report')
  assert.equal((await service.createFromWork(request)).id, created.id)
  await assert.rejects(service.createFromWork({ ...request, name: 'Different' }), { code: 'CONFLICT' })
  await assert.rejects(service.createFromWork({ ...request, requestId: '22222222-2222-4222-8222-222222222222' }), { code: 'DRAFT_REVISION_CONFLICT' })
  const edited = await service.editFromWork({ id: created.id, expectedRevision: created.revision, name: 'Edited', scheduledAt: 3000, timezone: 'UTC', recurrence: { frequency: 'once', interval: 1 } })
  assert.equal(edited.enabled, true)
  assert.equal(edited.id, created.id)
  assert.deepEqual(edited.plan, created.plan)
  await assert.rejects(service.edit(created.id, edited.revision, { ...edited.input, goal: 'Injected goal' }), { code: 'INVALID_STATE' })
  authorized = false
  await assert.rejects(service.createFromWork({ ...request, requestId: '33333333-3333-4333-8333-333333333333', expectedPlanHash: (await service.workSource('original')).planHash }), { code: 'EMPLOYEE_UNAVAILABLE' })
  assert.equal((await service.list()).definitions.length, 1)
  const sourceRef = created.plan.source!
  const corrupted = await source.load(scope, sourceRef)
  corrupted.nodes[0]!.instruction = 'Corrupted snapshot'
  await storage.saveTemplate(scope, corrupted)
  await assert.rejects(source.load(scope, sourceRef), { code: 'PERSISTENCE_ERROR' })
  const file = join(new ScopePath(root).ownerRoot(scope), 'scheduled', 'templates', `${sourceRef.templateId}.json`)
  const envelope = JSON.parse(await readFile(file, 'utf8')) as { plan: WorkPlan }
  envelope.plan.nodes[0]!.instruction = 'Corrupted before registration'
  await writeFile(file, JSON.stringify(envelope))
  await assert.rejects(storage.loadTemplate(scope, sourceRef.templateId), { code: 'PERSISTENCE_ERROR' })
})

test('copy failure cannot enable a definition; a stopped service discards late results', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-work-schedule-failure-'))
  const storage = new ScheduledTaskStore(root)
  let release!: () => void
  const source = { context: async () => ({ taskId: 'work', title: 'Report', planHash: 'a'.repeat(64), subscriptionId: 'sub', modelId: 'model' }),
    capture: async (_scope: unknown, _id: string, _hash: string, _definition: string, guard: () => void) => {
      await new Promise<void>(resolve => { release = resolve })
      guard()
      throw new Error('copy failed')
    } } as unknown as ScheduledWorkSource
  const service = new ScheduledTaskService({ repository: storage, scope: { currentScope: () => scope }, source, now: () => 1000,
    employee: async () => ({}), planner: async () => { assert.fail('unused') },
    runner: { async prepare() {}, async launch() { assert.fail('must not run') }, async inspect() { return { state: 'missing' } }, async cancel() {} } })
  t.after(async () => { service.stop(); await rm(root, { recursive: true, force: true }) })
  const request = { requestId: '11111111-1111-4111-8111-111111111111', taskId: 'work', expectedPlanHash: 'a'.repeat(64), name: 'Report', scheduledAt: 2000, timezone: 'UTC', recurrence: { frequency: 'once' as const, interval: 1 } }
  const failed = service.createFromWork(request)
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(release)
  release()
  await assert.rejects(failed, /copy failed/)
  assert.equal((await storage.read(scope)).definitions.length, 0)
  release = undefined as unknown as () => void
  const stopped = service.createFromWork(request)
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(release)
  service.stop(); release()
  await assert.rejects(stopped, { code: 'AUTH_REQUIRED' })
  assert.equal((await storage.read(scope)).definitions.length, 0)
})
