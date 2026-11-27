import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ScheduledSnapshot, EmployeeWorkPlan, ModelScheduledInput } from '../../src/shared/scheduled-tasks'
import { scheduleInterpretationSchema, scheduledCreationSchema, type ScheduledCreationInterpreterInput, type ScheduledCreationRequest, type ScheduleInterpretation } from '../../src/shared/scheduled-creation'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import { WriteChain } from '../data/write-chain'
import { PiEmployeePlanner } from '../runtime/pi-employee-planner'
import { ScheduledTaskService } from './scheduled-task-service'
import { ScheduledCreationService } from './scheduled-creation-service'
import { AppError } from '../errors/app-error'

const request: ScheduledCreationRequest = {
  requestId: '11111111-1111-4111-8111-111111111111', message: 'Have Researcher create a report every day at nine',
  modelId: 'model', workDir: 'D:/reports', timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' },
}
const interpretation: ScheduleInterpretation = {
  status: 'ready', task: { title: 'Daily report', goal: 'Produce report', deliverables: ['Markdown report'],
    execution: { mode: 'employee', subscriptionId: 'sub' },
    schedule: { kind: 'cron', timezone: 'UTC', localDateTime: null, expression: '0 9 * * *', description: 'Daily at 09:00' } },
  questions: [], reasons: [],
}
const plan: EmployeeWorkPlan = { status: 'ready', objective: 'Report', instruction: 'Produce a report file', expectedOutput: 'Markdown report',
  deliverables: [{ id: 'report', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Readable file'] }] }
const catalog = [{ subscriptionId: 'sub', name: 'Researcher', position: '', functionalCategory: '', description: '', allowedModels: ['model'] }]

function harness() {
  let data: ScheduledSnapshot = { definitions: [], occurrences: [] }
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'm', enterpriseId: 'e' }
  let now = Date.parse('2026-10-21T08:00:00Z')
  let interpretations = 0, plans = 0, launches = 0
  let interpret: (input: ScheduledCreationInterpreterInput) => Promise<ScheduleInterpretation> = async () => interpretation
  let planner: (input: ModelScheduledInput, employee: unknown, signal: AbortSignal, grantId?: string) => Promise<EmployeeWorkPlan> = async () => plan
  let validate: () => Promise<void> = async () => undefined
  let fault: 'before-enable' | 'after-enable' | null = null
  const writes = new WriteChain()
  const repository: ScheduledRepository = {
    async read() { return structuredClone(data) },
    update: (_scope, mutate) => writes.run('scope', async () => {
      const snapshot = structuredClone(data), result = mutate(snapshot)
      const enabling = snapshot.creations?.some(item => item.stage === 'completed') && !data.creations?.some(item => item.stage === 'completed')
      if (enabling && fault === 'before-enable') { fault = null; throw new AppError('PERSISTENCE_ERROR') }
      data = snapshot
      if (enabling && fault === 'after-enable') { fault = null; throw new AppError('PERSISTENCE_ERROR') }
      return structuredClone(result)
    }),
  }
  const scopes = { currentScope: () => scope }
  const schedules = new ScheduledTaskService({ repository, scope: scopes, now: () => now, employee: async () => ({}),
    authorizeModel: async modelId => { assert.equal(modelId, 'model'); return { subscriptionId: 'sub' } },
    planner: async (...args) => { plans++; return planner(...args) },
    arrangementPlanner: async () => ({ status: 'ready', kind: 'arrangement', title: 'Report', intentAnalysis: null,
      nodes: [{ id: 'work', subscriptionId: 'sub', modelId: 'model', title: 'Report', instruction: plan.instruction,
        expectedOutput: plan.expectedOutput, deliverables: plan.deliverables, dependsOn: [], skillIds: [], requiresUserConfirmation: false }] }),
    runner: { async prepare() {}, async launch() { launches++ }, async inspect() { return { state: 'running' } }, async cancel() {} },
  })
  const make = () => new ScheduledCreationService({ repository, scope: scopes, schedules, now: () => now,
    catalog: async () => catalog, authorize: async () => undefined, validateWorkspace: () => validate(),
    interpret: async input => { interpretations++; return interpret(input) },
  })
  const creation = make()
  return { creation, schedules, repository, make, get data() { return data }, get interpretations() { return interpretations }, get plans() { return plans }, get launches() { return launches },
    setInterpret(value: typeof interpret) { interpret = value }, setPlanner(value: typeof planner) { planner = value },
    setValidate(value: typeof validate) { validate = value }, setScope(value: typeof scope) { scope = value }, advance(value: number) { now = value },
    failEnable(value: typeof fault) { fault = value },
    stop() { creation.stop(); schedules.stop() },
  }
}

test('homepage creation plans and enables without confirmation, then repeated requests never duplicate or re-enable', async () => {
  const h = harness()
  try {
    const first = await h.creation.submit(request)
    assert.equal(first.stage, 'completed')
    assert.equal(h.data.definitions.length, 1)
    assert.equal(h.data.definitions[0].enabled, true)
    assert.ok(h.data.definitions[0].plan)
    assert.match(h.data.definitions[0].input.goal, /Markdown report/)
    assert.equal(h.launches, 0)
    await h.schedules.pause(first.definitionId!, h.data.definitions[0].revision)
    const again = await h.creation.submit(request)
    assert.equal(again.definitionId, first.definitionId)
    assert.equal(h.data.definitions[0].enabled, false)
    assert.equal(h.interpretations, 1)
    assert.equal(h.plans, 1)
    assert.equal(h.data.definitions.length, 1)
  } finally { h.stop() }
})

test('a general report borrows model authorization and enables without binding an employee', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...interpretation, task: { ...interpretation.task, execution: { mode: 'general', subscriptionId: null } } }))
    const result = await h.creation.submit({ ...request, message: 'Every day at nine create a report' })
    assert.equal(result.stage, 'completed')
    assert.equal(h.plans, 1)
    assert.equal(h.data.definitions[0].enabled, true)
    assert.equal(h.data.definitions[0].input.mode, 'general')
    assert.equal(h.data.definitions[0].input.subscriptionId, undefined)
  } finally { h.stop() }
})

