import type { RecurrenceRule, ScheduleInput } from '../../shared/scheduled-tasks'
import { cronPreview } from '../../shared/cron-schedule'
import { localDateTime, scheduledInstant } from './scheduled-task-model'

export type RepeatKind = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'
export interface ScheduleTiming {
  kind: RepeatKind
  timezone: string
  clock: string
  minute: number
  weekdays: number[]
  onceAt: string
  interval: number
  custom: { expression: string; description: string; timezone: string } | null
}
export const WEEKDAYS = [{ value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' }, { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' }, { value: 0, label: '周日' }]

export function tomorrowTiming(now = Date.now(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): ScheduleTiming {
  const local = localDateTime(now, timezone)
  const date = new Date(`${local.slice(0, 10)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return { ...initialTiming(undefined, now), kind: 'once', timezone, clock: local.slice(11), minute: Number(local.slice(14)),
    onceAt: `${date.toISOString().slice(0, 10)}T${local.slice(11)}` }
}

export function initialTiming(input?: ScheduleInput | Pick<ScheduleInput, 'scheduledAt' | 'timezone' | 'recurrence'>, now = Date.now()): ScheduleTiming {
  const timezone = input?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const local = localDateTime(input?.scheduledAt ?? now + 3600000, timezone)
  const rule = input?.recurrence
  const state: ScheduleTiming = { kind: rule?.frequency === 'cron' ? rule.preset : rule?.frequency ?? 'daily', timezone, clock: local.slice(11), minute: Number(local.slice(14)), weekdays: [1, 2, 3, 4, 5], onceAt: local, interval: rule?.interval ?? 1, custom: null }
  if (rule?.frequency === 'weekly') state.weekdays = [new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay()]
  if (rule?.frequency === 'cron') {
    const parts = rule.expression.split(/\s+/)
    if (rule.preset === 'custom') state.custom = { expression: rule.expression, description: rule.description ?? rule.expression, timezone }
    else if (rule.preset === 'weekly') state.weekdays = parts[4]!.split(',').map(Number)
  }
  return state
}

export function timingConfiguration(value: ScheduleTiming, now = Date.now()): { recurrence: RecurrenceRule; scheduledAt: number; preview: number[] } {
  new Intl.DateTimeFormat('en', { timeZone: value.timezone })
  if (value.kind === 'once' || value.kind === 'monthly' || (['daily', 'weekly'].includes(value.kind) && value.interval > 1)) {
    const scheduledAt = scheduledInstant(value.onceAt, value.timezone)
    if (scheduledAt <= now) throw new Error('请选择未来的首次执行时间。')
    return { scheduledAt, recurrence: { frequency: value.kind as 'once' | 'monthly' | 'daily' | 'weekly', interval: value.interval }, preview: [scheduledAt] }
  }
  const [hour, minute] = value.clock.split(':').map(Number)
  if (!/^\d{2}:\d{2}$/.test(value.clock) || hour! > 23 || minute! > 59) throw new Error('请选择有效的运行时间。')
  let expression: string
  if (value.kind === 'hourly') {
    if (!Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) throw new Error('分钟必须在 0 到 59 之间。')
    expression = `${value.minute} * * * *`
  } else if (value.kind === 'daily') expression = `${minute} ${hour} * * *`
  else if (value.kind === 'weekly') {
    if (!value.weekdays.length || value.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('请至少选择一天。')
    expression = `${minute} ${hour} * * ${[...new Set(value.weekdays)].sort((a, b) => a - b).join(',')}`
  } else {
    if (!value.custom || value.custom.timezone !== value.timezone) throw new Error('请先确认自定义时间规则。')
    expression = value.custom.expression
  }
  const preview = cronPreview(expression, value.timezone, now)
  return { recurrence: { frequency: 'cron', interval: 1, expression, preset: value.kind as 'hourly' | 'daily' | 'weekly' | 'custom', ...(value.kind === 'custom' ? { description: value.custom!.description } : {}) }, scheduledAt: preview[0]!, preview }
}
