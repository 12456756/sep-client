import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { scheduledInstant, localDateTime, definitionLabel, recurrenceLabel, runActions, scheduledHomeGroups } from './scheduled-task-model'
import type { ScheduledDefinition, ScheduledOccurrence } from '../../shared/scheduled-tasks'

test('one-off wall times use the selected timezone, rejecting DST gaps and ambiguous hours', () => {
  assert.equal(scheduledInstant('2026-10-21T09:00', 'Asia/Shanghai'), Date.parse('2026-10-21T01:00:00Z'))
  assert.equal(localDateTime(Date.parse('2026-10-21T01:00:00Z'), 'Asia/Shanghai'), '2026-10-21T09:00')
  for (const [value, timezone] of [['2026-03-08T02:30', 'America/New_York'], ['2026-11-01T01:30', 'America/New_York'], ['2026-02-30T09:00', 'UTC'], ['bad', 'UTC']]) {
    assert.throws(() => scheduledInstant(value, timezone))
  }
})

test('definition state is not inferred from the last execution outcome', () => {
  const definition = { enabled: true, plan: {}, nextRunAt: 100 } as ScheduledDefinition
  assert.equal(definitionLabel(definition), '已启用')
  assert.equal(definitionLabel({ ...definition, enabled: false, nextRunAt: null }), '未启用')
  assert.equal(definitionLabel({ ...definition, enabled: false, plan: null }), '草稿')
  assert.equal(definitionLabel({ ...definition, enabled: false, pausedAt: 50 }), '已暂停')
})

test('homepage groups distinguish explicit pauses, enabled schedules and unfinished executions', () => {
  const base = { enabled: false, deleted: false, nextRunAt: null, plan: {}, updatedAt: 1 } as ScheduledDefinition
  const items = [
    { ...base, id: 'draft', plan: null }, { ...base, id: 'unconfirmed' },
    { ...base, id: 'enabled', enabled: true }, { ...base, id: 'paused', pausedAt: 10 },
    { ...base, id: 'executing' }, { ...base, id: 'finished' },
    { ...base, id: 'deleted', deleted: true, enabled: true },
  ]
  const runs = [{ definitionId: 'executing', status: 'running' }, { definitionId: 'finished', status: 'completed' }, { definitionId: 'paused', status: 'running' }] as ScheduledOccurrence[]
  const grouped = scheduledHomeGroups(items, runs)
  assert.deepEqual(grouped.active.map(item => item.id), ['enabled', 'executing'])
  assert.deepEqual(grouped.paused.map(item => item.id), ['paused'])
  assert.deepEqual(grouped.pending.map(item => item.id), ['draft', 'unconfirmed'])
  assert.deepEqual(grouped.history.map(item => item.id), ['finished', 'deleted'])
  assert.deepEqual(scheduledHomeGroups([], []), { active: [], paused: [], pending: [], history: [] })
  assert.equal(items[0]!.id, 'draft')
})

test('recurrence labels distinguish one-off and recurring definitions', () => {
  const definition = { input: { scheduledAt: 1000 } } as ScheduledDefinition
  assert.equal(recurrenceLabel(definition), '仅执行一次')
  assert.equal(recurrenceLabel({ ...definition, input: { ...definition.input, recurrence: { frequency: 'daily', interval: 1 } } } as ScheduledDefinition), '每天执行')
  assert.equal(recurrenceLabel({ ...definition, input: { ...definition.input, recurrence: { frequency: 'weekly', interval: 2 } } } as ScheduledDefinition), '每 2 周执行')
})

test('uncertain execution permits review but never offers replay or a generic retry', () => {
  assert.deepEqual(runActions('review'), ['inspect', 'acknowledge', 'cancel'])
  assert.deepEqual(runActions('blocked'), ['inspect', 'check', 'cancel'])
  assert.deepEqual(runActions('completed'), ['inspect'])
})