test('conversation enables a scheduled report and send without verifying the external connection', async () => {
  const h = harness()
  const goal = '读取钉钉 AI 表格「销售1」，生成统计文档，再发给胡锐。'
  const workPlan = { ...plan, instruction: `${goal} 执行时检查连接和权限，唯一匹配表格和收件人后再操作；条件不满足则记录未执行。` }
  const candidate: ScheduleInterpretation = { ...interpretation, task: { ...interpretation.task, goal,
    deliverables: ['销售1统计文档', '发给胡锐并记录发送结果'], execution: { mode: 'general', subscriptionId: null } } }
  let confirmations = 0, corrections = 0
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        assert.equal(options.context.disableTools, true)
        assert.ok(options.context.fixedSystemPrompt?.includes(goal))
        assert.match(options.context.fixedSystemPrompt ?? '', /把这些检查安排在实际执行时/)
        const correction = await options.onResponseSettled?.({ text: JSON.stringify({ status: 'blocked', reasons: ['当前未提供已连接且获授权的钉钉业务工具。'] }), stopReason: 'stop' })
        assert.match(correction?.continueWith ?? '', /permission, tool availability and target checks in the execution instructions/)
        corrections++
        assert.equal(await options.onResponseSettled?.({ text: JSON.stringify(workPlan), stopReason: 'stop' }), undefined)
      }, async abort() {}, async dispose() {},
    }),
  })
  const signal = new AbortController().signal
  h.setPlanner((...args) => planner.plan(...args))
  try {
    const receipt = await h.creation.submitConversation({ ...request, message: `每天九点${goal}` }, {
      candidate, conversationId: 'chat', receivedAt: Date.parse('2026-10-21T08:00Z'), signal,
      approve: async input => { confirmations++; assert.ok(input.goal.includes(goal)); return true },
    })
    assert.equal(receipt.status, 'created')
    assert.equal(confirmations, 1)
    assert.equal(corrections, 1)
    assert.equal(h.interpretations, 0)
    assert.equal(h.launches, 0)
    assert.equal(h.data.definitions[0].enabled, true)
    assert.equal(h.data.definitions[0].connectorRevision, null)
    assert.deepEqual(h.data.definitions[0].plan, workPlan)
  } finally { h.stop() }
})

