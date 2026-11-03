import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ArrangementWorkPlan, ScheduledSnapshot, ScheduleInput, EmployeeWorkPlan } from '../../src/shared/scheduled-tasks'
import { ScheduledTaskService } from './scheduled-task-service'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import type { ScheduledServiceOptions } from './scheduled-task-service'
import { BeforeScheduledAdmissionError, type ScheduledRunnerPort } from './scheduled-dispatcher'
import { setLogSink, type LogRecord } from '../common/logger'

const input: ScheduleInput = { name: 'Report', goal: 'Produce report', subscriptionId: 'sub', modelId: 'model', workDir: 'D:/reports', scheduledAt: 2000, timezone: 'Asia/Shanghai', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
const plan: EmployeeWorkPlan = { status: 'ready', objective: 'Report', instruction: 'Produce report', expectedOutput: 'File', deliverables: [{ id: 'file', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Sources'] }] }

const timeRequest = { requestId: 'de60b42c-7871-4ff3-a618-aebf2e51c94a', subscriptionId: 'sub', modelId: 'model', timezone: 'UTC', description: 'Every day at 9' }

test('stopping during scheduler recovery cannot restart its timer', async () => {
  let release!: (data: ScheduledSnapshot) => void
  let recovering = true
  const service = new ScheduledTaskService({
    repository: { read: () => recovering ? new Promise(resolve => { release = resolve }) : Promise.resolve({ definitions: [], occurrences: [] }), update: async () => { throw new Error('unused') } },
    scope: { currentScope: () => ({ memberId: 'm', enterpriseId: 'e' }) }, employee: async () => ({}), planner: async () => plan,
    runner: { async prepare() {}, async launch() { assert.fail('must not launch after stop') }, async inspect() { return { state: 'missing' } }, async cancel() {} },
  })
  try {
    const pending = service.resume()
    const rejection = assert.rejects(pending, { code: 'AUTH_REQUIRED' })
    for (let i = 0; !release && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(release)
    service.stop(); recovering = false; release({ definitions: [], occurrences: [] })
    await rejection
    assert.equal((await service.list()).schedulerState, 'stopped')
  } finally { service.stop() }
})

test('time interpretation authorizes before model access and never persists or starts work', async () => {
  let calls = 0
  const h = harness({}, { timeInterpreter: async () => { calls++; return { status: 'ready', expression: '0 9 * * *' } } })
  try {
    assert.deepEqual(await h.service.interpretTime(timeRequest), { status: 'ready', expression: '0 9 * * *' })
    assert.equal(calls, 1)
    assert.deepEqual(h.data, { definitions: [], occurrences: [] })
    assert.equal(h.starts, 0)
  } finally { h.service.stop() }
  const denied = harness({}, { employee: async () => { throw { code: 'PERMISSION_DENIED' } }, timeInterpreter: async () => { calls++; return { status: 'ready', expression: '0 9 * * *' } } })
  try {
    await assert.rejects(denied.service.interpretTime(timeRequest), { code: 'PERMISSION_DENIED' })
    assert.equal(calls, 1)
  } finally { denied.service.stop() }
})

test('time interpretation is bounded and discards results after logout', async () => {
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'm', enterpriseId: 'e' }
  let finish!: () => void
  const h = harness({}, { scope: { currentScope: () => scope }, timeInterpreter: (_input, signal) => new Promise(resolve => {
    finish = () => { assert.equal(signal.aborted, true); resolve({ status: 'ready', expression: '0 9 * * *' }) }
  }) })
  const pending = h.service.interpretTime(timeRequest)
  for (let i = 0; !finish && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(finish)
  await assert.rejects(h.service.interpretTime(timeRequest), { code: 'CONFLICT' })
  scope = null
  h.service.stop()
  finish()
  await assert.rejects(pending, { code: 'AUTH_REQUIRED' })
  assert.deepEqual(h.data, { definitions: [], occurrences: [] })
})

test('time interpretation rejects empty authorization results before calling the model', async () => {
  for (const employee of [null, undefined, false]) {
    const h = harness({}, { employee: async () => employee, timeInterpreter: async () => { assert.fail('authorization must precede model access') } })
    try { await assert.rejects(h.service.interpretTime(timeRequest), { code: 'EMPLOYEE_UNAVAILABLE' }) }
    finally { h.service.stop() }
  }
})
test('list cannot disclose a snapshot after the signed-in scope changes', async () => {
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'first', enterpriseId: 'e' }
  let resolve!: (value: ScheduledSnapshot) => void
  const service = new ScheduledTaskService({
    repository: { read: () => new Promise(done => { resolve = done }), update: async () => { throw new Error('unused') } },
    scope: { currentScope: () => scope }, employee: async () => ({}), planner: async () => plan,
    runner: { async prepare() {}, async launch() {}, async inspect() { return { state: 'missing' } }, async cancel() {} },
  })
  const pending = service.list()
  scope = { memberId: 'second', enterpriseId: 'e' }
  resolve({ definitions: [], occurrences: [] })
  await assert.rejects(pending, { code: 'AUTH_REQUIRED' })
  service.stop()
})
function harness(overrides: Partial<ScheduledRunnerPort> = {}, serviceOverrides: Partial<ScheduledServiceOptions> = {}) {
  let data: ScheduledSnapshot = { definitions: [], occurrences: [] }
  let now = 1000
  let starts = 0
  let plans = 0
  const scope = { memberId: 'm', enterpriseId: 'e' }
  const repo: ScheduledRepository = { async read() { return structuredClone(data) }, async update(_scope, change) {
    const next = structuredClone(data); const result = change(next); data = next; return structuredClone(result)
  } }
  const service = new ScheduledTaskService({ repository: repo, scope: { currentScope: () => scope }, now: () => now,
    planner: async () => { plans++; return plan }, employee: async () => ({ name: 'Researcher' }),
    runner: { async prepare() {}, async launch() { starts++ }, async inspect() { return { state: 'running' as const } }, async cancel() {}, ...overrides },
    ...serviceOverrides,
  })
  return { service, get data() { return data }, get starts() { return starts }, get plans() { return plans }, advance(value: number) { now = value } }
}
test('create, plan, confirm, repeated scans and restart do not duplicate a scheduled launch', async () => {
  const h = harness()
  const created = await h.service.create('request-a', input)
  assert.equal((await h.service.create('request-a', input)).id, created.id)
  h.advance(3000)
  assert.equal((await h.service.create('request-a', input)).id, created.id)
  h.advance(1000)
  const planned = await h.service.plan(created.id, created.revision)
  const confirmed = await h.service.confirm(created.id, planned.revision)
  assert.equal(confirmed.enabled, true)
  h.advance(2000)
  await h.service.scan()
  await h.service.scan()
  assert.equal(h.data.occurrences.length, 1)
  assert.equal(h.starts, 1)
  await h.service.recover()
  assert.equal(h.starts, 1)
  h.service.stop()
})

async function enable(h: ReturnType<typeof harness>, requestId = 'test', configured = input) {
  const task = await h.service.create(requestId, configured)
  const planned = await h.service.plan(task.id, task.revision)
  await h.service.confirm(task.id, planned.revision)
  h.advance(2000)
  return task
}

test('pausing a definition preserves the already created occurrence and its outcome', async () => {
  const h = harness({ async prepare() { throw { code: 'NETWORK_ERROR' } } })
  const created = await enable(h)
  await h.service.scan()
  const before = h.data.occurrences[0]
  const definition = h.data.definitions.find(item => item.id === created.id)!
  await h.service.pause(definition.id, definition.revision)
  assert.deepEqual(h.data.occurrences[0], before)
  assert.equal(h.data.definitions[0].enabled, false)
  assert.equal(h.data.definitions[0].pausedAt, null)
  h.service.stop()
})

test('explicit pause metadata is cleared by resume, editing or deletion without new definitions', async () => {
  const h = harness()
  try {
    const created = await h.service.create('pause-marker', input)
    const planned = await h.service.plan(created.id, created.revision)
    let current = await h.service.confirm(created.id, planned.revision)
    await h.service.pause(current.id, current.revision)
    current = h.data.definitions[0]
    assert.equal(current.pausedAt, 1000)
    current = await h.service.confirm(current.id, current.revision)
    assert.equal(current.pausedAt, null)
    await h.service.pause(current.id, current.revision)
    current = h.data.definitions[0]
    current = await h.service.edit(current.id, current.revision, { ...input, scheduledAt: 4000 })
    assert.equal(current.pausedAt, null)
    await h.service.pause(current.id, current.revision, true)
    assert.equal(h.data.definitions[0].pausedAt, null)
    assert.equal(h.data.definitions[0].deleted, true)
    assert.equal(h.data.definitions.length, 1)
  } finally { h.service.stop() }
})

test('explicit review acknowledgement cannot accidentally restart a blocked occurrence', async () => {
  const h = harness({ async prepare() { throw { code: 'MODEL_NOT_ALLOWED' } } })
  const logs: LogRecord[] = []
  const restore = setLogSink(record => logs.push(record))
  try {
    await enable(h)
    await h.service.scan()
    const run = h.data.occurrences[0]
    assert.equal(run.status, 'blocked')
    const failed = logs.find(record => record.message.includes('[SCHEDULED TASK] START FAILED'))
    assert.ok(failed)
    assert.equal(failed.fields.scheduledTaskId, run.definitionId)
    assert.equal(failed.fields.occurrenceId, run.id)
    assert.equal(failed.fields.taskId, run.taskId)
    assert.equal(failed.fields.errorCode, 'MODEL_NOT_ALLOWED')
    assert.equal(failed.fields.action, 'blocked')
    assert.ok(logs.some(record => record.message.includes('[SCHEDULED TASK] STATE BLOCKED')))
    await assert.rejects(h.service.check(run.id, true))
    assert.equal(h.data.occurrences[0].status, 'blocked')
  } finally { restore(); h.service.stop() }
})
test('temporary preflight failures retry finitely, preserving one occurrence and attempts', async () => {
  const h = harness({ async prepare() { throw { code: 'NETWORK_ERROR' } } })
  await enable(h)
  for (let i = 0; i < 4; i++) {
    await h.service.scan()
    if (h.data.occurrences[0].nextRetryAt) h.advance(h.data.occurrences[0].nextRetryAt!)
  }
  assert.equal(h.starts, 0)
  assert.equal(h.data.occurrences.length, 1)
  assert.equal(h.data.occurrences[0].status, 'failed')
  assert.equal(h.data.occurrences[0].attempts.length, 4)
  h.service.stop()
})
test('Retry-After cannot be shortened to beat the launch deadline', async () => {
  const h = harness({ async prepare() { throw { statusCode: 429, retryAfterMs: 7200000 } } })
  await enable(h); await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'failed')
  assert.equal(h.starts, 0)
  h.service.stop()
})
test('login and explicit permissions wait without spinning or repeated attempts', async () => {
  for (const code of ['AUTH_REQUIRED', 'PERMISSION_DENIED']) {
    const h = harness({ async prepare() { throw { code } } })
    await enable(h); await h.service.scan(); await h.service.scan()
    assert.equal(h.data.occurrences[0].status, code === 'AUTH_REQUIRED' ? 'waiting_auth' : 'blocked')
    assert.equal(h.data.occurrences[0].attempts.length, 1)
    h.advance(h.data.occurrences[0].startDeadline); await h.service.scan()
    assert.equal(h.data.occurrences[0].status, 'failed')
    h.service.stop()
  }
})
test('launch failures retry only when the adapter proves no admission took place', async () => {
  const safe = harness({ async launch() { throw new BeforeScheduledAdmissionError({ code: 'NETWORK_ERROR' }) } })
  await enable(safe); await safe.service.scan()
  assert.equal(safe.data.occurrences[0].status, 'waiting_retry'); safe.service.stop()
  const unknown = harness({ async launch() { throw { code: 'NETWORK_ERROR' } } })
  await enable(unknown); await unknown.service.scan(); await unknown.service.scan()
  assert.equal(unknown.data.occurrences[0].status, 'review')
  assert.equal(unknown.data.occurrences[0].attempts.length, 1); unknown.service.stop()
})
test('long downtime produces a missed record without executing', async () => {
  const h = harness(); await enable(h); h.advance(86400000 + 2001); await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'missed'); assert.equal(h.starts, 0); h.service.stop()
})
test('cancellation during preflight cannot launch the late result', async () => {
  let release!: () => void
  const h = harness({ prepare: () => new Promise<void>(resolve => { release = resolve }) })
  await enable(h)
  const scan = h.service.scan()
  for (let i = 0; !release && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  await h.service.cancel(h.data.occurrences[0].id)
  release(); await scan
  assert.equal(h.starts, 0); assert.equal(h.data.occurrences[0].status, 'cancelled'); h.service.stop()
})
test('concurrent scans use the same claim and completed occurrences never launch again', async () => {
  let done = false
  const h = harness({ async inspect() { return { state: done ? 'completed' : 'running' } } })
  await enable(h); await Promise.all([h.service.scan(), h.service.scan(), h.service.scan()])
  assert.equal(h.starts, 1)
  done = true; await h.service.scan(); await h.service.recover(); await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'completed'); assert.equal(h.starts, 1); h.service.stop()
})
test('queued work is delayed when another scheduled execution occupies capacity', async () => {
  const h = harness(); await enable(h, 'first')
  h.advance(1000); await enable(h, 'second')
  await h.service.scan(); await h.service.scan()
  assert.equal(h.starts, 1)
  const waiting = h.data.occurrences.find(run => run.status === 'waiting_retry')
  assert.ok(waiting && waiting.nextRetryAt! > 2000)
  assert.equal(waiting.attempts.length, 0)
  h.service.stop()
})
test('editing a definition retains its ID and invalidates the plan only for work changes', async () => {
  const h = harness()
  const created = await h.service.create('request-b', input)
  const planned = await h.service.plan(created.id, created.revision)
  const edited = await h.service.edit(created.id, planned.revision, { ...input, scheduledAt: 3000 })
  assert.equal(edited.id, created.id)
  assert.ok(edited.plan)
  await h.service.plan(edited.id, edited.revision)
  assert.equal(h.plans, 1, 'Time-only edits reuse the confirmed contract')
  await assert.rejects(h.service.edit(created.id, planned.revision, input))
  const changed = await h.service.edit(created.id, edited.revision, { ...input, goal: 'Different report' })
  assert.equal(changed.plan, null)
  assert.equal(h.data.definitions.length, 1)
  h.service.stop()
})
test('launch-intent uncertainty after a crash never triggers a fresh launch', async () => {
  const h = harness()
  const task = await h.service.create('request-c', input)
  const planned = await h.service.plan(task.id, task.revision)
  await h.service.confirm(task.id, planned.revision)
  h.advance(2000)
  await h.service.scan()
  h.data.occurrences[0].status = 'launching'
  await h.service.recover()
  assert.equal(h.data.occurrences[0].status, 'review')
  assert.equal(h.starts, 1)
  h.service.stop()
})

test('an expired paused or unconfirmed schedule cannot be explicitly re-enabled', async () => {
  const h = harness()
  const created = await h.service.create('paused', input)
  const planned = await h.service.plan(created.id, created.revision)
  h.advance(3000)
  await assert.rejects(h.service.confirm(created.id, planned.revision), { code: 'INVALID_ARGUMENT' })
  h.service.stop()
})

test('a paused recurring definition resumes at the next future cadence point', async () => {
  let completed = false
  const h = harness({ async inspect() { return { state: completed ? 'completed' : 'running' } } })
  const recurring = { ...input, recurrence: { frequency: 'daily' as const, interval: 1 } }
  const created = await h.service.create('resume-daily', recurring)
  const planned = await h.service.plan(created.id, created.revision)
  await h.service.confirm(created.id, planned.revision)
  h.advance(2000); await h.service.scan()
  completed = true; await h.service.scan()
  const activeDefinition = h.data.definitions[0]!
  await h.service.pause(activeDefinition.id, activeDefinition.revision)
  h.advance(4 * 86400000 + 1000)
  const resumed = await h.service.confirm(created.id, h.data.definitions[0]!.revision)
  assert.equal(resumed.enabled, true)
  assert.equal(resumed.nextRunAt, Date.parse('1970-01-05T00:00:02.000Z'))
  h.service.stop()
})

test('review acknowledgment closes the occurrence without replaying it', async () => {
  const h = harness({ async launch() { throw new Error('uncertain') }, async inspect() { return { state: 'interrupted' } } })
  await enable(h); await h.service.scan()
  const run = h.data.occurrences[0]
  assert.equal(run.status, 'review')
  await assert.rejects(h.service.check(run.id), /核查/)
  await h.service.check(run.id, true)
  assert.equal(h.data.occurrences[0].status, 'cancelled')
  await h.service.scan()
  assert.equal(h.data.occurrences[0].attempts.length, 1)
  h.service.stop()
})

test('cancelling an in-flight launch invalidates its admission guard', async () => {
  let release!: () => void
  let admitted = false
  const h = harness({
    async launch(_run, guard) { await new Promise<void>(resolve => { release = resolve }); guard(); admitted = true },
    async inspect() { return { state: 'missing' } },
  })
  await enable(h)
  const scan = h.service.scan()
  for (let i = 0; !release && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  await h.service.cancel(h.data.occurrences[0].id)
  release(); await scan
  assert.equal(admitted, false)
  assert.equal(h.data.occurrences[0].status, 'review')
  h.service.stop()
})

test('stopping a service while preflight awaits never admits the late result', async () => {
  let release!: () => void
  const h = harness({ async prepare(_run, guard) { await new Promise<void>(resolve => { release = resolve }); guard() } })
  await enable(h)
  const scan = h.service.scan()
  for (let i = 0; !release && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  h.service.stop(); release()
  await assert.rejects(scan)
  assert.equal(h.starts, 0)
  await h.service.recover()
  assert.equal(h.data.occurrences[0].status, 'pending')
})

test('approval transitions remain in the same occurrence and never trigger a second admission', async () => {
  let state: 'running' | 'waiting_approval' | 'completed' = 'running'
  const h = harness({ async inspect() { return { state } } })
  await enable(h); await h.service.scan()
  state = 'waiting_approval'; await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'waiting_approval')
  state = 'running'; await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'running')
  state = 'completed'; await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'completed')
  assert.equal(h.starts, 1); h.service.stop()
})

test('runtime timeout requests cancellation and records timeout without task replay', async () => {
  let stopped = false
  const h = harness({ async inspect() { return { state: stopped ? 'failed' : 'running' } }, async cancel() { stopped = true } })
  await enable(h); await h.service.scan()
  h.advance(3602001); await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'cancelling')
  await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'timed_out')
  assert.equal(h.starts, 1); h.service.stop()
})

