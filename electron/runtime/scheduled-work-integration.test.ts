import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import { TaskRunStore } from '../data/task-run-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ScheduledTaskStore } from '../data/scheduled-task-store'
import { AttachmentStore } from '../data/attachment-store'
import { ScopePath } from '../data/scope-path'
import { AttachmentService } from '../service/attachment-service'
import { ScheduledWorkSource } from '../service/scheduled-work-source'
import { ScheduledTaskRunner } from '../service/scheduled-task-runner'
import { ScheduledTaskService } from '../service/scheduled-task-service'
import { effectivePermissionPolicy, type WorkPlan } from '../domain/arrangement-plan'

for (const mode of ['single', 'multi'] as const) test(`copied ${mode} work survives deletion, runs each cycle once with fresh skills, and blocks revoked authorization`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-work-schedule-integration-'))
  const scope = { memberId: 'm', enterpriseId: 'e' }
  const runs = new TaskRunStore(root), tasks = new TaskManager(root, null, undefined, runs)
  const workPlans = new WorkPlanStore(root), metadata = new TaskMetadataStore(root), checkpoints = new ArrangementCheckpointStore(root)
  const storage = new ScheduledTaskStore(root), attachments = new AttachmentStore(root)
  const source = new ScheduledWorkSource({ workPlans, metadata, tasks, storage, attachments: new AttachmentService(attachments) })
  let now = 1000, executions = 0, authorized = true
  const employee = { subscriptionId: 'sub', modelId: 'model', gatewayUrl: 'http://gateway.invalid', additionalSkillPaths: ['current-skill'] }
  const authorize = async (subscriptionId: string, modelId = 'model') => ({ ...employee, subscriptionId, modelId })
  const runtime = new TaskRuntime({ taskManager: tasks, taskRunStore: runs, workPlanStore: workPlans, arrangementCheckpointStore: checkpoints,
    getRefreshToken: () => 'test-only', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {}, resolveEmployee: () => employee,
    authorizeScheduledEmployee: authorize, authorizeEmployee: authorize,
    createWorker: options => ({ async run() {
      executions++
      assert.deepEqual(options.context.additionalSkillPaths, ['current-skill'])
      const reviewer = options.context.subscriptionId === 'reviewer'
      const nodeId = reviewer ? 'reviewer' : 'writer', fileId = reviewer ? 'review' : 'report', path = `${fileId}.md`
      await writeFile(join(options.context.workspaceDir, path), 'Findings from copied plan')
      const correction = await options.onResponseSettled?.({ text: JSON.stringify({ nodeId, summary: 'Ready', finalDeliverables: [{ id: fileId, path }] }), stopReason: 'stop' })
      assert.equal(correction, undefined)
    }, async abort() {}, async dispose() {} }) })
  const runner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks, workPlans, metadata, checkpoints, runs, storage, source,
    authorize: async subscriptionId => authorized || (mode === 'multi' && subscriptionId === 'sub') ? employee : null, execution: async () => runtime })
  const service = new ScheduledTaskService({ repository: storage, scope: { currentScope: () => tasks.getCurrentUserScope() }, source, now: () => now,
    employee: async () => employee, planner: async () => { assert.fail('no replanning') }, runner })
  t.after(async () => { service.stop(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) })
  await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
  const task = await tasks.createTask('Source report', 'Produce report', root, 'sub')
  const session = await attachments.begin(scope, { kind: 'draft', draftId: 'draft', expectedRevision: 1 })
  const bytes = Buffer.from('Confirmed source bytes')
  const attachment = await attachments.importBytes(scope, session.sessionId, bytes, 'requirements.txt', 'text/plain')
  const snapshot = await attachments.freeze(scope, task.id, session.sessionId, [attachment])
  const plan: WorkPlan = { id: task.id, schemaVersion: 2, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope, mode: 'auto', title: task.title, goal: task.prompt, conversation: null,
    nodes: [{ id: 'writer', subscriptionId: 'sub', modelId: 'model', title: 'Write report', objective: 'Produce a usable report', instruction: 'Write report.md', expectedOutput: 'Report file',
      dependsOn: [], skillIds: ['obsolete-skill'], deliverables: [{ id: 'report', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }] }],
    workspace: { mode: 'shared', path: root }, permissions: { ...effectivePermissionPolicy({ preset: 'workspace-edit' }), commandPolicy: 'disabled', deniedPaths: ['D:/private'] },
    knowledge: { mode: 'none', knowledgeBaseIds: [] }, confirmedInputs: ['Confirmed requirement'], inputSnapshot: snapshot, planHash: 'hash', createdAt: 1 }
  if (mode === 'multi') plan.nodes.push({ ...structuredClone(plan.nodes[0]!), id: 'reviewer', subscriptionId: 'reviewer', title: 'Review report',
    dependsOn: ['writer'], deliverables: [{ id: 'review', name: 'Review', format: 'md', path: 'review.md', contentOutline: ['Review'], acceptanceCriteria: ['Contains review'] }] })
  await workPlans.save(scope, plan)
  await metadata.save(scope, { version: 1, taskId: task.id, kind: 'arrangement', participantSubscriptionIds: ['sub'], currentSubscriptionId: 'sub', createdAt: 1 })
  const context = await service.workSource(task.id)
  const definition = await service.createFromWork({ requestId: '11111111-1111-4111-8111-111111111111', taskId: task.id, expectedPlanHash: context.planHash,
    name: 'Recurring copied report', scheduledAt: 2000, timezone: 'UTC', recurrence: { frequency: 'daily', interval: 1 } })
  // Remove the original task's complete storage, including attachments, after capture.
  await rm(new ScopePath(root).taskDir(scope, task.id), { recursive: true, force: true })
  await rm(new ScopePath(root).attachmentTaskDir(scope, task.id), { recursive: true, force: true })
  const directories: string[] = []
  for (let cycle = 0; cycle < 2; cycle++) {
    now = 2000 + cycle * 86400000
    await service.scan()
    const occurrence = (await service.list()).occurrences.at(-1)!
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const current = await tasks.getTask(occurrence.taskId)
      if (current && ['completed', 'failed'].includes(current.status) && !current.activeRunId) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await service.scan(); await service.scan()
    assert.equal((await service.list()).occurrences.at(-1)!.status, 'completed')
    assert.equal(executions, (cycle + 1) * plan.nodes.length)
    const copied = (await workPlans.get(scope, occurrence.taskId))!
    assert.deepEqual(copied.permissions, plan.permissions)
    assert.deepEqual(copied.confirmedInputs, plan.confirmedInputs)
    assert.deepEqual(copied.knowledge, plan.knowledge)
    assert.deepEqual(copied.nodes[0]!.skillIds, [])
    assert.deepEqual(await attachments.readTask(scope, occurrence.taskId, attachment.attachmentId), bytes)
    assert.notEqual(copied.inputSnapshot!.snapshotId, snapshot.snapshotId)
    directories.push(copied.workspace.path!)
  }
  assert.notEqual(directories[0], directories[1])
  await service.recover(); await service.scan()
  assert.equal(executions, 2 * plan.nodes.length)
  authorized = false; now += 86400000
  await service.scan()
  const blocked = (await service.list()).occurrences.at(-1)!
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.error?.code, 'EMPLOYEE_UNAVAILABLE')
  assert.equal(await tasks.getTask(blocked.taskId), null)
  assert.equal(executions, 2 * plan.nodes.length)
  assert.equal((await service.list()).definitions[0]!.id, definition.id)
})