test('a revoked parser subscription is not replaced by another employee with the same model', async () => {
  const h = harness()
  try {
    const record = await h.creation.submit({ ...request, parserSubscriptionId: 'revoked' })
    assert.equal(record.stage, 'failed')
    assert.equal(h.interpretations, 0)
    assert.equal(h.data.definitions.length, 0)
  } finally { h.stop() }
})

test('an invented assignee or collaboration quotation does not enable work', async () => {
  for (const execution of [interpretation.task.execution, { mode: 'auto', subscriptionId: null, collaborationRequest: 'Use two employees' } as const]) {
    const h = harness()
    try {
      h.setInterpret(async () => ({ ...interpretation, task: { ...interpretation.task, execution } }))
      const record = await h.creation.submit({ ...request, message: 'Every day at nine create a report' })
      assert.equal(record.stage, 'needs_input')
      assert.equal(record.interpretation?.questions[0].field, 'execution')
      assert.equal(h.data.definitions.length, 0)
    } finally { h.stop() }
  }
})

test('blank file creation uses the general assistant; legacy interpretations are read-only', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...interpretation, task: { ...interpretation.task, goal: 'Create one empty file', deliverables: ['record.txt'], execution: { mode: 'general', subscriptionId: null } } }))
    const result = await h.creation.submit({ ...request, message: 'Create an empty record.txt daily at nine' })
    assert.equal(result.stage, 'completed')
    const input = h.data.definitions[0].input
    assert.equal(input.mode, 'general')
    assert.match(input.goal, /Create one empty file[\s\S]*record\.txt/)
    assert.equal(input.subscriptionId, undefined)
    assert.equal(input.modelId, 'model')
    assert.equal(h.plans, 1)
    const legacy = { ...result.interpretation, task: { ...result.interpretation!.task,
      execution: { mode: 'empty-text', subscriptionId: null, emptyText: { naming: 'fixed', filename: 'record.txt' } } } }
    assert.equal(scheduleInterpretationSchema.safeParse(legacy).success, false)
    assert.equal(scheduledCreationSchema.parse({ ...result, interpretation: legacy }).interpretation?.task.execution.mode, 'empty-text')
  } finally { h.stop() }
})

test('deleting completed creation progress preserves scheduling and prevents replay from enabling again', async () => {
  const h = harness()
  try {
    const created = await h.creation.submit(request)
    const before = await h.schedules.list()
    await assert.rejects(h.creation.deleteRecord(created.id, created.revision - 1), { code: 'DRAFT_REVISION_CONFLICT' })
    const deleted = await h.creation.deleteRecord(created.id, created.revision)
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.revision, created.revision + 1)
    assert.deepEqual(await h.creation.deleteRecord(created.id, created.revision), deleted)
    const after = await h.schedules.list()
    assert.deepEqual(after.definitions, before.definitions)
    assert.deepEqual(after.occurrences, before.occurrences)
    assert.deepEqual(after.creations, [deleted])
    assert.deepEqual(await h.make().submit(request), deleted)
    assert.equal(h.interpretations, 1)
    assert.equal(h.plans, 1)
  } finally { h.stop() }
})

