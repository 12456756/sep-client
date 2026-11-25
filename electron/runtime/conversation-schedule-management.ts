import { cronPreview } from '../../src/shared/cron-schedule'
import { scheduledInstant } from '../../src/shared/zoned-time'
import { DELETE_SCHEDULED_TASK_TOOL, type ConversationScheduleManagement, type ScheduleManagementApproval, type ScheduleManagementReceipt, type ScheduleManagementRequest } from '../../src/shared/scheduled-management'
import { retiredScheduledExecutionMessage, type ScheduledDefinition } from '../../src/shared/scheduled-tasks'
import { redactModelTraceText, redactText } from '../common/redact'
import { AppError } from '../errors/app-error'
import { toEnvelope } from '../errors/error-mapper'
import type { ScheduledTaskService } from '../service/scheduled-task-service'

export function bindConversationScheduleManagement(options: {
  service: Pick<ScheduledTaskService, 'list' | 'updateConversationSchedule' | 'pause'>
  signal: AbortSignal
  isCurrent(): boolean
  conversationIds(): Promise<ReadonlySet<string>>
  approve(tool: ScheduleManagementRequest['tool'], input: ScheduleManagementApproval): Promise<boolean>
  now?: () => number
}): ConversationScheduleManagement {
  return async (request, signal) => {
    const guard = () => {
      options.signal.throwIfAborted()
      signal?.throwIfAborted()
      if (!options.isCurrent()) throw new AppError('AUTH_REQUIRED')
    }
    try {
      guard()
      const { target } = request.input
      const ids = 'fromConversation' in target ? await options.conversationIds() : undefined
      guard()
      const { definitions } = await options.service.list()
      guard()
      const matches = definitions.filter(item => !item.deleted && ('id' in target ? item.id === target.id
        : 'title' in target ? item.input.name === target.title : ids?.has(item.id)))
      if (matches.length === 0) return { status: 'needs_input', message: '未找到对应的定时任务，请核对并提供完整名称或任务 ID。' }
      if (matches.length > 1) return { status: 'needs_input', message: '找到多个定时任务，请先向用户确认具体目标，不要自行选择。',
        matches: matches.slice(0, 10).map(item => ({ id: item.id, title: redactText(item.input.name), nextRunAt: item.nextRunAt, timezone: item.input.timezone })) }

      const item = matches[0]!
      const { timezone } = item.input
      const approval: ScheduleManagementApproval = { id: item.id, title: item.input.name, timezone, enabled: item.enabled, nextRunAt: item.nextRunAt }
      if (request.tool === DELETE_SCHEDULED_TASK_TOOL) {
        if (!await options.approve(request.tool, approval)) return { status: 'cancelled', message: '删除未获确认，未删除定时任务。' }
        guard()
        await options.service.pause(item.id, item.revision, true, guard)
        return { status: 'deleted', id: item.id, title: redactText(item.input.name) }
      }

      const { title, time, inspect, expectedRevision } = request.input
      if (expectedRevision !== undefined && expectedRevision !== item.revision) {
        return { status: 'failed', message: '定时任务配置已更新，请重新查看后再修改。' }
      }
      const goal = request.input.goal === item.input.goal ? undefined : request.input.goal
      if (item.input.mode === 'empty-text') return { status: 'needs_input', message: retiredScheduledExecutionMessage }
      if (inspect || goal !== undefined) {
        if (item.plan?.kind === 'arrangement' && item.plan.source) return { status: 'needs_input', message: '从已有工作复制的定时任务只能修改名称和时间，不能修改原工作内容。' }
      }
      if (inspect) {
        const currentGoal = redactModelTraceText(item.input.goal)
        if (currentGoal !== item.input.goal) return { status: 'needs_input', message: '原任务内容包含需要保护的信息，请在定时任务页面编辑。' }
        return { status: 'current', id: item.id, revision: item.revision, title: redactText(item.input.name), goal: currentGoal }
      }
      if (goal !== undefined && redactModelTraceText(goal) !== goal) {
        return { status: 'needs_input', message: '新任务内容包含疑似凭据，请移除后再修改。' }
      }
      if (goal === undefined && !title && !time) return { status: 'needs_input', message: '新任务内容与原内容相同，无需保存。' }
      const now = options.now?.() ?? Date.now()
      let timing: Parameters<ScheduledTaskService['updateConversationSchedule']>[2]['timing']
      if (time) {
        try {
          const canonical = (zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone
          if (request.input.timezone && canonical(request.input.timezone) !== canonical(timezone)) {
            return { status: 'needs_input', message: `会话修改保留原任务时区（${timezone}）。请提供该时区的执行时间，或在定时任务页面修改时区。` }
          }
          const scheduledAt = time.kind === 'cron' ? cronPreview(time.expression, timezone, now, 1)[0]! : scheduledInstant(time.localDateTime, timezone)
          if (scheduledAt <= now) return { status: 'needs_input', message: '执行时间已过，请提供未来时间。' }
          timing = { scheduledAt, recurrence: time.kind === 'cron'
            ? { frequency: 'cron', interval: 1, expression: time.expression, preset: 'custom' }
            : { frequency: 'once', interval: 1 } }
        } catch {
          return { status: 'needs_input', message: `执行时间无效或有歧义，请按任务时区（${timezone}）重新指定。` }
        }
        approval.newTime = { firstRunAt: timing.scheduledAt, recurrence: timing.recurrence }
      }
      if (title !== undefined) approval.newTitle = title
      if (goal !== undefined) approval.newGoal = goal
      if (!await options.approve(request.tool, approval)) return { status: 'cancelled', message: '修改未获确认，未修改定时任务。' }
      guard()
      const result = await options.service.updateConversationSchedule(item.id, item.revision, { title, timing, goal }, guard,
        signal ? AbortSignal.any([signal, options.signal]) : options.signal)
      return updateReceipt(result, goal !== undefined)
    } catch (error) {
      guard()
      return { status: 'failed', message: error instanceof AppError ? toEnvelope(error).message : '无法确认操作结果，请在定时任务列表中核对。' }
    }
  }
}

function updateReceipt(item: ScheduledDefinition, contentUpdated: boolean): ScheduleManagementReceipt {
  return { status: 'updated', id: item.id, title: redactText(item.input.name), enabled: item.enabled,
    nextRunAt: item.nextRunAt, timezone: item.input.timezone, recurrence: item.input.recurrence, ...(contentUpdated ? { contentUpdated: true } : {}) }
}
