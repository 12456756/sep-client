import type { ScheduledDefinition, ScheduledOccurrence, ScheduledRunStatus } from '../../shared/scheduled-tasks'
import { scheduledTaskStateLabels, terminalScheduledRuns, type ScheduledTaskState } from '../../shared/scheduled-task-state'
export { localDateTime, scheduledInstant } from '../../shared/zoned-time'
export { terminalScheduledRuns as TERMINAL_RUNS } from '../../shared/scheduled-task-state'

export const RUN_LABELS: Record<ScheduledRunStatus, string> = {
  pending: '等待执行', preparing: '检查执行条件', launching: '正在启动', running: '正在执行',
  waiting_approval: '等待审批', waiting_retry: '等待重试', waiting_auth: '等待登录', blocked: '需要处理',
  review: '需要核查', cancelling: '正在停止', completed: '已完成', failed: '执行失败',
  cancelled: '已取消', timed_out: '已超时', missed: '已错过',
}

export function definitionLabel(status: ScheduledTaskState): string {
  return status.state === 'executing' ? RUN_LABELS[status.runStatus] : scheduledTaskStateLabels[status.state]
}

type ScheduledTaskAction = 'edit' | 'pause' | 'resume' | 'history' | 'reschedule' | 'archive'

export function canResumeSchedule(definition: ScheduledDefinition, seenTime: boolean, now = Date.now()): boolean {
  if (definition.input.mode === 'empty-text') return false
  const frequency = definition.input.recurrence?.frequency ?? 'once'
  return Boolean(definition.plan && (frequency !== 'once' || (!seenTime && definition.input.scheduledAt > now)))
}

export function scheduledTaskActions(definition: ScheduledDefinition, runs: readonly ScheduledOccurrence[], { inHistory, busy, now }: {
  inHistory: boolean; busy: boolean; now?: number
}): { id: ScheduledTaskAction; disabledReason?: string }[] {
  if (definition.deleted) return [{ id: 'history' }]
  const busyReason = busy ? '正在处理操作，请稍后再试。' : undefined
  const active = runs.some(run => !terminalScheduledRuns.has(run.status))
  const editReason = busyReason ?? (active ? '请先处理或停止当前执行。' : undefined)
  const actions: ReturnType<typeof scheduledTaskActions> = inHistory
    ? [{ id: 'history' }, { id: 'reschedule', disabledReason: editReason }]
    : [{ id: 'edit', disabledReason: editReason }]
  if (definition.enabled) actions.push({ id: 'pause', disabledReason: busyReason })
  else if (definition.pausedAt != null && definition.input.mode !== 'empty-text') {
    const seenTime = runs.some(run => run.scheduledAt === definition.input.scheduledAt)
    actions.push({ id: 'resume', disabledReason: editReason ?? (canResumeSchedule(definition, seenTime, now) ? undefined
      : definition.plan ? '请先将任务改为未来的执行时间。' : '请先生成并确认工作计划。') })
  }
  return [...actions, { id: 'archive', disabledReason: editReason }]
}

export function recurrenceLabel(definition: ScheduledDefinition): string {
  const recurrence = definition.input.recurrence
  if (!recurrence || recurrence.frequency === 'once') return '仅执行一次'
  if (recurrence.frequency === 'cron') {
    const [minute, hour, , , weekdays] = recurrence.expression.split(/\s+/)
    if (recurrence.preset === 'hourly') return `每小时第 ${minute} 分钟`
    if (recurrence.preset === 'daily') return `每天 ${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`
    if (recurrence.preset === 'weekly') return `每周 ${weekdays!.split(',').map(day => ['日', '一', '二', '三', '四', '五', '六'][Number(day)]).join('、')} ${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`
    return recurrence.description ?? '自定义时间'
  }
  const frequency = recurrence.frequency === 'daily' ? '天' : recurrence.frequency === 'weekly' ? '周' : '月'
  return recurrence.interval === 1 ? `每${frequency}执行` : `每 ${recurrence.interval} ${frequency}执行`
}

export function runActions(status: ScheduledRunStatus): ('inspect' | 'acknowledge' | 'check' | 'cancel')[] {
  if (terminalScheduledRuns.has(status)) return ['inspect']
  if (status === 'review') return ['inspect', 'acknowledge', 'cancel']
  if (status === 'blocked' || status === 'waiting_auth') return ['inspect', 'check', 'cancel']
  return status === 'cancelling' ? ['inspect'] : ['inspect', 'cancel']
}

export function scheduleTime(value: number | null, timezone: string): string {
  return value === null ? '—' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(value)
}