test('failed progress requires cancellation before deletion and cannot be restored by a replay', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => { throw Error('interpretation failed') })
    const failed = await h.creation.submit(request)
    assert.equal(failed.stage, 'failed')
    await assert.rejects(h.creation.deleteRecord(failed.id, failed.revision), { code: 'INVALID_STATE' })
    const cancelled = await h.creation.cancel(failed.id, failed.revision)
    const deleted = await h.creation.deleteRecord(cancelled.id, cancelled.revision)
    assert.deepEqual(await h.make().submit(request), deleted)
    await assert.rejects(h.creation.submit({ ...request, message: 'A new instruction', expectedRevision: deleted.revision }), { code: 'INVALID_STATE' })
    assert.equal(h.interpretations, 1)
    assert.deepEqual(h.data.definitions, [])
  } finally { h.stop() }
})

test('creation progress awaiting input or adjustment cannot be deleted before cancellation', async () => {
  const outcomes: ScheduleInterpretation[] = [
    { ...interpretation, status: 'needs_input', questions: [{ field: 'schedule', question: 'What time?' }] },
    { ...interpretation, status: 'blocked', reasons: [{ code: 'UNSUPPORTED_SCHEDULE', message: 'Choose a supported schedule.' }] },
  ]
  for (const outcome of outcomes) {
    const h = harness()
    try {
      h.setInterpret(async () => outcome)
      const record = await h.creation.submit(request)
      assert.equal(record.stage, outcome.status)
      await assert.rejects(h.creation.deleteRecord(record.id, record.revision), { code: 'INVALID_STATE' })
      assert.deepEqual(h.data.creations, [record])
      const cancelled = await h.creation.cancel(record.id, record.revision)
      assert.equal((await h.creation.deleteRecord(cancelled.id, cancelled.revision)).deleted, true)
    } finally { h.stop() }
  }
})

test('a conversation schedule is not saved or enabled before approval, and a replay returns the same receipt', async () => {
  const h = harness()
  let approvals = 0
  const receivedAt = Date.parse('2026-10-21T07:30:00Z')
  h.setInterpret(async input => {
    assert.equal(input.fromConversation, true)
    assert.equal(input.messages[0].receivedAt, receivedAt)
    return interpretation
  })
  const review = { signal: new AbortController().signal, receivedAt, approve: async (input: import('../../src/shared/scheduled-tasks').ScheduleInput) => {
    approvals++
    assert.equal(input.scheduledAt, Date.parse('2026-10-21T09:00:00Z'))
    assert.equal(h.data.definitions.length, 0)
    assert.equal(h.plans, 0)
    return true
  } }
  try {
    const receipt = await h.creation.submitConversation(request, review)
    assert.equal(receipt.status, 'created')
    assert.equal(h.data.definitions[0].enabled, true)
    assert.equal(h.launches, 0)
    const reopened = h.make()
    try { assert.deepEqual(await reopened.submitConversation(request, review), receipt) } finally { reopened.stop() }
    assert.equal(approvals, 1)
    assert.equal(h.data.definitions.length, 1)
  } finally { h.stop() }
})

test('a conversation schedule cannot substitute a workspace delivery for an explicitly requested Windows destination', async () => {
  const h = harness()
  try {
    const result = await h.creation.submitConversation({ ...request, message: String.raw`每天九点在 C:\Users\demo\Desktop 创建报告` }, {
      signal: new AbortController().signal, receivedAt: Date.parse('2026-10-21T08:00:00Z'),
      approve: async () => assert.fail('an unsupported destination cannot be offered for confirmation'),
    })
    assert.equal(result.status, 'blocked')
    assert.match(result.status === 'blocked' ? result.message : '', /不允许访问指定路径/)
    assert.equal(h.data.definitions.length, 0)
    assert.equal(h.plans, 0)
  } finally { h.stop() }
})

test('a conversation schedule can deliver to a relative path and include a Windows path as literal text', async () => {
  const h = harness()
  try {
    const result = await h.creation.submitConversation({ ...request, message: String.raw`请 Researcher 每天九点生成报告，保存到 deliverables/report.md，内容引用 C:\example\file.txt` }, {
      signal: new AbortController().signal, receivedAt: Date.parse('2026-10-21T08:00:00Z'), approve: async () => true,
    })
    assert.equal(result.status, 'created')
    assert.equal(h.data.definitions.length, 1)
  } finally { h.stop() }
})