test('catch-up inside the 24 hour window creates one late occurrence', async () => {
  const h = harness(); await enable(h)
  h.advance(2000 + 2 * 3600000); await h.service.scan(); await h.service.scan()
  assert.equal(h.starts, 1)
  assert.equal(h.data.occurrences[0].scheduledAt, 2000)
  assert.equal(h.data.occurrences[0].status, 'running')
  h.service.stop()
})

test('recurring definitions stay enabled, advance their deadline, and create one run per due instant', async () => {
  const h = harness()
  const recurring = { ...input, recurrence: { frequency: 'daily' as const, interval: 1 } }
  const task = await h.service.create('daily', recurring)
  const planned = await h.service.plan(task.id, task.revision)
  await h.service.confirm(task.id, planned.revision)
  h.advance(2000)
  await h.service.scan()
  const firstNext = h.data.definitions[0]!.nextRunAt
  assert.equal(h.data.definitions[0]!.enabled, true)
  assert.equal(firstNext, Date.parse('1970-01-02T00:00:02.000Z'))
  await h.service.scan()
  assert.equal(h.data.occurrences.length, 1)
  h.advance(firstNext!)
  await h.service.scan()
  assert.equal(h.data.occurrences.length, 2)
  assert.equal(h.data.definitions[0]!.enabled, true)
  assert.equal(h.data.definitions[0]!.nextRunAt, Date.parse('1970-01-03T00:00:02.000Z'))
  h.service.stop()
})

