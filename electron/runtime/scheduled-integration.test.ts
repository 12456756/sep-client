import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArrangementWorkPlan, EmployeeWorkPlan, ScheduleInput, ScheduledOccurrence } from '../../src/shared/scheduled-tasks'
import { ScheduledTaskStore } from '../data/scheduled-task-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ScheduledTaskService } from '../service/scheduled-task-service'
import { ScheduledTaskRunner } from '../service/scheduled-task-runner'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import type { EmployeeRuntimeConfig } from './run-types'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const plan: EmployeeWorkPlan = { status: 'ready', objective: 'Deliver a report', instruction: 'Write the report file', expectedOutput: 'A usable file',
  deliverables: [{ id: 'report', name: 'Report', format: 'txt', path: 'report.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }] }

for (const mode of ['success', 'missing-file', 'invalid-submission', 'admission-uncertain'] as const) {
  test(`scheduled execution uses the existing runtime and validates actual delivery: ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-integration-'))
    const runs = new TaskRunStore(root)
    const tasks = new TaskManager(root, null, undefined, runs)
    const workPlans = new WorkPlanStore(root)
    const metadata = new TaskMetadataStore(root)
    const checkpoints = new ArrangementCheckpointStore(root)
    const storage = new ScheduledTaskStore(root)
    let executions = 0
    let validations = 0
    let skillLoads = 0
    let plannerCalls = 0
    let now = 1000
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'sub', modelId: 'model', gatewayUrl: 'http://gateway.invalid' }
    const runtime = new TaskRuntime({ taskManager: tasks, taskRunStore: runs, workPlanStore: workPlans, arrangementCheckpointStore: checkpoints,
      getRefreshToken: () => 'test-only', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
      resolveEmployee: () => employee,
      authorizeEmployee: async (_id, model) => { assert.equal(model, 'model'); skillLoads++; return { ...employee, additionalSkillPaths: ['current-employee-skills'] } },
      createWorker: options => ({
        async run() {
          executions++
          assert.deepEqual(options.context.additionalSkillPaths, ['current-employee-skills'])
          assert.match(options.context.fixedSystemPrompt ?? '', /report.txt/)
          if (mode === 'success') await writeFile(join(options.context.workspaceDir, 'report.txt'), 'Verified research findings', 'utf8')
          for (let i = 0; i < 5; i++) {
            validations++
            const response = mode === 'invalid-submission' ? { status: 'blocked', reason: 'Required sales input is missing' }
              : { nodeId: 'employee-work', summary: 'Report ready', finalDeliverables: [{ id: 'report', path: 'report.txt' }] }
            const correction = await options.onResponseSettled?.({ text: JSON.stringify(response), stopReason: 'stop' })
            if (!correction) return
            assert.equal(mode, 'missing-file')
          }
          assert.fail('Invalid delivery should have terminated the same-session validation loop')
        },
        async abort() {}, async dispose() {},
      }),
    })
    const runner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks, workPlans, metadata, checkpoints, runs, storage,
      authorize: async () => employee, execution: async () => ({
        executeTask: (id, options) => {
          let checks = 0
          return runtime.executeTask(id, { beforeAdmission: () => {
            options?.beforeAdmission?.()
            if (mode === 'admission-uncertain' && ++checks === 3) throw new Error('Admission state became uncertain')
          } })
        }, cancelTask: (id, reason) => runtime.cancelTask(id, reason),
      }) })
    const makeService = () => new ScheduledTaskService({ repository: new ScheduledTaskStore(root), scope: { currentScope: () => tasks.getCurrentUserScope() },
      employee: async () => employee, planner: async () => { plannerCalls++; return plan }, runner, now: () => now })
    const service = makeService()
    t.after(async () => { service.stop(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) })
    await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
    const input: ScheduleInput = { name: 'Report', goal: 'Produce a report', subscriptionId: 'sub', modelId: 'model', workDir: root,
      scheduledAt: 2000, timezone: 'Asia/Shanghai', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
    const created = await service.create('request', input)
    const planned = await service.plan(created.id, created.revision)
    await service.confirm(created.id, planned.revision)
    now = 2000
    await service.scan()
    let occurrence = (await service.list()).occurrences[0]
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const task = await tasks.getTask(occurrence.taskId)
      const current = (await service.list()).occurrences[0]
      if (current?.status === 'review') break
      if (task && ['completed', 'failed'].includes(task.status) && !task.activeRunId) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await service.scan()
    occurrence = (await service.list()).occurrences[0]
    assert.equal(occurrence.status, mode === 'success' ? 'completed' : 'review')
    assert.equal(executions, 1)
    assert.equal(plannerCalls, 1)
    assert.ok(skillLoads >= 1)
    assert.equal(validations, mode === 'missing-file' ? 5 : 1)
    if (mode === 'success') {
      const task = await tasks.getTask(occurrence.taskId)
      assert.equal(await readFile(join(task!.workDir!, 'report.txt'), 'utf8'), 'Verified research findings')
    } else assert.equal(occurrence.error?.code, 'EXECUTION_UNCERTAIN')
    service.stop()
    const restarted = makeService()
    await restarted.recover(); await restarted.scan(); restarted.stop()
    assert.equal((await restarted.list()).occurrences.length, 1)
    assert.equal(executions, 1)
    assert.equal(plannerCalls, 1)
    const reloaded = new TaskManager(root)
    await reloaded.initialize(); await reloaded.setCurrentUser(scope.memberId, scope.enterpriseId)
    const receipt = await reloaded.getTask(occurrence.taskId)
    assert.equal(receipt?.scheduledOrigin?.occurrenceId, occurrence.id)
    assert.ok(receipt?.scheduledAdmission)
  })
}

test('reserved task IDs are idempotent and durable admission prevents a second execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manager = new TaskManager(root)
  await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  const reservation = { id: 'reserved-task', origin: { definitionId: 'schedule', occurrenceId: 'occurrence' } }
  const [task, simultaneous] = await Promise.all([
    manager.createTask('Title', 'Goal', root, 'sub', reservation),
    manager.createTask('Title', 'Goal', root, 'sub', reservation),
  ])
  assert.equal(simultaneous.id, task.id)
  assert.equal((await manager.createTask('Title', 'Goal', root, 'sub', reservation)).id, task.id)
  await assert.rejects(manager.createTask('Title', 'Goal', root, 'sub', { ...reservation, origin: { ...reservation.origin, occurrenceId: 'other' } }))
  await assert.rejects(manager.admitTask(task.id, 'cancelled', () => { throw new Error('lifecycle changed') }))
  assert.equal((await manager.getTask(task.id))?.scheduledAdmission, undefined)
  await manager.admitTask(task.id, 'first')
  await manager.clearTaskRun(task.id, 'first')
  await assert.rejects(manager.admitTask(task.id, 'second'))
  assert.equal((await manager.getTask(task.id))?.scheduledAdmission?.runId, 'first')
})

test('scheduled preflight rejects missing authorization results before creating a task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-auth-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskManager(root)
  await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
  const runner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks,
    workPlans: new WorkPlanStore(root), metadata: new TaskMetadataStore(root), checkpoints: new ArrangementCheckpointStore(root),
    runs: new TaskRunStore(root), storage: new ScheduledTaskStore(root), authorize: async () => null,
    execution: async () => { throw new Error('must not reach runtime') } })
  const occurrence: ScheduledOccurrence = { id: 'auth-occurrence', definitionId: 'auth-definition', revision: 1, scheduledAt: 2000,
    taskId: 'auth-task', input: { name: 'Report', goal: 'Produce a report', subscriptionId: 'sub', modelId: 'model', workDir: root,
      scheduledAt: 2000, timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } },
    plan, status: 'preparing', firstEligibleAt: 2000, startDeadline: 5000, startedAt: null, finishedAt: null, nextRetryAt: null,
    error: null, attempts: [], stopReason: null }

  await assert.rejects(runner.prepare(occurrence), { code: 'EMPLOYEE_UNAVAILABLE' })
  assert.equal(await tasks.getTask(occurrence.taskId), null)

  for (const missingAuthorization of [undefined, false]) {
    const invalidRunner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks,
      workPlans: new WorkPlanStore(root), metadata: new TaskMetadataStore(root), checkpoints: new ArrangementCheckpointStore(root),
      runs: new TaskRunStore(root), storage: new ScheduledTaskStore(root), authorize: async () => missingAuthorization,
      execution: async () => { throw new Error('must not reach runtime') } })
    await assert.rejects(invalidRunner.prepare({ ...occurrence, id: `auth-${String(missingAuthorization)}`, taskId: `task-${String(missingAuthorization)}` }), { code: 'EMPLOYEE_UNAVAILABLE' })
    assert.equal(await tasks.getTask(`task-${String(missingAuthorization)}`), null)
  }
})

test('scheduled automatic plans preserve a multi-employee DAG in the existing WorkPlan store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-dag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskManager(root)
  await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
  const workPlans = new WorkPlanStore(root)
  const storage = new ScheduledTaskStore(root)
  const authorized: string[] = []
  const runner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks, workPlans,
    metadata: new TaskMetadataStore(root), checkpoints: new ArrangementCheckpointStore(root), runs: new TaskRunStore(root), storage,
    authorize: async subscriptionId => { authorized.push(subscriptionId); return {} }, execution: async () => { throw new Error('not launched in this test') } })
  const arrangement: ArrangementWorkPlan = { status: 'ready', kind: 'arrangement', title: 'Research and report', intentAnalysis: null,
    nodes: [
      { id: 'research', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Research', instruction: 'Gather evidence', expectedOutput: 'Evidence', deliverables: [{ id: 'evidence', name: 'Evidence', format: 'md', path: 'evidence.md', contentOutline: ['Sources'], acceptanceCriteria: ['Cited'] }], dependsOn: [], skillIds: [], requiresUserConfirmation: false },
      { id: 'report', subscriptionId: 'sub-b', modelId: 'model-b', title: 'Report', instruction: 'Write report', expectedOutput: 'Report', deliverables: [{ id: 'report-file', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Complete'] }], dependsOn: ['research'], skillIds: [], requiresUserConfirmation: false },
    ] }
  const input: ScheduleInput = { mode: 'auto', name: 'Report', goal: 'Produce a report', subscriptionId: 'sub-a', modelId: 'model-a', workDir: root,
    scheduledAt: 2000, timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
  const occurrence: ScheduledOccurrence = { id: 'occurrence', definitionId: 'definition', revision: 3, scheduledAt: 2000, taskId: 'scheduled-task',
    input, plan: arrangement, status: 'preparing', firstEligibleAt: 2000, startDeadline: 5000, startedAt: null, finishedAt: null,
    nextRetryAt: null, error: null, attempts: [], stopReason: null }
  await runner.prepare(occurrence)
  const plan = await workPlans.get(scope, occurrence.taskId)
  assert.deepEqual(plan?.nodes.map(node => [node.id, node.subscriptionId, node.dependsOn]), [['research', 'sub-a', []], ['report', 'sub-b', ['research']]])
  assert.deepEqual(authorized, ['sub-a', 'sub-b'])
})