test('confirming an every-minute conversation schedule after the preview remains valid', async () => {
  const h = harness()
  const receivedAt = Date.parse('2026-11-23T05:26:47Z')
  const previewAt = Date.parse('2026-11-23T05:27:00Z')
  const savedAt = Date.parse('2026-11-23T05:28:00Z')
  const nextRunAt = Date.parse('2026-11-23T05:29:00Z')
  h.advance(receivedAt)
  h.setInterpret(async () => ({ ...interpretation, task: { ...interpretation.task,
    schedule: { ...interpretation.task.schedule, timezone: 'Asia/Shanghai', expression: '* * * * *', description: '每分钟' } } }))
  h.setPlanner(async () => {
    assert.equal(h.data.definitions[0].enabled, false)
    assert.equal(h.data.definitions[0].input.scheduledAt, savedAt)
    assert.deepEqual(h.data.creations?.[0].definitionInput, h.data.definitions[0].input)
    h.advance(savedAt + 12000)
    return plan
  })
  let approvals = 0
  const review = { receivedAt, signal: new AbortController().signal, approve: async (input: import('../../src/shared/scheduled-tasks').ScheduleInput) => {
    approvals++
    assert.equal(input.scheduledAt, previewAt)
    assert.equal(h.data.definitions.length, 0)
    h.advance(previewAt + 22000)
    return true
  } }
  try {
    const submission = { ...request, message: '请 Researcher 每分钟生成简报', timezone: 'Asia/Shanghai' }
    const receipt = await h.creation.submitConversation(submission, review)
    assert.equal(receipt.status, 'created')
    assert.equal(h.data.definitions[0].enabled, true)
    assert.equal(h.data.definitions[0].nextRunAt, nextRunAt)
    assert.equal(receipt.status === 'created' && receipt.nextRunAt, nextRunAt)
    assert.equal(h.launches, 0)
    assert.deepEqual(await h.creation.submitConversation(submission, review), receipt)
    assert.equal(approvals, 1)
    assert.equal(h.data.definitions.length, 1)
  } finally { h.stop() }
})

test('denied, stale, and unclear conversation requests cannot enable a schedule', async () => {
  for (const scenario of ['denied', 'aborted', 'clarify'] as const) {
    const h = harness()
    const controller = new AbortController()
    if (scenario === 'clarify') h.setInterpret(async () => ({ ...interpretation, status: 'needs_input', questions: [{ field: 'schedule', question: 'When should it start?' }] }))
    try {
      const receipt = await h.creation.submitConversation(request, { signal: controller.signal, receivedAt: Date.now(), approve: async () => {
        assert.notEqual(scenario, 'clarify')
        if (scenario === 'aborted') controller.abort()
        return scenario === 'aborted'
      } })
      assert.equal(receipt.status, scenario === 'denied' ? 'cancelled' : scenario === 'clarify' ? 'needs_input' : 'failed')
      assert.equal(h.data.definitions.length, 0)
      await assert.rejects(h.creation.submit({ ...request, expectedRevision: h.data.creations?.[0].revision }), { code: 'INVALID_STATE' })
    } finally { h.stop() }
  }
})

