import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { cronPreview } from '../../shared/cron-schedule'
import { initialTiming, timingConfiguration, tomorrowTiming } from './scheduled-time-form'

const now = Date.parse('2026-10-20T00:00:00Z')

test('work import defaults to tomorrow at the opening wall clock, including DST and year rollover', () => {
  for (const [instant, zone, expected] of [
    ['2026-12-31T05:47:59Z', 'Asia/Shanghai', '2027-01-01T13:47'],
    ['2026-03-07T14:30:00Z', 'America/New_York', '2026-03-08T09:30'],
    ['2026-10-31T13:30:00Z', 'America/New_York', '2026-11-01T09:30'],
  ]) {
    const value = tomorrowTiming(Date.parse(instant!), zone!)
    assert.equal(value.kind, 'once')
    assert.equal(value.onceAt, expected)
    assert.equal(timingConfiguration(value, Date.parse(instant!)).recurrence.frequency, 'once')
  }
})
test('form maps hourly, daily and multiple weekdays into executable rules', () => {
  const base = { ...initialTiming(undefined, now), timezone: 'Asia/Shanghai', clock: '09:30' }
  assert.equal(timingConfiguration({ ...base, kind: 'hourly', minute: 15 }, now).scheduledAt, Date.parse('2026-10-20T00:15:00Z'))
  assert.equal(timingConfiguration({ ...base, kind: 'daily' }, now).scheduledAt, Date.parse('2026-10-20T01:30:00Z'))
  assert.equal(timingConfiguration({ ...base, kind: 'weekly', weekdays: [1, 5] }, now).scheduledAt, Date.parse('2026-10-23T01:30:00Z'))
  assert.throws(() => timingConfiguration({ ...base, kind: 'weekly', weekdays: [] }, now), /至少选择/)
})
test('custom schedules cannot be saved without a confirmed interpretation in the selected timezone', () => {
  const base = { ...initialTiming(undefined, now), kind: 'custom' as const, timezone: 'UTC' }
  assert.throws(() => timingConfiguration(base, now), /确认/)
  const custom = { description: '每月1号早上9点', expression: '0 9 1 * *', timezone: 'UTC' }
  assert.equal(timingConfiguration({ ...base, custom }, now).scheduledAt, Date.parse('2026-11-01T09:00:00Z'))
  assert.throws(() => timingConfiguration({ ...base, custom, timezone: 'Asia/Shanghai' }, now), /确认/)
})

test('editing an existing weekly schedule preserves its original weekday', () => {
  const scheduledAt = Date.parse('2026-10-25T01:30:00Z')
  const timing = initialTiming({ name: 'Report', goal: 'Report', subscriptionId: 'sub', modelId: 'model', workDir: 'D:/reports', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' }, timezone: 'Asia/Shanghai', scheduledAt, recurrence: { frequency: 'weekly', interval: 1 } }, now)
  assert.deepEqual(timing.weekdays, [0])
  assert.equal(timingConfiguration(timing, now).scheduledAt, scheduledAt)
})

test('daily schedules created through a conversation use the clock control, not their saved preset or timestamp', () => {
  const timing = initialTiming({ scheduledAt: now, timezone: 'Asia/Shanghai', recurrence: { frequency: 'cron', interval: 1, preset: 'custom', expression: '00 16 * * *' } }, now)
  assert.equal(timing.kind, 'daily')
  assert.equal(timing.clock, '16:00')
  const updated = timingConfiguration({ ...timing, clock: '17:30' }, now)
  assert.deepEqual(updated.recurrence, { frequency: 'cron', interval: 1, preset: 'daily', expression: '30 17 * * *' })
  assert.equal(updated.scheduledAt, Date.parse('2026-10-20T09:30:00Z'))
})

test('hourly, weekday ranges, Sunday aliases and month dates round-trip the same schedule', () => {
  const timezone = 'America/New_York'
  for (const [expression, kind, selected] of [
    ['15 * * * *', 'hourly', 15],
    ['30 9 * * 1-5,7', 'weekly', [0, 1, 2, 3, 4, 5]],
    ['30 9 1,15,31 * *', 'monthly-days', [1, 15, 31]],
  ] as const) {
    const timing = initialTiming({ scheduledAt: now, timezone, recurrence: { frequency: 'cron', interval: 1, preset: 'custom', expression } }, now)
    assert.equal(timing.kind, kind)
    assert.deepEqual(kind === 'hourly' ? timing.minute : kind === 'weekly' ? timing.weekdays : timing.monthDays, selected)
    assert.deepEqual(timingConfiguration(timing, now).preview, cronPreview(expression, timezone, now))
  }
})

test('changing monthly selections skips months without the selected date', () => {
  const timing = initialTiming({ scheduledAt: now, timezone: 'Asia/Shanghai' }, now)
  const value = { ...timing, kind: 'monthly-days' as const, clock: '09:30', monthDays: [31] }
  const result = timingConfiguration(value, now)
  assert.deepEqual(result.preview.slice(0, 2), ['2026-10-31T01:30:00Z', '2026-12-31T01:30:00Z'].map(Date.parse))
  assert.throws(() => timingConfiguration({ ...value, monthDays: [] }, now), /至少选择一个运行日期/)
})

test('older rules that cannot be represented by controls keep their original expression', () => {
  for (const expression of ['*/15 * * * *', '0 9,16 * * *', '0 10 * 1,7 1-5']) {
    const recurrence = { frequency: 'cron', interval: 1, preset: 'custom', expression, description: '原有时间安排' } as const
    const timing = initialTiming({ scheduledAt: now, timezone: 'Asia/Shanghai', recurrence }, now)
    assert.equal(timing.kind, 'custom')
    assert.deepEqual(timingConfiguration(timing, now).recurrence, recurrence)
  }
})
