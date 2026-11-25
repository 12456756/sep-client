import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CONVERSATION_SCHEDULE_EVENT, REVISE_CONVERSATION_SCHEDULE_TIME, conversationScheduleReceiptSchema,
  type ScheduleInterpretation, type ScheduledCreationRequest } from '../../src/shared/scheduled-creation'
import type { ArrangementWorkPlan, EmployeeWorkPlan } from '../../src/shared/scheduled-tasks'
import { localDateTime } from '../../src/shared/zoned-time'
import { ScheduledTaskStore } from '../data/scheduled-task-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { MediaStore } from '../data/media-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { MediaService } from '../service/media-service'
import { ScheduledCreationService } from '../service/scheduled-creation-service'
import { ScheduledTaskService } from '../service/scheduled-task-service'
import { ScheduledTaskRunner } from '../service/scheduled-task-runner'
import { PiEmployeePlanner } from './pi-employee-planner'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import type { EmployeeRuntimeConfig } from './run-types'
import { AppError } from '../errors/app-error'
import { emptyTextFilenameSchema, type ScheduleInput } from '../../src/shared/scheduled-tasks'
import { occurrenceId } from '../domain/scheduled-task'
import { createScheduledEmptyText } from '../data/arrangement-delivery-files'
import { conversationScheduleToolDefinition } from '../pi/sdk/pi-conversation-schedule'

