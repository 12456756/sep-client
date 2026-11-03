import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScheduleInterpretation, ScheduledCreationRequest } from '../../src/shared/scheduled-creation'
import type { ArrangementWorkPlan, EmployeeWorkPlan } from '../../src/shared/scheduled-tasks'
import { localDateTime } from '../../src/shared/zoned-time'
import { ScheduledTaskStore } from '../data/scheduled-task-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ScheduledCreationService } from '../service/scheduled-creation-service'
import { ScheduledTaskService } from '../service/scheduled-task-service'
import { ScheduledTaskRunner } from '../service/scheduled-task-runner'
import { PiEmployeePlanner } from './pi-employee-planner'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import type { EmployeeRuntimeConfig } from './run-types'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const modelId = 'chosen-model'
const employeePlan: EmployeeWorkPlan = {
  status: 'ready', objective: 'Deliver a report', instruction: 'Write report.txt with verified findings', expectedOutput: 'A usable report file',
  deliverables: [{ id: 'report', name: 'Report', format: 'txt', path: 'report.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Contains verified findings'] }],
}
const automaticPlan: ArrangementWorkPlan = { status: 'ready', kind: 'arrangement', title: 'Research and report', intentAnalysis: null, nodes: [
  { id: 'research', subscriptionId: 'analyst', modelId, title: 'Research', objective: 'Collect evidence', instruction: 'Write evidence.txt with verified findings', expectedOutput: 'Evidence file',
    deliverables: [{ id: 'evidence', name: 'Evidence', format: 'txt', path: 'evidence.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Contains verified findings'] }],
    dependsOn: [], skillIds: [], requiresUserConfirmation: false },
  { id: 'report', subscriptionId: 'writer', modelId, title: 'Report', objective: 'Summarize evidence', instruction: 'Read evidence.txt and write report.txt', expectedOutput: 'Report file',
    deliverables: employeePlan.deliverables, dependsOn: ['research'], skillIds: [], requiresUserConfirmation: false },
] }
const catalog = [
  { subscriptionId: 'analyst', name: 'Analyst', position: 'Research analyst', description: 'Research and verify findings', functionalCategory: 'research', allowedModels: [modelId] },
  { subscriptionId: 'writer', name: 'Writer', position: 'Report writer', description: 'Write reports from evidence', functionalCategory: 'reporting', allowedModels: [modelId] },
]