test('legacy cancellation is reissued as a new draft only from verified same-conversation user text', async () => {
  const h = harness()
  const signal = new AbortController().signal, receivedAt = Date.parse('2026-10-21T08:00:00Z')
  const retry = { ...request, requestId: '22222222-2222-4222-8222-222222222222', message: '重新发起确认，并把时间改为14:13' }
  const review = { signal, receivedAt, conversationId: 'chat', continuation: 'review' as const }
  try {
    const old = await h.creation.submitConversation(request, { signal, receivedAt, approve: async () => false })
    assert.equal(old.status, 'cancelled')
    const previous = structuredClone(h.data.creations![0])
    const forbidden = async () => assert.fail('unverified history must not request approval')
    assert.equal((await h.creation.submitConversation(retry, { ...review, approve: forbidden })).status, 'blocked')
    assert.equal((await h.creation.submitConversation(retry, { ...review, approve: forbidden,
      legacySources: new Map([[request.requestId, `> ${request.message}`]]) })).status, 'blocked')
    h.setInterpret(async input => {
      assert.deepEqual(input.messages.map(item => item.content), [request.message])
      return interpretation
    })
    const next = await h.creation.submitConversation(retry, { ...review, legacySources: new Map([[request.requestId, request.message]]),
      approve: async input => { assert.equal(input.recurrence?.frequency === 'cron' && input.recurrence.expression, '13 14 * * *'); return 'timeout' } })
    assert.equal(next.status, 'needs_confirmation')
    assert.deepEqual(h.data.creations![0], previous)
    assert.equal(h.data.creations![1].reissuedFrom, previous.id)
    assert.notEqual(next.draft.id, previous.id)
    const action = { kind: 'discard' as const, draft: next.draft }
    const discard = { ...retry, requestId: '33333333-3333-4333-8333-333333333333', message: '放弃定时草稿' }
    assert.equal((await h.creation.submitConversation(discard, { signal, receivedAt, conversationId: 'other', draftAction: action, approve: forbidden })).status, 'blocked')
    assert.equal((await h.creation.submitConversation(discard, { signal, receivedAt, conversationId: 'chat', draftAction: action, approve: forbidden })).status, 'discarded')
    assert.equal(await h.creation.hasConversationDrafts('chat'), false)
    assert.deepEqual(h.data.definitions, [])
  } finally { h.stop() }
})

test('clarification continues the same persisted creation and automatic mode reuses arrangement planning', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), status: 'needs_input',
      task: { ...structuredClone(interpretation.task), schedule: { ...interpretation.task.schedule, expression: null } },
      questions: [{ field: 'schedule', question: 'What time?' }] }))
    const draft = await h.creation.submit(request)
    assert.equal(draft.stage, 'needs_input')
    assert.equal(h.data.definitions.length, 0)
    const recovered = h.make()
    h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), execution: { mode: 'auto', subscriptionId: null, collaborationRequest: 'Use automatic arrangement' } } }))
    const result = await recovered.submit({ ...request, expectedRevision: draft.revision, message: 'Use automatic arrangement. Nine every morning' })
    assert.equal(result.id, draft.id)
    assert.equal(result.stage, 'completed')
    assert.equal(result.messages.length, 2)
    assert.equal(h.data.creations?.length, 1)
    assert.equal(h.data.definitions[0].plan?.kind, 'arrangement')
    assert.equal(h.data.definitions[0].enabled, true)
    recovered.stop()
  } finally { h.stop() }
})

test('clarifications timestamp the new answer without moving the original relative-date reference', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), status: 'needs_input',
      task: { ...structuredClone(interpretation.task), schedule: { ...interpretation.task.schedule, expression: null } },
      questions: [{ field: 'schedule', question: 'What time?' }] }))
    const first = await h.creation.submit(request)
    const originalReference = h.data.creations![0].referenceNow
    h.advance(originalReference + 86400000)
    h.setInterpret(async input => {
      assert.equal(input.referenceNow, originalReference)
      assert.equal(input.messages.at(-1)?.receivedAt, originalReference + 86400000)
      return structuredClone(interpretation)
    })
    await h.creation.submit({ ...request, expectedRevision: first.revision, message: 'At nine' })
  } finally { h.stop() }
})

test('concurrent identical submissions share one operation; different content cannot replace in-flight input', async () => {
  const h = harness()
  let finish!: (value: ScheduleInterpretation) => void
  h.setInterpret(() => new Promise(resolve => { finish = resolve }))
  try {
    const a = h.creation.submit(request), b = h.creation.submit(request)
    for (let i = 0; !finish && i < 30; i++) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(h.creation.submit({ ...request, message: 'Different task' }), { code: 'CONFLICT' })
    finish(interpretation)
    assert.equal((await a).definitionId, (await b).definitionId)
    assert.equal(h.interpretations, 1)
    assert.equal(h.data.definitions.length, 1)
  } finally { h.stop() }
})