for (const scenario of ['general', 'empty-text', 'workspace-file'] as const) {
  const workspaceFile = scenario === 'workspace-file'
  const mode = scenario === 'empty-text' ? 'empty-text' : 'general'
  test(workspaceFile ? 'scheduled workspace files reuse one relative name across three distinct daily occurrences'
    : `manual scheduled ${mode} confirms, runs, records delivery, and does not replay on restart`, { timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), `sep-${mode}-`))
    const shutdown: Array<() => Promise<void>> = []
    t.after(async () => {
      for (const stop of shutdown) await stop()
      await rm(root, { recursive: true, force: true })
    })
    let now = Date.UTC(2026, 10, 20, workspaceFile ? 1 : 2, workspaceFile ? 59 : 30)
    const scheduledAt = now + 60000
    const next = scheduledAt + 86400000
    const filename = workspaceFile ? '定时验收.md' : 'report.txt'
    const content = workspaceFile ? '通用助手定时执行成功' : ''
    const workspaceGoal = `在工作目录生成 ${filename}，内容为“${content}”。`
    let calls = 0, planningCalls = 0, authorizeCalls = 0, revoked = false
    let failNodeAuthorization = false, boundAuthorizationCalls = 0
    const grant = async (model: string, expected?: string): Promise<EmployeeRuntimeConfig> => {
      authorizeCalls++
      assert.equal(mode, 'general')
      assert.equal(model, modelId)
      if (expected !== undefined) assert.equal(expected, 'model-grant')
      if (revoked && expected !== undefined) throw new AppError('MODEL_NOT_ALLOWED')
      if (failNodeAuthorization && expected !== undefined && ++boundAuthorizationCalls === 2) throw new AppError('NOT_FOUND')
      return { subscriptionId: 'model-grant', modelId: model, gatewayUrl: 'http://gateway.invalid' }
    }
    const forbidden = () => assert.fail('Neither mode should authorize or replace an employee')
    const makeBackend = async () => {
      const storage = new ScheduledTaskStore(root), runs = new TaskRunStore(root), tasks = new TaskManager(root, null, undefined, runs)
      const workPlans = new WorkPlanStore(root), metadata = new TaskMetadataStore(root), checkpoints = new ArrangementCheckpointStore(root)
      const owner = { currentScope: () => tasks.getCurrentUserScope() }
      const media = new MediaService({ scope: owner, store: new MediaStore(root), getTask: id => tasks.getTask(id),
        authorize: forbidden, requestApproval: forbidden })
      const imagePrepare = t.mock.method(media, 'prepareRun')
      const imageWait = t.mock.method(media, 'waitForRun')
      const video = { prepareRun: async () => assert.fail('A file-only schedule must not initialize video tools'),
        waitForRun: async () => assert.fail('A file-only schedule must not wait for video jobs'), stopTask: async () => {} }
      const planner = new PiEmployeePlanner({ gatewayUrl: 'http://gateway.invalid', workspaceRoot: root, getRefreshToken: () => 'test-only', onAuthenticationRequired() {},
        createWorker: options => ({ async run() {
          assert.equal(mode, 'general'); planningCalls++
          assert.equal(options.context.subscriptionId, 'model-grant')
          assert.equal(options.context.disableTools, true)
          assert.match(options.context.fixedSystemPrompt ?? '', /通用助手/)
          assert.doesNotMatch(options.context.fixedSystemPrompt ?? '', /员工资料：|判断职责/)
          const prompt = options.context.fixedSystemPrompt ?? ''
          if (workspaceFile) {
            assert.ok(prompt.includes(workspaceGoal))
            assert.match(prompt, /默认指本次运行的独立工作目录，也是交付清单相对路径的基准/)
            assert.match(prompt, /不要为默认目录追问或阻塞/)
            assert.match(prompt, /没有授权时明确指出需要配置，不能静默改存/)
          }
          const base = employeePlan.deliverables[0]!
          const file = workspaceFile ? { ...base, path: filename, format: 'md', contentOutline: [content], acceptanceCriteria: ['正文与要求一致'] }
            : { ...base, contentPolicy: 'empty', contentOutline: ['No content'], acceptanceCriteria: ['Exactly zero bytes'] }
          const instruction = workspaceFile ? workspaceGoal : employeePlan.instruction
          await options.onResponseSettled?.({ text: JSON.stringify({ ...employeePlan, instruction, deliverables: [file] }), stopReason: 'stop' })
        }, async abort() {}, async dispose() {} }),
      })
      const runtime = new TaskRuntime({ taskManager: tasks, taskRunStore: runs, workPlanStore: workPlans, arrangementCheckpointStore: checkpoints,
        getRefreshToken: () => 'test-only', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest: forbidden,
        resolveEmployee: forbidden, authorizeScheduledEmployee: forbidden, findEmployeeReplacement: forbidden, authorizeScheduledModel: grant, media, video,
        createWorker: options => ({ async run() {
          assert.equal(mode, 'general'); calls++
          assert.equal(options.context.subscriptionId, 'model-grant')
          assert.equal(options.context.additionalSkillPaths, undefined)
          assert.equal(options.context.employeeProfile, undefined)
          assert.match(options.context.fixedSystemPrompt ?? '', /通用助手节点执行要求/)
          assert.doesNotMatch(options.context.fixedSystemPrompt ?? '', /员工资料：/)
          assert.equal(options.context.mediaTools, undefined)
          assert.equal(options.context.videoTools, undefined)
          if (workspaceFile) assert.match(options.context.fixedSystemPrompt ?? '', /定时验收\.md/)
          await writeFile(join(options.context.workspaceDir, filename), content, { flag: 'wx' })
          assert.equal(await options.onResponseSettled?.({ text: JSON.stringify({ nodeId: 'employee-work', summary: 'Report delivered', finalDeliverables: [{ id: 'report', path: filename }] }), stopReason: 'stop' }), undefined)
        }, async abort() {}, async dispose() {} }),
      })
      const runner = new ScheduledTaskRunner({ scope: owner, tasks, workPlans, metadata, checkpoints, runs, storage, authorize: forbidden, authorizeModel: grant, now: () => now,
        execution: async () => runtime })
      const schedules = new ScheduledTaskService({ repository: storage, scope: owner, employee: forbidden, authorizeModel: grant, runner, now: () => now,
        planner: (input, profile, signal, id) => planner.plan(input, profile, signal, id) })
      shutdown.push(async () => { schedules.stop(); await runtime.stopAll() })
      await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
      return { storage, tasks, workPlans, metadata, checkpoints, runs, schedules, runtime, imagePrepare, imageWait }
    }
    const backend = await makeBackend()
    const recurrence: NonNullable<ScheduleInput['recurrence']> = workspaceFile
      ? { frequency: 'cron', interval: 1, expression: '0 10,11,12 * * *', preset: 'custom' } : { frequency: 'daily', interval: 1 }
    const common = { name: mode, goal: workspaceFile ? workspaceGoal : 'Create a file', workDir: root, timezone: 'Asia/Shanghai', scheduledAt, recurrence,
      permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } } as const
    const input: ScheduleInput = mode === 'general' ? { ...common, mode, modelId } : { ...common, mode, emptyText: { naming: 'scheduled' } }
    const definition = await backend.schedules.create(randomUUID(), input)
    await assert.rejects(backend.schedules.confirm(definition.id, definition.revision))
    const planned = await backend.schedules.plan(definition.id, definition.revision)
    await backend.schedules.confirm(planned.id, planned.revision)
    const waitForTerminalWork = async (instance: typeof backend, taskId: string) => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const task = await instance.tasks.getTask(taskId)
        if (task && ['completed', 'failed', 'interrupted'].includes(task.status) && !task.activeRunId) return task
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.fail(`Timed out waiting for work ${taskId}`)
    }
    if (workspaceFile) {
      const directories = new Set<string>()
      for (const offset of [0, 1, 2]) {
        now = scheduledAt + offset * 3600000
        await backend.schedules.scan()
        const occurrence = (await backend.schedules.list()).occurrences.find(item => item.scheduledAt === now)!
        assert.ok(occurrence)
        const task = await waitForTerminalWork(backend, occurrence.taskId)
        await backend.schedules.scan()
        assert.equal((await backend.schedules.list()).occurrences.find(item => item.id === occurrence.id)?.status, 'completed')
        assert.ok(task.workDir)
        assert.equal(dirname(task.workDir), await fs.realpath(root))
        directories.add(task.workDir)
        assert.equal(await readFile(join(task.workDir, filename), 'utf8'), content)
        const delivery = (await backend.checkpoints.get(scope, task.id))?.state.nodes[0]?.delivery
        assert.deepEqual(delivery?.finalFiles.map(file => file.path), [filename])
        assert.equal(delivery?.validationAttempts, 1)
      }
      assert.equal(directories.size, 3)
      assert.equal(calls, 3)
      assert.equal(planningCalls, 1)
      await assert.rejects(readFile(join(root, filename)), { code: 'ENOENT' })
      return
    }
    now = scheduledAt
    await backend.schedules.scan()
    const occurrence = (await backend.schedules.list()).occurrences[0]!
    const task = await waitForTerminalWork(backend, occurrence.taskId)
    await backend.schedules.scan()
    assert.equal((await backend.schedules.list()).occurrences[0]!.status, 'completed', JSON.stringify(task))
    assert.equal(task.subscriptionId, null)
    assert.deepEqual((await backend.metadata.load(scope, task.id))?.participantSubscriptionIds, [])
    const bytes = await readFile(join(task.workDir!, mode === 'empty-text' ? '20261120-1031.txt' : filename))
    assert.equal(bytes.length, 0)
    assert.equal(backend.imagePrepare.mock.callCount(), 0)
    assert.equal(backend.imageWait.mock.callCount(), 0)
    const delivery = (await backend.checkpoints.get(scope, task.id))?.state.nodes[0]?.delivery
    assert.equal(delivery?.finalFiles[0]?.size, bytes.length)
    assert.ok(delivery?.finalFiles[0]?.snapshot)
    const records = await backend.runs.list(scope, task.id)
    assert.equal(records.length, 2)
    assert.ok(records.every(item => item.outcome === 'completed'))
    backend.schedules.stop(); await backend.runtime.stopAll()
    const restarted = await makeBackend()
    await restarted.schedules.recover(); await restarted.schedules.scan()
    assert.deepEqual(await restarted.runs.list(scope, task.id), records)
    assert.equal(calls, mode === 'general' ? 1 : 0)
    assert.equal(planningCalls, mode === 'general' ? 1 : 0)
    now = next
    if (mode === 'general') {
      failNodeAuthorization = true
      await restarted.schedules.scan()
      const failed = (await restarted.schedules.list()).occurrences.find(item => item.scheduledAt === next)!
      assert.equal((await waitForTerminalWork(restarted, failed.taskId)).status, 'failed')
      await restarted.schedules.scan()
      const result = (await restarted.schedules.list()).occurrences.find(item => item.id === failed.id)!
      assert.equal(result.status, 'failed')
      assert.equal(result.error?.code, 'EXECUTION_FAILED')
      assert.equal(calls, 1)
      failNodeAuthorization = false
      now = next + 86400000
      revoked = true
      await restarted.schedules.scan()
      const blocked = (await restarted.schedules.list()).occurrences.find(item => item.scheduledAt === now)!
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.error?.code, 'MODEL_NOT_ALLOWED')
      assert.equal(calls, 1)
    } else {
      const directory = await restarted.storage.prepareWorkspace(root, occurrenceId(definition.id, next))
      const target = join(directory, '20261121-1031.txt')
      await writeFile(target, 'keep existing data')
      assert.throws(() => emptyTextFilenameSchema.parse('../escape.txt'))
      assert.throws(() => emptyTextFilenameSchema.parse('NUL.txt'))
      assert.throws(() => emptyTextFilenameSchema.parse('ok:stream.txt'))
      await assert.rejects(createScheduledEmptyText(directory, occurrenceId(definition.id, next), 'cancelled.txt', () => { throw new DOMException('Cancelled', 'AbortError') }), { name: 'AbortError' })
      await assert.rejects(readFile(join(directory, 'cancelled.txt')), { code: 'ENOENT' })
      await restarted.schedules.scan()
      const conflict = (await restarted.schedules.list()).occurrences.find(item => item.scheduledAt === next)!
      await waitForTerminalWork(restarted, conflict.taskId)
      await restarted.schedules.scan()
      const failed = (await restarted.schedules.list()).occurrences.find(item => item.id === conflict.id)!
      assert.equal(failed.status, 'failed')
      assert.equal(failed.error?.code, 'FILE_ALREADY_EXISTS')
      assert.equal(await readFile(target, 'utf8'), 'keep existing data')

      const open = fs.open
      const failures = [
        ['ENOENT', 'ENOENT', '找不到工作目录'],
        ['ENOTDIR', 'ENOTDIR', '工作目录不可用'],
        ['EACCES', 'EACCES', '没有所需的读写权限'],
        ['EPERM', 'EPERM', '没有所需的读写权限'],
        ['ENOSPC', 'ENOSPC', '磁盘空间不足'],
        ['EIO', 'LOCAL_FILE_CREATION_FAILED', '无法创建空白文本'],
      ] as const
      for (const [errno, code, message] of failures) {
        now += 86400000
        const workspace = await restarted.storage.prepareWorkspace(root, occurrenceId(definition.id, now))
        const openFailure = t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
          const [path, flags] = args
          if (typeof path === 'string' && dirname(path) === workspace && path.endsWith('.txt') && flags === 'wx') {
            throw Object.assign(new Error(`Failed to write ${path}`), { code: errno, path })
          }
          return open(...args)
        })
        syncBuiltinESMExports()
        try {
          await restarted.schedules.scan()
          const attempt = (await restarted.schedules.list()).occurrences.find(item => item.scheduledAt === now)!
          await waitForTerminalWork(restarted, attempt.taskId)
          await restarted.schedules.scan()
          const persisted = (await restarted.checkpoints.get(scope, attempt.taskId))?.state.nodes[0]?.delivery?.firstIssue
          assert.equal(persisted?.code, code)
          assert.ok(persisted.message.includes(message))
          assert.ok(!JSON.stringify(persisted).includes('Failed to write'))
          assert.ok(!JSON.stringify(persisted).includes(JSON.stringify(workspace).slice(1, -1)))
          const outcome = (await restarted.schedules.list()).occurrences.find(item => item.id === attempt.id)!
          assert.equal(outcome.status, 'failed')
          assert.equal(outcome.error?.code, code)
        } finally { openFailure.mock.restore(); syncBuiltinESMExports() }
      }
      assert.equal(authorizeCalls, 0)
    }
  })
}

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

