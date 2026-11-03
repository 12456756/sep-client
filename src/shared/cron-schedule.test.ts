import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { cronPreview, latestCronTime, isValidCron } from './cron-schedule'
import { scheduleInputSchema, scheduleTimeResultSchema } from './scheduled-tasks'

test('hourly schedules run at the selected minute, strictly after the reference instant', () => {
  assert.deepEqual(cronPreview('15 * * * *', 'Asia/Shanghai', Date.parse('2026-10-20T00:15:00Z'), 2), [Date.parse('2026-10-20T01:15:00Z'), Date.parse('2026-10-20T02:15:00Z')])
})
test('weekly selections and monthly custom dates use the selected timezone', () => {
  assert.deepEqual(cronPreview('30 9 * * 1,5', 'Asia/Shanghai', Date.parse('2026-10-20T00:00:00Z'), 2), [Date.parse('2026-10-23T01:30:00Z'), Date.parse('2026-10-26T01:30:00Z')])
  assert.deepEqual(cronPreview('30 9 1,15,30 * *', 'Asia/Shanghai', Date.parse('2026-10-20T00:00:00Z'), 2), [Date.parse('2026-10-30T01:30:00Z'), Date.parse('2026-11-01T01:30:00Z')])
})
test('latest due cron time is inclusive and bounded across long downtime', () => {
  const time = Date.parse('2056-10-20T09:15:00Z')
  assert.equal(latestCronTime('15 * * * *', 'UTC', time), time)
  assert.equal(latestCronTime('15 * * * *', 'UTC', time - 1), time - 3600000)
})

test('calendar schedules retain local time across daylight saving offset changes', () => {
  assert.deepEqual(cronPreview('30 9 * * *', 'America/New_York', Date.parse('2026-03-07T00:00:00Z'), 3), [Date.parse('2026-03-07T14:30:00Z'), Date.parse('2026-03-08T13:30:00Z'), Date.parse('2026-03-09T13:30:00Z')])
  assert.deepEqual(cronPreview('30 9 * * *', 'America/New_York', Date.parse('2026-10-31T00:00:00Z'), 3), [Date.parse('2026-10-31T13:30:00Z'), Date.parse('2026-11-01T14:30:00Z'), Date.parse('2026-11-02T14:30:00Z')])
})
test('cron rejects seconds, macros, invalid dates and ambiguous day combinations', () => {
  for (const value of ['* * * * * *', '@daily', '99 * * * *', '0 9 30 2 *', '0 9 1 * 1']) assert.equal(isValidCron(value), false, value)
  assert.equal(isValidCron('30 9 * * 1,5'), true)
})
test('time interpretation accepts only bounded scheduling output, never execution configuration', () => {
  const result = { status: 'ready', expression: '30 9 1,15,30 * *' }
  assert.equal(scheduleTimeResultSchema.safeParse(result).success, true)
  assert.equal(scheduleTimeResultSchema.safeParse({ ...result, workDir: 'C:/private' }).success, false)
  assert.equal(scheduleTimeResultSchema.safeParse({ status: 'blocked', reasons: ['请明确时间'] }).success, true)
  const input = { name: 'Report', goal: 'Report', subscriptionId: 'sub', modelId: 'model', workDir: 'D:/reports', timezone: 'UTC', scheduledAt: Date.parse('2026-10-20T09:30:00Z'), permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' }, recurrence: { frequency: 'cron', interval: 1, expression: '30 9 * * *', preset: 'daily' } }
  assert.equal(scheduleInputSchema.safeParse(input).success, true)
  assert.equal(scheduleInputSchema.safeParse({ ...input, scheduledAt: input.scheduledAt + 1000 }).success, false)
})
