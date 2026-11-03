import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { scheduleInterpretationSchema, scheduledCreationRequestSchema, scheduledCreationSchema, type ScheduleInterpretation } from './scheduled-creation'

const request = { requestId: '00000000-0000-4000-8000-000000000001', message: 'Produce a report tomorrow at 9',
  modelId: 'model', workDir: 'D:/reports', timezone: 'Asia/Shanghai',
  permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
const ready: ScheduleInterpretation = { status: 'ready', task: { title: 'Report', goal: 'Produce a report', deliverables: ['report.md'],
  execution: { mode: 'employee', subscriptionId: 'researcher' },
  schedule: { kind: 'once', timezone: 'Asia/Shanghai', localDateTime: '2026-10-22T09:00', expression: null, description: null } }, questions: [], reasons: [] }

test('creation requests trim text, allow new or revisioned submissions and reuse ScheduleInput permissions', () => {
  assert.equal(scheduledCreationRequestSchema.parse({ ...request, message: ' report ', modelId: ' model ' }).message, 'report')
  assert.equal(scheduledCreationRequestSchema.parse({ ...request, expectedRevision: 2 }).expectedRevision, 2)
  for (const workDir of ['/tmp/reports', '\\\\server\\share\\reports', 'C:\\reports']) {
    assert.equal(scheduledCreationRequestSchema.safeParse({ ...request, workDir }).success, true)
  }
  for (const invalid of [
    { requestId: 'not-a-uuid' }, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { message: ' ' }, { message: 'x'.repeat(16001) },
    { modelId: 'x'.repeat(161) }, { workDir: 'relative/path' }, { workDir: 'x'.repeat(1025) }, { timezone: 'Invalid/Timezone' }, { timezone: '+08:00' },
    { permissions: { ...request.permissions, tools: true } }, { permissions: { preset: 'unsafe', approvalMode: 'auto-approve' } }, { extra: true },
  ]) assert.equal(scheduledCreationRequestSchema.safeParse({ ...request, ...invalid }).success, false, JSON.stringify(invalid).slice(0, 120))
})

test('ready interpretation is strict at every level and requires complete execution and deliverables', () => {
  assert.deepEqual(scheduleInterpretationSchema.parse(ready), ready)
  for (const value of [
    { ...ready, extra: true }, { ...ready, task: { ...ready.task, workDir: 'C:/private' } },
    { ...ready, task: { ...ready.task, title: null } }, { ...ready, task: { ...ready.task, goal: null } },
    { ...ready, task: { ...ready.task, deliverables: [] } },
    { ...ready, task: { ...ready.task, execution: { mode: 'employee', subscriptionId: null } } },
    { ...ready, task: { ...ready.task, execution: { mode: 'auto', subscriptionId: 'researcher' } } },
    { ...ready, questions: [{ field: 'goal', question: 'What goal?' }] },
    { ...ready, reasons: [{ code: 'MISSING_INFORMATION', message: 'Missing goal' }] },
  ]) assert.equal(scheduleInterpretationSchema.safeParse(value).success, false)
  assert.equal(scheduleInterpretationSchema.safeParse({ ...ready, task: { ...ready.task, execution: { mode: 'auto', subscriptionId: null } } }).success, true)
})

test('ready schedule rejects invalid calendar times, ambiguous DST, mixed kinds and unsupported cron syntax', () => {
  const schedule = ready.task.schedule
  for (const patch of [
    { kind: null }, { localDateTime: null }, { localDateTime: '2026-02-30T09:00' }, { expression: '0 9 * * *' },
    { timezone: 'America/New_York', localDateTime: '2026-03-08T02:30' },
    { timezone: 'America/New_York', localDateTime: '2026-11-01T01:30' },
    { kind: 'cron', expression: null, localDateTime: null },
    { kind: 'cron', expression: '0 9 * * MON', localDateTime: null },
    { kind: 'cron', expression: '0 9 1 * 1', localDateTime: null },
  ]) assert.equal(scheduleInterpretationSchema.safeParse({ ...ready, task: { ...ready.task, schedule: { ...schedule, ...patch } } }).success, false)
  assert.equal(scheduleInterpretationSchema.safeParse({ ...ready, task: { ...ready.task,
    schedule: { ...schedule, kind: 'cron', expression: '30 9 1,15,30 * *', localDateTime: null } } }).success, true)
})

test('ready interpretation bounds the exact combined goal and deliverables text without truncation', () => {
  const deliverables = ['report.md', 'sales.csv']
  const suffix = `\n\nDeliverables:\n${deliverables.map(value => `- ${value}`).join('\n')}`
  const exact = { ...ready, task: { ...ready.task, goal: 'x'.repeat(16000 - suffix.length), deliverables } }
  assert.equal(scheduleInterpretationSchema.safeParse(exact).success, true)
  for (const goal of [exact.task.goal + 'x', 'x'.repeat(16000)]) {
    const parsed = scheduleInterpretationSchema.safeParse({ ...exact, task: { ...exact.task, goal } })
    assert.equal(parsed.success, false)
    if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.path.join('.') === 'task.goal'))
  }
  assert.equal(scheduleInterpretationSchema.safeParse({ ...exact, status: 'needs_input', task: { ...exact.task, goal: 'x'.repeat(16000) },
    questions: [{ field: 'goal', question: 'Please shorten the goal or deliverable requirements.' }] }).success, true)
})