for (const scenario of ['confirm', 'clarify', 'deny', 'interrupt', 'contextual-reply', 'contextual-retry', 'contextual-elapsed', 'contextual-ambiguous'] as const) {
  test(`conversation time continuation (${scenario}) preserves one draft and requires approval`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'csep-conversation-schedule-'))
    const contextual = scenario.startsWith('contextual-')
    const now = Date.parse(contextual ? `2026-11-25T06:${scenario === 'contextual-elapsed' ? '41' : '36'}:00Z` : '2026-11-25T00:00:00Z')
    const storage = new ScheduledTaskStore(root), runs = new TaskRunStore(root)
    const tasks = new TaskManager(root, null, undefined, runs)
    const owner = { currentScope: () => tasks.getCurrentUserScope() }
    const forbidden = () => assert.fail('Scheduled work must not run in the creation test')
    const authorize = async (subscriptionId: string) => ({ subscriptionId, modelId, gatewayUrl: 'http://gateway.invalid' })
    const schedules = new ScheduledTaskService({ repository: storage, scope: owner, employee: authorize, planner: async () => employeePlan,
      runner: { prepare: forbidden, launch: forbidden, inspect: forbidden, cancel: forbidden }, now: () => now })
    const title = contextual ? '定时验收' : '金价日报'
    const original = contextual ? '请 Analyst 在北京时间 14:34 执行一次：在工作目录生成 定时验收.md，内容为“通用助手定时执行成功”'
      : '每天生成金价日报，保存到 report.txt，并注明数据时间和来源。'
    const taskSpec: ScheduleInterpretation['task'] = { title, goal: original, deliverables: ['report.txt，注明数据时间和来源'],
      execution: { mode: 'employee', subscriptionId: 'analyst' },
      schedule: { kind: 'cron', timezone: 'Asia/Shanghai', localDateTime: null, expression: '0 9 * * *', description: '每天 09:00' } }
    const contextualTask: ScheduleInterpretation['task'] = { title, goal: '在当前工作目录生成定时验收.md，内容为“通用助手定时执行成功”。',
      deliverables: ['定时验收.md，正文为通用助手定时执行成功'], execution: { mode: 'employee', subscriptionId: 'analyst' },
      schedule: { kind: 'once', timezone: 'Asia/Shanghai', localDateTime: '2026-11-25T14:40', expression: null, description: null } }
    const otherRequest = '请在北京时间 15:34 执行一次：在工作目录生成 另一份验收.md。'
    let interpretations = 0
    const creations = new ScheduledCreationService({ repository: storage, scope: owner, schedules,
      catalog: async () => catalog, authorize, now: () => now, validateWorkspace: async dir => { await storage.validateWorkspace(dir) },
      interpret: async input => {
        interpretations++
        assert.equal(contextual, false, 'A structured proposal should not be interpreted again')
        if (scenario === 'clarify' && interpretations === 2) {
          assert.deepEqual(input.messages.map(item => item.content), [original, '每天早上 10 点'])
          assert.equal(input.currentDraft?.task.goal, original)
          return { status: 'ready', task: { ...taskSpec, title: 'Other task', goal: 'Other goal', deliverables: ['other.txt'],
            execution: { mode: 'auto', subscriptionId: null }, schedule: { ...taskSpec.schedule, timezone: 'UTC' } }, questions: [], reasons: [] }
        }
        assert.equal(interpretations, 1, 'An existing calendar needs only a clock update')
        assert.deepEqual(input.messages.map(item => item.content), [original])
        return scenario === 'clarify'
          ? { status: 'needs_input', task: { ...taskSpec, schedule: { ...taskSpec.schedule, expression: null } },
            questions: [{ field: 'schedule', question: '请补充时间。' }], reasons: [] }
          : { status: 'ready', task: taskSpec, questions: [], reasons: [] }
      } })
    const workerPrompts: string[] = [], submissions: ScheduledCreationRequest[] = [], approvals: import('../../src/shared/types').ToolAuthorizationRequest[] = []
    const employee = { subscriptionId: 'analyst', modelId, gatewayUrl: 'http://gateway.invalid' }
    const runtime = new TaskRuntime({ taskManager: tasks, taskRunStore: runs,
      resolveEmployee: id => id === employee.subscriptionId ? employee : null, authorizeEmployee: authorize,
      getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest(request) { approvals.push(request) },
      submitConversationSchedule: async (request, review) => { submissions.push(request); return creations.submitConversation(request, review) },
      createWorker: options => ({ async run(prompt) {
        workerPrompts.push(prompt)
        const userText = prompt.split('\n', 1)[0]
        const file = join(options.context.sessionDir, 'fixture.jsonl')
        await fs.mkdir(options.context.sessionDir, { recursive: true })
        await writeFile(file, '{}\n', 'utf8')
        await options.onSessionCreated?.({ sessionId: 'fixture', sessionFile: file })
        if (contextual) {
          const tool = conversationScheduleToolDefinition(options.context.conversationSchedule!)
          if (workerPrompts.length === 1 || userText === otherRequest) {
            const task = userText === otherRequest ? { ...contextualTask, title: '另一份验收', goal: '生成另一份验收.md', deliverables: ['另一份验收.md'] } : contextualTask
            await tool.execute('first', { action: 'new', candidate: { status: 'needs_input', task: { ...task,
              schedule: { ...task.schedule, localDateTime: null } }, questions: [{ field: 'schedule', question: '请确认执行日期。' }],
              reasons: [{ code: 'MISSING_INFORMATION', message: '已指定北京时间和执行时刻，但未指定执行日期。' }] } }, undefined, undefined, {} as never)
          } else if ((scenario !== 'contextual-retry' && userText === '今天的14:40') || userText === '创建定时任务') {
            await tool.execute('resume', { action: 'resume', candidate: { status: 'ready', task: contextualTask, questions: [], reasons: [] } }, undefined, undefined, {} as never)
          }
        } else if (workerPrompts.length === 1) assert.ok(await options.context.conversationSchedule?.())
      }, async abort() {}, async dispose() {} }),
    })
    t.after(async () => { creations.stop(); schedules.stop(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) })
    await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
    const chat = await tasks.createTask(title, original, root, 'analyst')
    const wait = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 4500
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.ok(predicate(), label)
    }
    const idle = () => wait(() => !runtime.hasConversationRun(chat.id), 'conversation should settle')
    const reply = (prompt: string) => runtime.continueConversation(chat.id, prompt, { messageId: randomUUID() })
    const receipt = async () => {
      const history = (await runs.list(scope, chat.id)).sort((a, b) => a.startedAt - b.startedAt)
      const timeline = await runs.events.getTimeline(scope, chat.id, history.at(-1)!.id)
      return conversationScheduleReceiptSchema.parse(timeline.filter(event => event.type === CONVERSATION_SCHEDULE_EVENT).at(-1)?.data)
    }
    await runtime.executeTask(chat.id, { conversation: true })
    if (scenario !== 'clarify' && !contextual) {
      await wait(() => approvals.length === 1, 'original approval should open')
      assert.equal((approvals[0]!.input as { recurrence: string }).recurrence, '0 9 * * *')
      assert.equal(runtime.respondToApproval({ requestId: approvals[0]!.requestId, approved: false, reason: REVISE_CONVERSATION_SCHEDULE_TIME }), true)
    }
    await idle()
    const awaiting = await receipt()
    assert.ok(awaiting.status === 'needs_input' && awaiting.draft)
    if (contextual) {
      const initial = (await storage.read(scope)).creations?.find(item => item.id === awaiting.draft!.id)
      assert.equal(initial?.interpretation?.status, 'needs_input')
      assert.deepEqual(initial?.interpretation?.reasons, [])
      assert.equal(awaiting.message, '请确认执行日期。')
      assert.deepEqual(approvals, [])
    }
    assert.deepEqual((await storage.read(scope)).definitions, [])
    if (contextual) {
      if (scenario === 'contextual-ambiguous') {
        await reply(otherRequest); await idle()
        const before = await storage.read(scope)
        assert.equal(before.creations?.length, 2)
        await reply('创建定时任务'); await idle()
        const result = await receipt()
        assert.equal(result.status, 'blocked')
        assert.match(result.message, /多份待补充/)
        await storage.update(scope, data => { data.creations!.find(item => item.id === awaiting.draft!.id)!.revision++ })
        const edited = await storage.read(scope)
        await reply('创建定时任务'); await idle()
        assert.equal((await receipt()).status, 'blocked', 'A stale revision must not silently select the other draft')
        assert.deepEqual(await storage.read(scope), edited)
        assert.deepEqual(approvals, [])
        return
      }
      await reply('今天的14:40')
      if (scenario === 'contextual-elapsed') {
        await idle()
        const result = await receipt()
        assert.equal(result.status, 'needs_input')
        assert.equal(result.draft?.id, awaiting.draft.id)
        assert.match(result.message, /执行时间已过/)
        assert.deepEqual(approvals, [])
        assert.deepEqual((await storage.read(scope)).definitions, [])
        return
      }
      if (scenario === 'contextual-retry') {
        await idle()
        await reply('你创建定时任务了吗'); await idle()
        assert.equal(approvals.length, 0, 'A status question must not request approval')
        assert.equal(submissions.length, 1)
        await reply('创建定时任务')
      }
      await wait(() => approvals.length === 1, 'the assembled task should reach approval')
      const firstRunAt = Date.parse('2026-11-25T06:40:00Z')
      assert.deepEqual(approvals[0]!.input, { title, goal: `${contextualTask.goal}\n\nDeliverables:\n- ${contextualTask.deliverables[0]}`,
        timezone: 'Asia/Shanghai', firstRunAt, recurrence: null })
      const pending = await storage.read(scope)
      assert.equal(pending.creations?.length, 1)
      assert.equal(pending.creations?.[0]?.id, awaiting.draft.id)
      assert.deepEqual(pending.definitions, [])
      assert.equal(runtime.respondToApproval({ requestId: approvals[0]!.requestId, approved: true }), true)
      await idle()
      assert.equal((await receipt()).status, 'created')
      const snapshot = await storage.read(scope)
      assert.equal(snapshot.definitions.length, 1)
      assert.equal(snapshot.definitions[0]?.enabled, true)
      assert.equal(snapshot.definitions[0]?.nextRunAt, firstRunAt)
      assert.equal(snapshot.definitions[0]?.input.workDir, root)
      assert.equal(interpretations, 0)
      await reply('创建定时任务'); await idle()
      assert.equal((await receipt()).status, 'blocked', 'An enabled draft cannot be resumed or duplicated')
      assert.equal(approvals.length, 1)
      assert.deepEqual((await storage.read(scope)).definitions, snapshot.definitions)
      return
    }
    if (scenario === 'interrupt') {
      await reply('先说说什么是金衡盎司。'); await idle()
      await reply('每天早上 10 点'); await idle()
      assert.equal(submissions.length, 1)
      assert.equal(workerPrompts.length, 3)
      assert.deepEqual((await storage.read(scope)).definitions, [])
      return
    }
    await reply('每天早上 10 点')
    const approvalCount = scenario === 'clarify' ? 1 : 2
    await wait(() => approvals.length === approvalCount, 'revised approval should open')
    assert.equal(workerPrompts.length, 1, 'the general model did not have to select the tool again')
    assert.equal(submissions[1]!.requestId, awaiting.draft.id)
    assert.equal(submissions[1]!.expectedRevision, awaiting.draft.revision)
    assert.deepEqual(approvals.at(-1)!.input, { title, goal: `${original}\n\nDeliverables:\n- ${taskSpec.deliverables[0]}`,
      timezone: 'Asia/Shanghai', recurrence: '0 10 * * *', firstRunAt: now + 7200000 })
    assert.deepEqual((await storage.read(scope)).definitions, [])
    assert.equal(runtime.respondToApproval({ requestId: approvals.at(-1)!.requestId, approved: scenario !== 'deny' }), true)
    await idle()
    const snapshot = await storage.read(scope)
    assert.equal(snapshot.creations?.length, 1)
    if (scenario === 'deny') {
      assert.equal((await receipt()).status, 'cancelled')
      assert.deepEqual(snapshot.definitions, [])
    } else {
      assert.equal((await receipt()).status, 'created')
      assert.equal(snapshot.definitions.length, 1)
      assert.equal(snapshot.definitions[0]!.enabled, true)
      assert.equal(snapshot.definitions[0]!.nextRunAt, now + 7200000)
      await reply('几点执行？'); await idle()
      assert.match(workerPrompts.at(-1)!, /已启用，首次执行时间：.*10:00/)
    }
    const replay = await creations.submitConversation(submissions[1]!, { signal: new AbortController().signal, receivedAt: now, approve: forbidden })
    assert.equal(replay.status, scenario === 'deny' ? 'cancelled' : 'created')
    await assert.rejects(creations.submitConversation({ ...submissions[1]!, message: '上午十一点' },
      { signal: new AbortController().signal, receivedAt: now, approve: forbidden }), (error: unknown) => error instanceof AppError && error.code === 'DRAFT_REVISION_CONFLICT')
    assert.deepEqual((await storage.read(scope)).definitions, snapshot.definitions)
  })
}

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
