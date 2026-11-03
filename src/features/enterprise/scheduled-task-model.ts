import type { ScheduledDefinition, ScheduledOccurrence, ScheduledRunStatus } from '../../shared/scheduled-tasks'
export { localDateTime, scheduledInstant } from '../../shared/zoned-time'

export const RUN_LABELS: Record<ScheduledRunStatus, string> = {
  pending: '等待执行', preparing: '检查执行条件', launching: '正在启动', running: '正在执行',
  waiting_approval: '等待审批', waiting_retry: '等待重试', waiting_auth: '等待登录', blocked: '需要处理',
  review: '需要核查', cancelling: '正在停止', completed: '已完成', failed: '执行失败',
  cancelled: '已取消', timed_out: '已超时', missed: '已错过',
}
export const TERMINAL_RUNS = new Set<ScheduledRunStatus>(['completed', 'failed', 'cancelled', 'timed_out', 'missed'])

export function definitionLabel(definition: ScheduledDefinition): string {
  return definition.deleted ? '已归档' : definition.enabled ? '已启用' : definition.pausedAt != null ? '已暂停' : definition.plan ? '未启用' : '草稿'
}

export function scheduledHomeGroups(definitions: ScheduledDefinition[], occurrences: ScheduledOccurrence[]): { active: ScheduledDefinition[]; paused: ScheduledDefinition[]; pending: ScheduledDefinition[]; history: ScheduledDefinition[] } {
  const unfinished = new Set(occurrences.filter(run => !TERMINAL_RUNS.has(run.status)).map(run => run.definitionId))
  const executed = new Set(occurrences.map(run => run.definitionId))
  const active: ScheduledDefinition[] = [], paused: ScheduledDefinition[] = [], pending: ScheduledDefinition[] = [], history: ScheduledDefinition[] = []
  for (const item of definitions) {
    if (item.deleted) { history.push(item); continue }
    if (!item.enabled && item.pausedAt != null) paused.push(item)
    else if (item.enabled || unfinished.has(item.id)) active.push(item)
    else if (executed.has(item.id)) history.push(item)
    else pending.push(item)
  }
  const latest = (a: ScheduledDefinition, b: ScheduledDefinition) => b.updatedAt - a.updatedAt
  return { active: active.sort(latest), paused: paused.sort(latest), pending: pending.sort(latest), history: history.sort(latest) }
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
  if (TERMINAL_RUNS.has(status)) return ['inspect']
  if (status === 'review') return ['inspect', 'acknowledge', 'cancel']
  if (status === 'blocked' || status === 'waiting_auth') return ['inspect', 'check', 'cancel']
  return status === 'cancelling' ? ['inspect'] : ['inspect', 'cancel']
}

export function scheduleTime(value: number | null, timezone: string): string {
  return value === null ? '—' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(value)
}