test('clarifications require actionable questions and blocked results require enumerated reasons', () => {
  const partial = { ...ready, status: 'needs_input', task: { ...ready.task, goal: null }, questions: [{ field: 'goal', question: 'What report?' }] }
  assert.equal(scheduleInterpretationSchema.safeParse(partial).success, true)
  assert.equal(scheduleInterpretationSchema.safeParse({ ...partial, questions: [] }).success, false)
  assert.equal(scheduleInterpretationSchema.safeParse({ ...partial, reasons: [{ code: 'MISSING_INFORMATION', message: 'Missing goal' }] }).success, false)
  assert.equal(scheduleInterpretationSchema.safeParse({ ...partial, questions: [{ field: 'permissions', question: 'Allow all?' }] }).success, false)
  assert.equal(scheduleInterpretationSchema.safeParse({ ...ready, status: 'blocked', reasons: [] }).success, false)
  assert.equal(scheduleInterpretationSchema.safeParse({ ...ready, status: 'blocked', reasons: [{ code: 'CAPABILITY_MISMATCH', message: 'Not supported' }], questions: [{ field: 'goal', question: 'Which goal?' }] }).success, false)
  for (const code of ['UNSUPPORTED_SCHEDULE', 'EMPLOYEE_UNAVAILABLE', 'CAPABILITY_MISMATCH', 'UNSUPPORTED_SETTING', 'AMBIGUOUS_SCHEDULE', 'PAST_SCHEDULE', 'INVALID_SCHEDULE', 'MISSING_INFORMATION', 'MODEL_NOT_ALLOWED']) {
    assert.equal(scheduleInterpretationSchema.safeParse({ ...ready, status: 'blocked', reasons: [{ code, message: 'Cannot preserve this request' }] }).success, true)
  }
  assert.equal(scheduleInterpretationSchema.safeParse({ ...ready, status: 'blocked', reasons: [{ code: 'OTHER', message: 'Unknown' }] }).success, false)
})

test('creation records persist separate request data, replay key, fixed reference time and bounded user messages', () => {
  const { requestId, ...savedRequest } = request
  const record = { id: requestId, revision: 1, stage: 'parsing', request: savedRequest, submissionKey: 'fingerprint', parsedSubmissionKey: null, definitionSubmissionKey: null, referenceNow: 1000,
    messages: [{ role: 'user', content: request.message }], interpretation: null, definitionId: null, definitionInput: null, error: null, createdAt: 1000, updatedAt: 1000 }
  assert.deepEqual(scheduledCreationSchema.parse(record), record)
  const timed = { ...record, messages: [{ role: 'user', content: request.message, receivedAt: 1000 }, { role: 'user', content: 'Use PDF', receivedAt: 2000 }] }
  assert.deepEqual(scheduledCreationSchema.parse(timed).messages, timed.messages)
  assert.equal(scheduledCreationSchema.safeParse({ ...timed, messages: [{ ...timed.messages[0], receivedAt: 0 }] }).success, true)
  assert.equal(scheduledCreationSchema.safeParse({ ...record, stage: 'cancelled' }).success, true)
  assert.equal(scheduledCreationSchema.safeParse({ ...record, interpretation: ready }).success, true)
  assert.equal(scheduledCreationSchema.safeParse({ ...record, parsedSubmissionKey: 'old', definitionSubmissionKey: 'old' }).success, true)
  const { parsedSubmissionKey: _parsed, ...missingParsedKey } = record
  const { definitionSubmissionKey: _definition, ...missingDefinitionKey } = record
  assert.equal(scheduledCreationSchema.safeParse(missingParsedKey).success, false)
  assert.equal(scheduledCreationSchema.safeParse(missingDefinitionKey).success, false)
  for (const patch of [
    { revision: 0 }, { submissionKey: '' }, { referenceNow: NaN }, { messages: Array.from({ length: 21 }, () => record.messages[0]) },
    { messages: [{ role: 'assistant', content: 'ok' }] }, { messages: [{ role: 'user', content: 'x'.repeat(16001) }] },
    ...[-1, 1.5, NaN, Infinity, '1000', 8640000000000001].map(receivedAt => ({ messages: [{ role: 'user', content: 'Report', receivedAt }] })),
    { messages: [{ role: 'user', content: 'Report', receivedAt: 1000, extra: true }] },
    { request: { ...savedRequest, requestId } }, { request: { ...savedRequest, expectedRevision: 1 } },
    { definitionInput: {} }, { extra: true },
  ]) assert.equal(scheduledCreationSchema.safeParse({ ...record, ...patch }).success, false)
})