for (const mode of ['employee', 'auto'] as const) {
  test(`scheduled creation closes the local loop through actual delivery and restart-safe replay: ${mode}`, { timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), `sep-creation-${mode}-`))
    let now = Math.floor(Date.now() / 60000) * 60000
    const referenceNow = now
    const scheduledAt = referenceNow + 3600000
    const timezone = 'Asia/Shanghai'
    const local = localDateTime(scheduledAt, timezone)
    const request: ScheduledCreationRequest = { requestId: randomUUID(),
      message: mode === 'employee' ? `Have Analyst produce report.txt once at ${local} in ${timezone}.`
        : `Research evidence and produce report.txt once at ${local} in ${timezone}.`,
      modelId, workDir: root, timezone, permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
    const interpretation: ScheduleInterpretation = { status: 'ready', task: { title: 'Scheduled report', goal: 'Research and report verified findings',
      deliverables: ['report.txt with verified findings'], execution: { mode, subscriptionId: mode === 'employee' ? 'analyst' : null },
      schedule: { kind: 'once', timezone, localDateTime: local, expression: null, description: 'Run once at the requested local time' } }, questions: [], reasons: [] }
    let interpretations = 0, employeePlans = 0, automaticPlans = 0, workerDisposals = 0
    const executions: string[] = []
    const authorized: string[] = []
    const backends: Array<{ creations: ScheduledCreationService; schedules: ScheduledTaskService; runtime: TaskRuntime }> = []
    t.after(async () => {
      for (const backend of backends) {
        backend.creations.stop(); backend.schedules.stop()
        await backend.runtime.stopAll()
      }
      await rm(root, { recursive: true, force: true })
    })
    const makeBackend = async () => {
      const storage = new ScheduledTaskStore(root)
      const runs = new TaskRunStore(root)
      const tasks = new TaskManager(root, null, undefined, runs)
      const workPlans = new WorkPlanStore(root)
      const metadata = new TaskMetadataStore(root)
      const checkpoints = new ArrangementCheckpointStore(root)
      const owner = { currentScope: () => tasks.getCurrentUserScope() }
      const employee = (subscriptionId: string): EmployeeRuntimeConfig => ({ subscriptionId, modelId, gatewayUrl: 'http://gateway.invalid' })
      const authorize = async (subscriptionId: string, selectedModel = modelId) => {
        assert.ok(catalog.some(item => item.subscriptionId === subscriptionId))
        assert.equal(selectedModel, modelId)
        authorized.push(subscriptionId)
        return { ...employee(subscriptionId), additionalSkillPaths: ['current-authorized-skills'] }
      }
      const planner = new PiEmployeePlanner({ gatewayUrl: 'http://gateway.invalid', workspaceRoot: root,
        getRefreshToken: () => 'test-only', onAuthenticationRequired() {},
        createWorker: options => ({
          async run() {
            assert.equal(options.context.disableTools, true)
            assert.equal(options.context.modelId, modelId)
            assert.equal(await options.onApprovalRequest({} as never), false)
            const interpreting = options.context.fixedSystemPrompt?.startsWith('You interpret natural-language scheduled task creation.')
            if (interpreting) {
              interpretations++
              assert.ok(options.context.fixedSystemPrompt?.includes(String(referenceNow)))
              assert.ok(options.context.fixedSystemPrompt?.includes(request.message))
            } else {
              employeePlans++
              assert.equal(mode, 'employee')
              assert.match(options.context.fixedSystemPrompt ?? '', /report.txt/)
            }
            assert.equal(await options.onResponseSettled?.({ text: JSON.stringify(interpreting ? interpretation : employeePlan), stopReason: 'stop' }), undefined)
          }, async abort() {}, async dispose() {},
        }),
      })
      const runtime = new TaskRuntime({ taskManager: tasks, taskRunStore: runs, workPlanStore: workPlans, arrangementCheckpointStore: checkpoints,
        getRefreshToken: () => 'test-only', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() { assert.fail('No tool approval is requested by the fake worker') },
        resolveEmployee: subscriptionId => employee(subscriptionId), authorizeEmployee: authorize,
        createWorker: options => ({
          async run() {
            assert.equal(options.context.modelId, modelId)
            assert.deepEqual(options.context.additionalSkillPaths, ['current-authorized-skills'])
            assert.ok(options.context.fixedSystemPrompt?.includes(new Date(scheduledAt).toISOString()))
            const node = mode === 'auto' ? automaticPlan.nodes.find(item => item.subscriptionId === options.context.subscriptionId)!
              : { id: 'employee-work', deliverables: employeePlan.deliverables }
            assert.ok(node)
            executions.push(node.id)
            let content = 'Verified research findings'
            if (mode === 'auto' && node.id === 'report') {
              assert.deepEqual(executions, ['research', 'report'])
              content = `Report based on ${await readFile(join(options.context.workspaceDir, 'evidence.txt'), 'utf8')}`
            }
            for (const file of node.deliverables!) await writeFile(join(options.context.workspaceDir, file.path), content, 'utf8')
            const correction = await options.onResponseSettled?.({ text: JSON.stringify({ nodeId: node.id, summary: 'Verified report delivery',
              finalDeliverables: node.deliverables!.map(file => ({ id: file.id, path: file.path })) }), stopReason: 'stop' })
            assert.equal(correction, undefined, 'The actual file must pass the real delivery validator on its first attempt')
          }, async abort() {}, async dispose() { workerDisposals++ },
        }),
      })
      const runner = new ScheduledTaskRunner({ scope: owner, tasks, workPlans, metadata, checkpoints, runs, storage, authorize,
        execution: async () => ({ executeTask: (id, options) => runtime.executeTask(id, options), cancelTask: (id, reason) => runtime.cancelTask(id, reason) }) })
      const schedules = new ScheduledTaskService({ repository: storage, scope: owner, employee: authorize, runner, now: () => now,
        planner: (input, profile, signal) => planner.plan(input, profile, signal),
        arrangementPlanner: async (input, signal) => {
          signal.throwIfAborted(); automaticPlans++
          assert.equal(mode, 'auto')
          assert.equal(input.modelId, modelId)
          assert.match(input.goal, /report.txt/)
          return structuredClone(automaticPlan)
        },
      })
      const creations = new ScheduledCreationService({ repository: storage, scope: owner, schedules, catalog: async () => structuredClone(catalog), authorize,
        validateWorkspace: async directory => { await storage.validateWorkspace(directory) },
        interpret: (input, signal) => planner.interpretCreation(input, signal), now: () => now })
      backends.push({ creations, schedules, runtime })
      await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
      return { storage, runs, tasks, workPlans, metadata, checkpoints, creations, schedules, runtime }
    }

    const backend = await makeBackend()
    const created = await backend.creations.submit(request)
    assert.equal(created.stage, 'completed', created.error ?? 'Creation must enable automatically without a second confirmation')
    assert.equal(created.parsedSubmissionKey, created.submissionKey)
    assert.equal(created.definitionSubmissionKey, created.submissionKey)
    assert.equal(created.referenceNow, referenceNow)
    assert.deepEqual(created.interpretation, interpretation)
    const configured = await backend.schedules.list()
    assert.equal(configured.definitions.length, 1)
    assert.equal(configured.creations?.length, 1)
    assert.equal(configured.occurrences.length, 0)
    assert.equal(configured.definitions[0]!.id, created.definitionId)
    assert.equal(configured.definitions[0]!.enabled, true)
    assert.equal(configured.definitions[0]!.nextRunAt, scheduledAt)
    assert.deepEqual(configured.definitions[0]!.input, created.definitionInput)
    assert.equal(interpretations, 1)
    assert.equal(employeePlans, mode === 'employee' ? 1 : 0)
    assert.equal(automaticPlans, mode === 'auto' ? 1 : 0)
    assert.deepEqual(executions, [])
    assert.deepEqual(await backend.creations.submit(request), created)
    now = scheduledAt - 1
    await backend.schedules.scan()
    assert.equal((await backend.schedules.list()).occurrences.length, 0)
    now = scheduledAt
    await backend.schedules.scan()
    const admitted = (await backend.schedules.list()).occurrences[0]!
    assert.ok(admitted, 'Advancing the injected scheduler clock should admit one occurrence')
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const task = await backend.tasks.getTask(admitted.taskId)
      if (task && ['completed', 'failed', 'interrupted'].includes(task.status) && !task.activeRunId) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const deliveredTask = await backend.tasks.getTask(admitted.taskId)
    assert.equal(deliveredTask?.status, 'completed', JSON.stringify(deliveredTask))
    assert.equal(deliveredTask?.activeRunId, null)
    await backend.schedules.scan()
    const finished = (await backend.schedules.list()).occurrences[0]!
    assert.equal(finished.status, 'completed', JSON.stringify(finished.error))
    assert.equal(finished.attempts.length, 1)
    assert.equal(finished.attempts[0]!.status, 'completed')
    assert.deepEqual(executions, mode === 'auto' ? ['research', 'report'] : ['employee-work'])
    assert.equal(workerDisposals, executions.length)
    assert.ok(deliveredTask?.scheduledAdmission)
    assert.equal(deliveredTask?.scheduledOrigin?.occurrenceId, finished.id)
    assert.match(await readFile(join(deliveredTask!.workDir!, 'report.txt'), 'utf8'), /Verified research findings/)
    const workPlan = await backend.workPlans.get(scope, finished.taskId)
    assert.equal(workPlan?.mode, mode === 'auto' ? 'auto' : 'manual')
    assert.deepEqual(workPlan?.nodes.map(node => [node.id, node.dependsOn]), mode === 'auto' ? [['research', []], ['report', ['research']]] : [['employee-work', []]])
    assert.equal(workPlan?.scheduledOrigin?.definitionId, created.definitionId)
    const checkpoint = await backend.checkpoints.get(scope, finished.taskId)
    assert.equal(checkpoint?.state.status, 'completed')
    for (const node of checkpoint!.state.nodes) {
      assert.equal(node.delivery?.validationAttempts, 1)
      assert.deepEqual(node.delivery?.issues, [])
      assert.equal(node.delivery?.finalFiles.length, 1)
      for (const file of node.delivery!.finalFiles) {
        const bytes: Buffer = await readFile(join(deliveredTask!.workDir!, file.path))
        assert.equal(file.size, bytes.length)
        assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
      }
    }
    const runHistory = await backend.runs.list(scope, finished.taskId)
    assert.equal(runHistory.length, executions.length + 1)
    assert.ok(runHistory.every(run => run.outcome === 'completed'))
    const parent = runHistory.find(run => !run.arrangementNodeId)!
    const timeline = await backend.runs.events.getTimeline(scope, finished.taskId, parent.id)
    assert.equal(timeline.filter(event => event.type === 'arrangement_node_completed').length, executions.length)
    assert.equal(timeline.filter(event => event.type === 'arrangement_delivery_checked').length, executions.length)
    assert.ok(timeline.every((event, index) => event.sequence > (timeline[index - 1]?.sequence ?? 0)))
    assert.deepEqual((await backend.metadata.load(scope, finished.taskId))?.participantSubscriptionIds, mode === 'auto' ? ['analyst', 'writer'] : ['analyst'])
    assert.ok(authorized.includes('analyst'))
    if (mode === 'auto') assert.ok(authorized.includes('writer'))

    backend.creations.stop(); backend.schedules.stop(); await backend.runtime.stopAll()
    const restarted = await makeBackend()
    await restarted.schedules.recover(); await restarted.creations.recover()
    const replayed = await restarted.creations.submit({ ...request, expectedRevision: 1 })
    assert.deepEqual(replayed, created, 'A stale-revision retry of the identical submission replays its durable result')
    now += 3 * 86400000
    await restarted.schedules.scan(); await restarted.schedules.scan()
    const recovered = await restarted.storage.read(scope)
    assert.equal(recovered.creations?.length, 1)
    assert.equal(recovered.definitions.length, 1)
    assert.equal(recovered.occurrences.length, 1)
    assert.equal(recovered.occurrences[0]!.id, finished.id)
    assert.equal(recovered.occurrences[0]!.status, 'completed')
    assert.equal(recovered.definitions[0]!.enabled, false)
    assert.equal(interpretations, 1)
    assert.equal(employeePlans, mode === 'employee' ? 1 : 0)
    assert.equal(automaticPlans, mode === 'auto' ? 1 : 0)
    assert.equal(executions.length, mode === 'auto' ? 2 : 1)
    assert.deepEqual(await restarted.runs.list(scope, finished.taskId), runHistory)
    assert.deepEqual(await restarted.runs.events.getTimeline(scope, finished.taskId, parent.id), timeline)
    assert.deepEqual(await restarted.workPlans.get(scope, finished.taskId), workPlan)
    assert.deepEqual(await restarted.checkpoints.get(scope, finished.taskId), checkpoint)
    assert.deepEqual((await restarted.tasks.getTask(finished.taskId))?.scheduledAdmission, deliveredTask?.scheduledAdmission)
    assert.match(await readFile(join(deliveredTask!.workDir!, 'report.txt'), 'utf8'), /Verified research findings/)
  })
}