test('multi-employee plans are generated once and the same immutable DAG is reused by recurring occurrences', async () => {
  let planningCalls = 0
  const arrangement: ArrangementWorkPlan = { status: 'ready', kind: 'arrangement', title: 'Research and report', intentAnalysis: null,
    nodes: [
      { id: 'research', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Research', instruction: 'Gather facts', expectedOutput: 'Evidence', deliverables: [{ id: 'evidence', name: 'Evidence', format: 'md', path: 'evidence.md', contentOutline: ['Sources'], acceptanceCriteria: ['Cited'] }], dependsOn: [], skillIds: [], requiresUserConfirmation: false },
      { id: 'report', subscriptionId: 'sub-b', modelId: 'model-b', title: 'Report', instruction: 'Write report', expectedOutput: 'Report', deliverables: [{ id: 'report-file', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Complete'] }], dependsOn: ['research'], skillIds: [], requiresUserConfirmation: false },
    ] }
  const h = harness({}, { arrangementPlanner: async () => { planningCalls++; return arrangement } })
  const recurring = { ...input, mode: 'auto' as const, recurrence: { frequency: 'daily' as const, interval: 1 } }
  const created = await h.service.create('auto-daily', recurring)
  const planned = await h.service.plan(created.id, created.revision)
  assert.equal(planned.plan?.kind, 'arrangement')
  await h.service.confirm(created.id, planned.revision)
  h.advance(2000); await h.service.scan()
  const next = h.data.definitions[0]!.nextRunAt!
  h.advance(next); await h.service.scan()
  assert.equal(planningCalls, 1)
  assert.equal(h.data.occurrences.length, 2)
  assert.deepEqual(h.data.occurrences.map(run => run.plan), [arrangement, arrangement])
  h.service.stop()
})

test('downtime catch-up records each missed cadence point but admits only the latest due run', async () => {
  const h = harness()
  const recurring = { ...input, recurrence: { frequency: 'daily' as const, interval: 1 } }
  const created = await h.service.create('offline-daily', recurring)
  const planned = await h.service.plan(created.id, created.revision)
  await h.service.confirm(created.id, planned.revision)
  h.advance(4 * 86400000 + 2000)
  await h.service.scan()
  const occurrences = h.data.occurrences.filter(run => run.definitionId === created.id)
  assert.equal(occurrences.length, 5)
  assert.equal(occurrences.filter(run => run.status === 'missed').length, 4)
  assert.equal(occurrences.filter(run => run.status === 'running').length, 1)
  assert.equal(occurrences.find(run => run.status === 'running')?.scheduledAt, 4 * 86400000 + 2000)
  h.service.stop()
})

test('very long downtime is coalesced and advances recurrence without failing the scan', async () => {
  const h = harness()
  const recurring = { ...input, recurrence: { frequency: 'daily' as const, interval: 1 } }
  const created = await h.service.create('long-offline-daily', recurring)
  const planned = await h.service.plan(created.id, created.revision)
  await h.service.confirm(created.id, planned.revision)
  h.advance(30 * 365 * 86400000 + 2000)
  await h.service.scan()
  const definition = h.data.definitions.find(item => item.id === created.id)!
  const runs = h.data.occurrences.filter(run => run.definitionId === created.id)
  assert.equal(definition.enabled, true)
  assert.ok(definition.nextRunAt! > h.data.occurrences[0]!.scheduledAt)
  assert.ok(definition.nextRunAt! > 30 * 365 * 86400000 + 2000)
  assert.equal(runs.length, 2)
  assert.ok(runs.some(run => run.error?.code === 'MISFIRE_COALESCED'))
  assert.equal(runs.filter(run => run.status === 'pending').length, 0)
  h.service.stop()
})

test('hourly scheduling survives prolonged downtime and repeated scans without duplicate admission', async () => {
  const h = harness()
  const start = Date.parse('2026-10-20T09:15:00Z')
  const created = await h.service.create('hourly', { ...input, timezone: 'UTC', scheduledAt: start, recurrence: { frequency: 'cron', interval: 1, expression: '15 * * * *', preset: 'hourly' } })
  const planned = await h.service.plan(created.id, created.revision)
  await h.service.confirm(created.id, planned.revision)
  h.advance(start + 2000 * 3600000)
  await h.service.scan(); await h.service.scan()
  assert.equal(h.data.occurrences.length, 2)
  assert.equal(h.starts, 1)
  assert.equal(h.data.definitions[0]!.nextRunAt, start + 2001 * 3600000)
  h.service.stop()
})

test('a review reservation does not block scheduled work in an unrelated workspace', async () => {
  let executions = 0
  const h = harness({
    async launch(run) { if (run.input.workDir === input.workDir) throw new Error('uncertain'); executions++ },
    async conflicts(left, right) { return left.input.workDir === right.input.workDir },
  })
  await enable(h, 'first'); h.advance(1000)
  await enable(h, 'second', { ...input, workDir: 'D:/other' })
  await h.service.scan(); await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'review')
  assert.equal(h.data.occurrences[1].status, 'running')
  assert.equal(executions, 1)
  h.service.stop()
})

test('late cancellation failures cannot overwrite an already settled terminal occurrence', async () => {
  let rejectCancel!: (error: Error) => void
  let completed = false
  const h = harness({ async inspect() { return { state: completed ? 'completed' : 'running' } },
    cancel: () => new Promise<void>((_resolve, reject) => { rejectCancel = reject }) })
  await enable(h); await h.service.scan()
  const cancelling = h.service.cancel(h.data.occurrences[0].id)
  for (let i = 0; !rejectCancel && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  completed = true; await h.service.scan()
  assert.equal(h.data.occurrences[0].status, 'cancelled')
  rejectCancel(new Error('late transport failure')); await cancelling
  assert.equal(h.data.occurrences[0].status, 'cancelled')
  h.service.stop()
})

test('deleting an active scheduled definition is rejected at the service boundary', async () => {
  const h = harness(); await enable(h); await h.service.scan()
  const definition = h.data.definitions[0]
  await assert.rejects(h.service.pause(definition.id, definition.revision, true))
  assert.equal(h.data.definitions[0].deleted, false)
  h.service.stop()
})