test('planning failure resumes from saved parsing and does not add another definition after restart', async () => {
  const h = harness()
  try {
    h.setPlanner(async () => { throw new Error('temporary planner failure') })
    const failed = await h.creation.submit(request)
    assert.equal(failed.stage, 'failed')
    assert.equal(h.data.definitions.length, 1)
    h.setPlanner(async () => plan)
    const restarted = h.make()
    await restarted.recover()
    const done = await restarted.submit(request)
    assert.equal(done.stage, 'completed')
    assert.equal(h.interpretations, 1)
    assert.equal(h.data.definitions.length, 1)
    restarted.stop()
  } finally { h.stop() }
})

test('an active creation must be cancelled before its progress can be deleted', async () => {
  const h = harness()
  let finish!: (value: ScheduleInterpretation) => void
  h.setInterpret(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = h.creation.submit(request)
    for (let i = 0; !finish && i < 30; i++) await new Promise(resolve => setImmediate(resolve))
    const current = h.data.creations![0]
    await assert.rejects(h.creation.deleteRecord(current.id, current.revision), { code: 'INVALID_STATE' })
    const cancelled = await h.creation.cancel(current.id, current.revision)
    const deleted = await h.creation.deleteRecord(cancelled.id, cancelled.revision)
    finish(interpretation)
    assert.equal((await pending).stage, 'cancelled')
    assert.equal(h.data.definitions.length, 0)
    assert.deepEqual(h.data.creations, [deleted])
  } finally { h.stop() }
})

test('logout rejects late results and never creates protected work', async () => {
  const h = harness()
  let finish!: (value: ScheduleInterpretation) => void
  h.setInterpret(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = h.creation.submit(request)
    for (let i = 0; !finish && i < 30; i++) await new Promise(resolve => setImmediate(resolve))
    h.setScope(null); h.creation.stop(); finish(interpretation)
    await assert.rejects(pending, { code: 'AUTH_REQUIRED' })
    assert.equal(h.data.definitions.length, 0)
  } finally { h.stop() }
})

test('invalid employee, unsupported model and inaccessible directory never enable a task', async () => {
  for (const failure of ['employee', 'model', 'directory']) {
    const h = harness()
    try {
      if (failure === 'employee') h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), execution: { mode: 'employee', subscriptionId: 'invented' } } }))
      if (failure === 'directory') h.setValidate(async () => { throw { code: 'WORKSPACE_INVALID' } })
      const result = await h.creation.submit(failure === 'model' ? { ...request, modelId: 'invented' } : request)
      assert.notEqual(result.stage, 'completed')
      assert.equal(h.data.definitions.some(item => item.enabled), false)
      assert.equal(h.launches, 0)
    } finally { h.stop() }
  }
})

test('stale clarification revisions cannot overwrite newer persisted answers', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), status: 'needs_input', questions: [{ field: 'goal', question: 'Which report?' }] }))
    const first = await h.creation.submit(request)
    const second = await h.creation.submit({ ...request, expectedRevision: first.revision, message: 'Sales report' })
    await assert.rejects(h.creation.submit({ ...request, expectedRevision: first.revision, message: 'Marketing report' }), { code: 'DRAFT_REVISION_CONFLICT' })
    assert.equal(h.data.creations![0].revision, second.revision)
    assert.equal(h.data.creations![0].messages.at(-1)?.content, 'Sales report')
  } finally { h.stop() }
})

test('reports workspace permission failures without exposing system paths', async () => {
  const h = harness()
  try {
    h.setValidate(async () => { throw Object.assign(new Error('private folder'), { code: 'EACCES' }) })
    const result = await h.creation.submit(request)
    assert.equal(result.stage, 'failed')
    assert.match(result.error ?? '', /读写权限/)
    assert.doesNotMatch(result.error ?? '', /private folder/)
    assert.equal(h.data.definitions.length, 0)
  } finally { h.stop() }
})

