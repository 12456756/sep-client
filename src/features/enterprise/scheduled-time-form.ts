import { CronExpressionParser } from 'cron-parser'
import type { RecurrenceRule, ScheduleInput } from '../../shared/scheduled-tasks'
import { cronPreview, isValidCron } from '../../shared/cron-schedule'
import { localDateTime, scheduledInstant } from './scheduled-task-model'

export type RepeatKind = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'monthly-days' | 'custom'
export interface ScheduleTiming {
  kind: RepeatKind
  timezone: string
  clock: string
  minute: number
  weekdays: number[]
  monthDays: number[]
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
  const state: ScheduleTiming = { kind: rule?.frequency === 'cron' ? 'custom' : rule?.frequency ?? 'daily', timezone, clock: local.slice(11), minute: Number(local.slice(14)), weekdays: [1, 2, 3, 4, 5], monthDays: [Number(local.slice(8, 10))], onceAt: local, interval: rule?.interval ?? 1, custom: null }
  if (rule?.frequency === 'weekly') state.weekdays = [new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay()]
  if (rule?.frequency === 'cron') {
    const controls = cronControls(rule.expression)
    if (controls) return { ...state, ...controls, onceAt: `${local.slice(0, 10)}T${controls.clock ?? state.clock}` }
    state.custom = { expression: rule.expression, description: rule.description ?? '', timezone }
  }
  return state
}

function cronControls(expression: string): Partial<ScheduleTiming> | null {
  try {
    const fields = CronExpressionParser.parse(expression).fields
    const [, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/)
    const [minute] = fields.minute.values
    if (month !== '*' || fields.minute.values.length !== 1 || minute === undefined) return null
    if (hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') return { kind: 'hourly', minute }
    const [hourValue] = fields.hour.values
    if (fields.hour.values.length !== 1 || hourValue === undefined) return null
    const clock = `${String(hourValue).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    if (dayOfMonth === '*' && dayOfWeek === '*') return { kind: 'daily', clock, minute }
    if (dayOfMonth === '*' && fields.dayOfWeek.values.every(day => typeof day === 'number')) {
      return { kind: 'weekly', clock, minute, weekdays: [...new Set(fields.dayOfWeek.values.map(day => day % 7))] }
    }
    if (dayOfWeek === '*' && fields.dayOfMonth.values.every(day => typeof day === 'number')) {
      return { kind: 'monthly-days', clock, minute, monthDays: fields.dayOfMonth.values }
    }
  } catch { /* Keep rules that cannot be represented by the form intact. */ }
  return null
}

export function timingConfiguration(value: ScheduleTiming, now = Date.now()): { recurrence: RecurrenceRule; scheduledAt: number; preview: number[] } {
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }) }
  catch { throw new Error('请选择有效的时区。') }
  if (value.kind === 'once' || value.kind === 'monthly' || (['daily', 'weekly'].includes(value.kind) && value.interval > 1)) {
    const scheduledAt = scheduledInstant(value.onceAt, value.timezone)
    if (scheduledAt <= now) throw new Error('请选择未来的首次执行时间。')
    return { scheduledAt, recurrence: { frequency: value.kind as 'once' | 'monthly' | 'daily' | 'weekly', interval: value.interval }, preview: [scheduledAt] }
  }
  const [hour, minute] = value.clock.split(':').map(Number)
  if (['daily', 'weekly', 'monthly-days'].includes(value.kind) && (!/^\d{2}:\d{2}$/.test(value.clock) || hour! > 23 || minute! > 59)) throw new Error('请选择有效的运行时间。')
  let expression: string
  let description: string | undefined
  if (value.kind === 'hourly') {
    if (!Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) throw new Error('分钟必须在 0 到 59 之间。')
    expression = `${value.minute} * * * *`
  } else if (value.kind === 'daily') expression = `${minute} ${hour} * * *`
  else if (value.kind === 'weekly') {
    if (!value.weekdays.length || value.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('请至少选择一天。')
    expression = `${minute} ${hour} * * ${[...new Set(value.weekdays)].sort((a, b) => a - b).join(',')}`
  } else if (value.kind === 'monthly-days') {
    if (!value.monthDays.length || value.monthDays.some(day => !Number.isInteger(day) || day < 1 || day > 31)) throw new Error('请至少选择一个运行日期。')
    const days = [...new Set(value.monthDays)].sort((a, b) => a - b)
    expression = `${minute} ${hour} ${days.join(',')} * *`
    description = `每月 ${days.join('、')} 日 ${value.clock}`
  } else {
    if (!value.custom || value.custom.timezone !== value.timezone) throw new Error('请先确认自定义时间规则。')
    expression = value.custom.expression.trim()
    if (!isValidCron(expression)) throw new Error('这个时间规则无法运行，请重新设置运行时间。')
    description = value.custom.description || undefined
  }
  let preview: number[]
  try { preview = cronPreview(expression, value.timezone, now) }
  catch { throw new Error('无法计算下次运行时间，请重新设置运行时间。') }
  const preset = value.kind === 'hourly' || value.kind === 'daily' || value.kind === 'weekly' ? value.kind : 'custom'
  return { recurrence: { frequency: 'cron', interval: 1, expression, preset, ...(description ? { description } : {}) }, scheduledAt: preview[0]!, preview }
}
