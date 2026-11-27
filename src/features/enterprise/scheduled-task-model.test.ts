import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { scheduledInstant, localDateTime, definitionLabel, recurrenceLabel, runActions, scheduledTaskActions } from './scheduled-task-model'
import { groupScheduledTasks, indexScheduledRuns, scheduledTaskState } from '../../shared/scheduled-task-state'
import type { ScheduledDefinition, ScheduledOccurrence } from '../../shared/scheduled-tasks'

test('one-off wall times use the selected timezone, rejecting DST gaps and ambiguous hours', () => {
  assert.equal(scheduledInstant('2026-10-21T09:00', 'Asia/Shanghai'), Date.parse('2026-10-21T01:00:00Z'))
  assert.equal(localDateTime(Date.parse('2026-10-21T01:00:00Z'), 'Asia/Shanghai'), '2026-10-21T09:00')
  for (const [value, timezone] of [['2026-03-08T02:30', 'America/New_York'], ['2026-11-01T01:30', 'America/New_York'], ['2026-02-30T09:00', 'UTC'], ['bad', 'UTC']]) {
    assert.throws(() => scheduledInstant(value, timezone))
  }
})

test('homepage groups include each task exactly once and prioritize pending confirmation', () => {
  const base = { enabled: false, deleted: false, nextRunAt: null, plan: {}, updatedAt: 1, input: { scheduledAt: 100 } } as ScheduledDefinition
  const items = [
    { ...base, id: 'draft', plan: null, updatedAt: 20 }, { ...base, id: 'unconfirmed' },
    { ...base, id: 'enabled', enabled: true }, { ...base, id: 'paused', pausedAt: 10, updatedAt: 30 },
    { ...base, id: 'executing' }, { ...base, id: 'finished', updatedAt: 10 },
    { ...base, id: 'deleted', deleted: true, enabled: true },
  ]
  const runs = [
    { definitionId: 'executing', scheduledAt: 100, status: 'waiting_retry' },
    { definitionId: 'finished', scheduledAt: 100, status: 'failed' },
    { definitionId: 'paused', scheduledAt: 100, status: 'running' },
  ] as const
  const grouped = groupScheduledTasks(items, indexScheduledRuns(runs))
  const summary = (rows: typeof grouped.disabled) => rows.map(({ definition, status }) => [definition.id, definitionLabel(status)])
  assert.deepEqual(summary(grouped.disabled), [['unconfirmed', '待启用'], ['draft', '待生成计划'], ['paused', '已暂停']])
  assert.deepEqual(summary(grouped.enabled), [['enabled', '已启用'], ['executing', '等待重试']])
  assert.deepEqual(summary(grouped.history), [['finished', '已结束'], ['deleted', '已删除']])
})

test('rescheduling a single or recurring task does not classify it by old executions', () => {
  const base = { enabled: false, deleted: false, plan: {}, input: { scheduledAt: 200 } } as ScheduledDefinition
  const oldRun = { scheduledAt: 100, status: 'completed' } as const
  assert.deepEqual(scheduledTaskState(base, [oldRun]), { group: 'disabled', state: 'pending' })
  const recurring = { ...base, input: { ...base.input, recurrence: { frequency: 'daily' as const, interval: 1 } } }
  assert.deepEqual(scheduledTaskState(recurring, [oldRun]), { group: 'disabled', state: 'pending' })
  assert.deepEqual(scheduledTaskState(base, [{ scheduledAt: 200, status: 'missed' }]), { group: 'history', state: 'ended' })
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