test('a due occurrence still uses the existing scheduled execution and repeated scans launch only once', async () => {
  const h = harness()
  try {
    await h.creation.submit(request)
    h.advance(Date.parse('2026-10-21T09:00:00Z'))
    await h.schedules.scan(); await h.schedules.scan()
    assert.equal(h.launches, 1)
    assert.equal(h.data.occurrences.length, 1)
  } finally { h.stop() }
})

test('enable checkpoint failure retries only the saved plan; a lost enable response returns the committed task', async () => {
  for (const fault of ['before-enable', 'after-enable'] as const) {
    const h = harness()
    try {
      h.failEnable(fault)
      const first = await h.creation.submit(request)
      assert.equal(first.stage, fault === 'before-enable' ? 'failed' : 'completed')
      assert.equal(h.data.definitions[0].enabled, fault === 'after-enable')
      const again = await h.creation.submit(request)
      assert.equal(again.stage, 'completed')
      assert.equal(h.data.definitions.length, 1)
      assert.equal(h.interpretations, 1)
      assert.equal(h.plans, 1)
    } finally { h.stop() }
  }
})

test('planning can ask for required input and a new answer edits the same task rather than reusing the old goal', async () => {
  const h = harness()
  try {
    h.setPlanner(async () => { throw new AppError('INVALID_ARGUMENT', { message: 'Which sales source should be used?' }) })
    const draft = await h.creation.submit(request)
    assert.equal(draft.stage, 'needs_input')
    assert.equal(draft.interpretation?.questions[0]?.field, 'goal')
    h.setPlanner(async () => plan)
    h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), goal: 'Produce report from sales.csv' } }))
    const result = await h.creation.submit({ ...request, expectedRevision: draft.revision, message: 'Use sales.csv' })
    assert.equal(result.stage, 'completed')
    assert.equal(h.data.definitions.length, 1)
    assert.match(h.data.definitions[0].input.goal, /sales.csv/)
    assert.equal(h.interpretations, 2)
  } finally { h.stop() }
})

test('one-off time that passes during planning asks for a new time without executing late', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), schedule: {
      kind: 'once', timezone: 'UTC', localDateTime: '2026-10-21T08:01', expression: null, description: 'Once at 08:01',
    } } }))
    h.setPlanner(async () => { h.advance(Date.parse('2026-10-21T08:02:00Z')); return plan })
    const result = await h.creation.submit(request)
    assert.equal(result.stage, 'needs_input')
    assert.equal(result.interpretation?.questions[0]?.field, 'schedule')
    assert.equal(h.data.definitions[0].enabled, false)
    assert.equal(h.launches, 0)
  } finally { h.stop() }
})

test('cancel while the planner is awaiting cannot save a late plan or enable the definition', async () => {
  const h = harness()
  let finish!: (value: EmployeeWorkPlan) => void
  h.setPlanner(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = h.creation.submit(request)
    for (let i = 0; !finish && i < 50; i++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(finish)
    const current = h.data.creations![0]
    await h.creation.cancel(current.id, current.revision)
    finish(plan)
    assert.equal((await pending).stage, 'cancelled')
    assert.equal(h.data.definitions[0].enabled, false)
    assert.equal(h.data.definitions[0].plan, null)
  } finally { h.stop() }
})

test('recovering interrupted configuration does not automatically call a model or admit a task', async () => {
  const h = harness()
  try {
    h.setPlanner(async () => { throw new Error('Failure') })
    await h.creation.submit(request)
    await h.repository.update({ memberId: 'm', enterpriseId: 'e' }, data => { data.creations![0].stage = 'planning' })
    const restarted = h.make()
    await restarted.recover()
    assert.equal(h.data.creations![0].stage, 'failed')
    assert.equal(h.interpretations, 1)
    assert.equal(h.plans, 1)
    assert.equal(h.launches, 0)
    restarted.stop()
  } finally { h.stop() }
})
