import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { occurrenceId, parseEmployeePlan, classifyScheduledError, latestScheduledOccurrence, nextWakeAt, nextScheduledAt } from './scheduled-task'
import { scheduleInputSchema } from '../../src/shared/scheduled-tasks'

test('a planned instant has one stable occurrence independent of definition revisions', () => {
  assert.equal(occurrenceId('task-a', 1000), occurrenceId('task-a', 1000))
  assert.notEqual(occurrenceId('task-a', 1000), occurrenceId('task-a', 1001))
})

test('employee planner accepts a bounded file contract, never a replacement employee', () => {
  const value = { status: 'ready', objective: 'Produce report', instruction: 'Read sources and create report', expectedOutput: 'A usable report',
    deliverables: [{ id: 'report', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Include sources'] }] }
  assert.equal(parseEmployeePlan(JSON.stringify(value)).status, 'ready')
  assert.throws(() => parseEmployeePlan(JSON.stringify({ ...value, subscriptionId: 'other' })))
  assert.throws(() => parseEmployeePlan(JSON.stringify({ ...value, deliverables: [{ ...value.deliverables[0], path: '../report.md' }] })))
  assert.equal(parseEmployeePlan(JSON.stringify({ status: 'blocked', reasons: ['Missing source file'] })).status, 'blocked')
})

test('only explicit transient pre-execution failures permit automatic retries', () => {
  assert.equal(classifyScheduledError({ code: 'NETWORK_ERROR' }).action, 'retry')
  assert.equal(classifyScheduledError({ statusCode: 429, retryAfterMs: 90000 }).retryAfterMs, 90000)
  assert.equal(classifyScheduledError({ statusCode: 403 }).action, 'blocked')
  assert.equal(classifyScheduledError({ code: 'AUTH_REQUIRED' }).action, 'auth')
  assert.equal(classifyScheduledError(new Error('unknown fault')).action, 'review')
})

test('scheduled authorization failures remain distinct and wait for user action', () => {
  const employee = classifyScheduledError({ code: 'EMPLOYEE_UNAVAILABLE' })
  const model = classifyScheduledError({ code: 'MODEL_NOT_ALLOWED' })
  const auth = classifyScheduledError({ statusCode: 401 })
  assert.equal(employee.action, 'blocked')
  assert.match(employee.message, /员工/)
  assert.equal(model.action, 'blocked')
  assert.match(model.message, /模型/)
  assert.equal(auth.action, 'auth')
  assert.match(auth.message, /重新登录/)
})

test('dynamic timer wakes at the earliest deadline with bounded clock calibration', () => {
  assert.equal(nextWakeAt(1000, [2000, 4000]), 2000)
  assert.equal(nextWakeAt(1000, [500000]), 61000)
  assert.equal(nextWakeAt(1000, []), null)
  assert.equal(nextWakeAt(1000, [500]), 1000)
})

test('recurring schedules advance in their timezone and preserve local wall time', () => {
  const first = Date.parse('2026-03-07T14:30:00.000Z') // 09:30 in New York before DST
  const daily = nextScheduledAt(first, { frequency: 'daily', interval: 1 }, 'America/New_York')
  assert.ok(daily !== null)
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(daily), '09:30')
  assert.equal(daily, Date.parse('2026-03-08T13:30:00.000Z'))
})

test('monthly recurrence clamps to the last day of shorter months', () => {
  const first = Date.parse('2026-01-31T09:00:00.000Z')
  const february = nextScheduledAt(first, { frequency: 'monthly', interval: 1 }, 'UTC')!
  assert.equal(february, Date.parse('2026-02-28T09:00:00.000Z'))
  assert.equal(nextScheduledAt(february, { frequency: 'monthly', interval: 1 }, 'UTC', first), Date.parse('2026-03-31T09:00:00.000Z'))
})

test('calendar recurrences restore the original wall time after a DST gap', () => {
  const cases = [
    { frequency: 'daily' as const, anchor: '2026-03-07T07:30:00.000Z', following: '2026-03-09T06:30:00.000Z' },
    { frequency: 'weekly' as const, anchor: '2026-03-01T07:30:00.000Z', following: '2026-03-15T06:30:00.000Z' },
    { frequency: 'monthly' as const, anchor: '2026-02-08T07:30:00.000Z', following: '2026-04-08T06:30:00.000Z' },
  ]
  for (const item of cases) {
    const anchor = Date.parse(item.anchor)
    const rule = { frequency: item.frequency, interval: 1 }
    const gap = nextScheduledAt(anchor, rule, 'America/New_York', anchor)!
    assert.equal(gap, Date.parse('2026-03-08T07:00:00.000Z'), item.frequency)
    const following = nextScheduledAt(gap, rule, 'America/New_York', anchor)!
    assert.equal(following, Date.parse(item.following), item.frequency)
    assert.equal(latestScheduledOccurrence(anchor, following, rule, 'America/New_York')?.timestamp, following, item.frequency)
  }
})

test('calendar recurrence and missed-time lookup preserve milliseconds', () => {
  for (const milliseconds of ['123', '987']) {
    const anchor = Date.parse(`2026-03-07T14:30:00.${milliseconds}Z`)
    const expected = Date.parse(`2026-03-09T13:30:00.${milliseconds}Z`)
    const rule = { frequency: 'daily' as const, interval: 1 }
    const next = nextScheduledAt(anchor, rule, 'America/New_York', anchor)!
    assert.equal(next, Date.parse(`2026-03-08T13:30:00.${milliseconds}Z`))
    assert.equal(nextScheduledAt(next, rule, 'America/New_York', anchor), expected)
    assert.equal(latestScheduledOccurrence(anchor, expected, rule, 'America/New_York')?.timestamp, expected)
  }
})

test('once schedules have no next occurrence and weekly cadence advances calendar weeks', () => {
  const first = Date.parse('2026-10-18T08:00:00.000Z')
  assert.equal(nextScheduledAt(first, { frequency: 'once', interval: 1 }, 'UTC'), null)
  assert.equal(nextScheduledAt(first, { frequency: 'weekly', interval: 2 }, 'UTC'), Date.parse('2026-11-01T08:00:00.000Z'))
})

test('new hourly and selected-weekday rules advance through the same scheduler entry', () => {
  const hourly = { frequency: 'cron' as const, interval: 1 as const, expression: '15 * * * *', preset: 'hourly' as const }
  assert.equal(nextScheduledAt(Date.parse('2026-10-20T09:15:00Z'), hourly, 'UTC'), Date.parse('2026-10-20T10:15:00Z'))
  assert.equal(nextScheduledAt(Date.parse('2026-10-23T01:30:00Z'), { ...hourly, expression: '30 9 * * 1,5', preset: 'weekly' }, 'Asia/Shanghai'), Date.parse('2026-10-26T01:30:00Z'))
})

test('latest due recurrence can be found without iterating every missed time point', () => {
  const anchor = Date.parse('1990-01-01T09:00:00.000Z')
  const cutoff = Date.parse('2026-10-20T09:00:00.000Z')
  const latest = latestScheduledOccurrence(anchor, cutoff, { frequency: 'daily', interval: 1 }, 'UTC')
  assert.ok(latest)
  assert.equal(latest.timestamp, cutoff)
  assert.equal(latest.index, Math.round((cutoff - anchor) / 86400000))
  assert.equal(latestScheduledOccurrence(anchor, anchor - 1, { frequency: 'daily', interval: 1 }, 'UTC'), null)
})

test('schedule IPC input rejects unknown fields, relative paths and unsafe execution permissions', () => {
  const input = { name: 'Report', goal: 'Produce report', subscriptionId: 'sub', modelId: 'model', workDir: 'D:/reports', scheduledAt: 2000,
    timezone: 'Asia/Shanghai', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
  assert.equal(scheduleInputSchema.safeParse(input).success, true)
  for (const patch of [{ workDir: './relative' }, { timezone: 'invalid/zone' }, { scheduledAt: NaN }, { refreshToken: 'never-persist' },
    { subscriptionId: '../other' }, { permissions: { preset: 'read-only', approvalMode: 'auto-approve' } }]) {
    assert.equal(scheduleInputSchema.safeParse({ ...input, ...patch }).success, false)
  }
})
