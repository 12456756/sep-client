import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { scheduledInstant, localDateTime, definitionLabel, recurrenceLabel, runActions, scheduledHomeGroups, scheduledTaskActions } from './scheduled-task-model'
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

const task = { input: { scheduledAt: 200 }, enabled: false, deleted: false, plan: {}, pausedAt: null } as ScheduledDefinition
const menuOptions = { inHistory: false, busy: false, now: 100 }

test('task list menu matches the definition state and keeps deletion last', () => {
  const actions = (definition: ScheduledDefinition, inHistory = false) => scheduledTaskActions(definition, [], { ...menuOptions, inHistory }).map(action => action.id)
  assert.deepEqual(actions({ ...task, plan: null }), ['edit', 'archive'])
  assert.deepEqual(actions({ ...task, enabled: true }), ['edit', 'pause', 'archive'])
  assert.deepEqual(actions({ ...task, pausedAt: 10 }), ['edit', 'resume', 'archive'])
  assert.deepEqual(actions(task, true), ['history', 'reschedule', 'archive'])
  assert.deepEqual(actions({ ...task, deleted: true }, true), ['history'])
})

test('unfinished runs block mutations other than pausing future executions', () => {
  for (const status of ['running', 'waiting_approval', 'review', 'cancelling'] as const) {
    const runs = [{ status }] as ScheduledOccurrence[]
    const enabled = scheduledTaskActions({ ...task, enabled: true }, runs, menuOptions)
    assert.deepEqual(enabled.filter(action => !action.disabledReason).map(action => action.id), ['pause'])
    assert.ok(scheduledTaskActions({ ...task, pausedAt: 10 }, runs, menuOptions).every(action => action.disabledReason))
  }
  const done = [{ status: 'completed' }] as ScheduledOccurrence[]
  assert.ok(scheduledTaskActions({ ...task, enabled: true }, done, menuOptions).every(action => !action.disabledReason))
  assert.ok(scheduledTaskActions({ ...task, enabled: true }, done, { ...menuOptions, busy: true }).every(action => action.disabledReason))
})

test('resume requires an existing plan and an unused future time for one-off tasks', () => {
  const paused = { ...task, pausedAt: 10 }
  const resumeAction = (definition: ScheduledDefinition, runs: ScheduledOccurrence[] = [], now = 100) => scheduledTaskActions(definition, runs, { ...menuOptions, now }).find(action => action.id === 'resume')
  assert.equal(resumeAction(paused)?.disabledReason, undefined)
  assert.match(resumeAction(paused, [], 200)?.disabledReason ?? '', /未来/)
  assert.match(resumeAction(paused, [{ status: 'completed', scheduledAt: 200 }] as ScheduledOccurrence[])?.disabledReason ?? '', /未来/)
  assert.match(resumeAction({ ...paused, plan: null })?.disabledReason ?? '', /工作计划/)
  const recurring = { ...paused, input: { ...paused.input, recurrence: { frequency: 'daily' as const, interval: 1 } } }
  assert.equal(resumeAction(recurring, [], 200)?.disabledReason, undefined)
})
