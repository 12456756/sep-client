import { createHash, randomUUID } from 'node:crypto'
import { cronPreview } from '../../src/shared/cron-schedule'
import { scheduledInstant } from '../../src/shared/zoned-time'
import { groupScheduledTasks, indexScheduledRuns, scheduledTaskState } from '../../src/shared/scheduled-task-state'
import { DELETE_SCHEDULED_TASK_TOOL, UPDATE_SCHEDULED_TASK_TOOL, SCHEDULE_QUERY_TOOL, SCHEDULE_READ_TOOLS, SCHEDULE_SOURCE_TOOL, SCHEDULE_TIME_TOOL, scheduleManagementSchemas, type ConversationScheduleManagement, type ScheduleActionApproval, type ScheduleManagementApproval, type ScheduleManagementReceipt, type ScheduleManagementRequest } from '../../src/shared/scheduled-management'
import { formatScheduleReceiptTime } from '../../src/shared/scheduled-creation'
import { retiredScheduledExecutionMessage, scheduleInputSchema, type ScheduleInput, type ScheduledDefinition, type ScheduledOccurrence, type ScheduledSnapshot, type ScheduledWorkPlan } from '../../src/shared/scheduled-tasks'
import { redactModelTraceText, redactText } from '../common/redact'
import { AppError } from '../errors/app-error'
import { toEnvelope } from '../errors/error-mapper'
import type { ScheduledTaskService } from '../service/scheduled-task-service'
import type { ScheduledCreationService } from '../service/scheduled-creation-service'

export interface ScheduleManagementServices {
  service: Pick<ScheduledTaskService, 'list' | 'updateConversationSchedule' | 'pause' | 'plan' | 'confirm' | 'interpretTime' | 'workSource' | 'create' | 'edit' | 'createFromWork' | 'editFromWork' | 'check' | 'cancel' | 'resume'>
  creations?: Pick<ScheduledCreationService, 'cancel' | 'deleteRecord'>
  selectOutputDirectory?: (path: string) => Promise<string | null>
}

interface Options extends ScheduleManagementServices {
  context?: { key: string; modelId: string; subscriptionId: string; workDir?: string }
  readOnly?: boolean
  signal: AbortSignal
  isCurrent(): boolean
  conversationIds(): Promise<ReadonlySet<string>>
  approve(tool: ScheduleManagementRequest['tool'], input: ScheduleManagementApproval): Promise<boolean>
  approveAction?(tool: ScheduleManagementRequest['tool'], input: ScheduleActionApproval): Promise<boolean>
  now?: () => number
}

export function bindConversationScheduleManagement(options: Options): ConversationScheduleManagement {
  return async (rawRequest, signal) => {
    const guard = () => {
      options.signal.throwIfAborted()
      signal?.throwIfAborted()
      if (!options.isCurrent()) throw new AppError('AUTH_REQUIRED')
    }
    try {
      guard()
      const request = { ...rawRequest, input: scheduleManagementSchemas[rawRequest.tool].parse(rawRequest.input) } as ScheduleManagementRequest
      if (options.readOnly && !SCHEDULE_READ_TOOLS.has(request.tool)) throw new AppError('INVALID_STATE', { message: '当前对话仅允许查询定时任务。' })
      const operationSignal = signal ? AbortSignal.any([signal, options.signal]) : options.signal
      const lookup = async (target: ScheduleTarget, snapshot?: ScheduledSnapshot, allowDeleted = false) => {
        const ids = 'fromConversation' in target ? await options.conversationIds() : undefined
        guard()
        const { definitions } = snapshot ?? await options.service.list()
        guard()
        const matches = definitions.filter(item => (!item.deleted || allowDeleted && 'id' in target) && ('id' in target ? item.id === target.id
          : 'title' in target ? item.input.name === target.title : ids?.has(item.id)))
        if (!matches.length) return { status: 'needs_input' as const, message: '未找到对应的定时任务，请核对名称或任务 ID。' }
        if (matches.length > 1) return { status: 'needs_input' as const, message: '找到多个定时任务，请先向用户确认具体目标，不要自行选择。',
          matches: matches.slice(0, 10).map(taskView) }
        return matches[0]!
      }
      if (request.tool !== UPDATE_SCHEDULED_TASK_TOOL && request.tool !== DELETE_SCHEDULED_TASK_TOOL || 'configuration' in request.input) {
        return await executeAction(options, request, guard, operationSignal, lookup)
      }
      const item = await lookup(request.input.target)
      if ('status' in item) return item
      const { timezone } = item.input
      const approval: ScheduleManagementApproval = { id: item.id, title: item.input.name, timezone, enabled: item.enabled, nextRunAt: item.nextRunAt }
      if (request.tool === DELETE_SCHEDULED_TASK_TOOL) {
        requireRevision(request.input.expectedRevision, item.revision)
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
      const result = await options.service.updateConversationSchedule(item.id, item.revision, { title, timing, goal }, guard, operationSignal)
      return updateReceipt(result, goal !== undefined)
    } catch (error) {
      guard()
      return { status: 'failed', message: error instanceof AppError ? safeText(toEnvelope(error).message, 1000) : '无法确认操作结果，请在定时任务列表中核对。' }
    }
  }
}

function updateReceipt(item: ScheduledDefinition, contentUpdated: boolean): ScheduleManagementReceipt {
  return { status: 'updated', id: item.id, title: safeText(item.input.name), enabled: item.enabled,
    nextRunAt: item.nextRunAt, timezone: item.input.timezone, recurrence: taskView(item).recurrence, ...(contentUpdated ? { contentUpdated: true } : {}) }
}

type ScheduleTarget = Extract<ScheduleManagementRequest, { tool: typeof UPDATE_SCHEDULED_TASK_TOOL }>['input']['target']
type Configuration = Extract<ScheduleManagementRequest, { tool: 'create_scheduled_task_definition' }>['input']['configuration']
const safeText = (value: string, limit = 240) => redactText(redactModelTraceText(value), limit)
function recurrenceView(rule: ScheduleInput['recurrence']) {
  if (rule?.frequency !== 'cron') return rule
  const { description: _description, ...result } = rule
  return result
}
const taskView = (item: ScheduledDefinition) => ({ id: item.id, revision: item.revision, title: safeText(item.input.name),
  enabled: item.enabled, deleted: item.deleted, pausedAt: item.pausedAt ?? null, hasPlan: !!item.plan,
  scheduledAt: item.input.scheduledAt, nextRunAt: item.nextRunAt, timezone: item.input.timezone,
  recurrence: recurrenceView(item.input.recurrence) })
const planView = (plan: ScheduledWorkPlan | null) => plan?.kind === 'arrangement'
  ? { title: safeText(plan.title), nodes: plan.nodes.slice(0, 10).map(node => ({ title: safeText(node.title), objective: safeText(node.objective ?? node.expectedOutput, 300) })), nodeCount: plan.nodes.length }
  : plan ? { objective: safeText(plan.objective, 500), expectedOutput: safeText(plan.expectedOutput, 500), deliverables: plan.deliverables.slice(0, 10).map(file => safeText(file.name)) } : null
const runView = (run: ScheduledOccurrence, detail = false) => ({ id: run.id, definitionId: run.definitionId, revision: run.revision,
  title: safeText(run.input.name), status: run.status, scheduledAt: run.scheduledAt, timezone: run.input.timezone, nextRetryAt: run.nextRetryAt,
  ...(detail ? { startedAt: run.startedAt, finishedAt: run.finishedAt, attemptCount: run.attempts.length,
    issue: run.error ? { action: run.error.action, code: safeText(run.error.code, 100) } : null } : {}) })
type Creation = NonNullable<ScheduledSnapshot['creations']>[number]
const creationView = (item: Creation) => ({ id: item.id, revision: item.revision, title: item.definitionInput && safeText(item.definitionInput.name),
  stage: item.stage, deleted: !!item.deleted, definitionId: item.definitionId, createdAt: item.createdAt, updatedAt: item.updatedAt })
const byUpdated = <T extends { updatedAt: number; id: string }>(a: T, b: T) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
function pageOf<T, R>(values: T[], { offset = 0, limit = 10 }: { offset?: number; limit?: number }, map: (value: T) => R) {
  return { items: values.slice(offset, offset + limit).map(map), total: values.length, nextOffset: offset + limit < values.length ? offset + limit : null }
}
function requireRevision(expected: number | undefined, actual: number) {
  if (expected !== undefined && expected !== actual) throw new AppError('CONFLICT', { message: '记录已更新，请重新查看后再操作。' })
}
function timing(input: Pick<ScheduleInput, 'scheduledAt' | 'timezone' | 'recurrence'>) {
  const rule = input.recurrence
  const repeat = rule?.frequency === 'cron' ? `Cron：${rule.expression}` : !rule || rule.frequency === 'once' ? '仅执行一次'
    : `每 ${rule.interval} ${({ daily: '天', weekly: '周', monthly: '月' })[rule.frequency]}`
  return `计划基准：${formatScheduleReceiptTime(input.scheduledAt, input.timezone)}；${repeat}。`
}
function configurationInput(configuration: Configuration, workDir: string, current?: ScheduleInput): ScheduleInput {
  const { executor, outputDirectory, ...fields } = configuration
  if (redactModelTraceText(fields.goal) !== fields.goal) throw new AppError('INVALID_ARGUMENT', { message: '任务内容包含疑似凭据，请移除后再保存。' })
  const output = outputDirectory === undefined ? current?.outputDirectory : outputDirectory === null ? undefined : { path: outputDirectory }
  const parsed = scheduleInputSchema.safeParse({ ...fields, ...executor, workDir,
    permissions: current?.permissions ?? { preset: 'workspace-edit', approvalMode: 'confirm-each' }, ...(output ? { outputDirectory: output } : {}) })
  if (!parsed.success) throw new AppError('INVALID_ARGUMENT', { message: '配置无效；请核对首次执行时间、时区和重复规则。' })
  return parsed.data
}
function configMessage(input: ScheduleInput, action: string) {
  return `${action}？任务「${input.name}」。${timing(input)}\n执行方式：${input.mode ?? 'employee'}；模型：${input.modelId}${input.subscriptionId ? `；员工：${input.subscriptionId}` : ''}。\n${input.outputDirectory ? `产出目录：${input.outputDirectory.path}（需要单独授权）。\n` : ''}\n工作目标：\n${input.goal}`
}

type Lookup = (target: ScheduleTarget, snapshot?: ScheduledSnapshot, allowDeleted?: boolean) => Promise<ScheduledDefinition | Extract<ScheduleManagementReceipt, { status: 'needs_input' }>>
async function executeAction(options: Options, request: ScheduleManagementRequest, guard: () => void, signal: AbortSignal, lookup: Lookup): Promise<ScheduleManagementReceipt> {
  const { service, context } = options
  const approve = async (label: string, message: string) => {
    const decision = await options.approveAction?.(request.tool, { label, message: redactModelTraceText(message) })
    guard()
    return decision === true
  }
  const denied = { status: 'cancelled', message: '操作未获确认，未执行。' } as const
  const applied = (data: unknown, status: 'applied' | 'unchanged' = 'applied'): ScheduleManagementReceipt => ({ status, action: request.tool, data })
  const ok = (data: unknown) => ({ status: 'ok' as const, data })
  const list = async () => { const result = await service.list(); guard(); return result }
  const requestId = () => {
    if (!context) throw new AppError('INVALID_STATE')
    const hex = createHash('sha256').update(JSON.stringify([context.key, request])).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  if (request.tool === SCHEDULE_TIME_TOOL) {
    if (!context) throw new AppError('INVALID_STATE')
    const { modelId, subscriptionId } = context
    const result = await service.interpretTime({ ...request.input, requestId: randomUUID(), modelId, subscriptionId }, signal)
    guard()
    return ok(result.status === 'ready' ? result : { ...result, reasons: result.reasons.map(value => safeText(value, 400)) })
  }
  if (request.tool === SCHEDULE_SOURCE_TOOL) {
    const source = await service.workSource(request.input.taskId)
    guard()
    return ok({ ...source, title: safeText(source.title) })
  }
  if (request.tool === SCHEDULE_QUERY_TOOL) {
    const input = request.input
    const snapshot = await list()
    if (input.view === 'tasks') {
      const search = input.search?.toLocaleLowerCase()
      const includeDeleted = input.includeDeleted ?? input.group === 'history'
      const groups = groupScheduledTasks(snapshot.definitions, indexScheduledRuns(snapshot.occurrences))
      const candidates = input.group ? groups[input.group] : Object.values(groups).flat().sort((a, b) => byUpdated(a.definition, b.definition))
      const rows = candidates.filter(({ definition }) => (includeDeleted || !definition.deleted) && (!search || safeText(definition.input.name).toLocaleLowerCase().includes(search)))
      return ok({ schedulerState: snapshot.schedulerState, ...pageOf(rows, input, ({ definition, status }) => ({ ...taskView(definition), ...status })) })
    }
    if (input.view === 'creations') return ok(pageOf((snapshot.creations ?? []).filter(item => !item.deleted).sort(byUpdated), input, creationView))
    if (input.view === 'creation') {
      const item = snapshot.creations?.find(value => value.id === input.creationId && !value.deleted)
      if (!item) throw new AppError('NOT_FOUND')
      return ok(creationView(item))
    }
    if (input.view === 'run') {
      const run = snapshot.occurrences.find(value => value.id === input.runId)
      if (!run) throw new AppError('NOT_FOUND')
      return ok(runView(run, true))
    }
    const item = await lookup(input.target, snapshot, true)
    if ('status' in item) return item
    if (input.view === 'runs') return ok(pageOf(snapshot.occurrences.filter(run => run.definitionId === item.id)
      .sort((a, b) => b.scheduledAt - a.scheduledAt || a.id.localeCompare(b.id)), input, run => runView(run)))
    return ok({ ...taskView(item), ...scheduledTaskState(item, snapshot.occurrences.filter(run => run.definitionId === item.id)),
      mode: item.input.mode ?? 'employee', modelId: safeText(item.input.modelId ?? ''), subscriptionId: item.input.subscriptionId,
      copiedFromWork: item.plan?.kind === 'arrangement' && !!item.plan.source,
      ...(input.includeGoal ? { goal: safeText(item.input.goal, 16000) } : {}),
      planSummary: planView(item.plan) })
  }
  if (request.tool === 'resume_scheduled_scheduler') {
    const { schedulerState } = await list()
    if (schedulerState === 'running') return applied({ schedulerState }, 'unchanged')
    if (!await approve('恢复调度器', '恢复当前工作区的调度器并检查已有执行？恢复后，符合条件的任务可能自动执行。')) return denied
    await service.resume(guard, schedulerState)
    return applied({ schedulerState: (await list()).schedulerState })
  }
  if (request.tool === 'cancel_scheduled_creation' || request.tool === 'delete_scheduled_creation') {
    if (!options.creations) throw new AppError('INVALID_STATE')
    const { creationId, expectedRevision } = request.input
    const item = (await list()).creations?.find(value => value.id === creationId && !value.deleted)
    if (!item) throw new AppError('NOT_FOUND')
    requireRevision(expectedRevision, item.revision)
    const remove = request.tool === 'delete_scheduled_creation'
    const label = remove ? '删除创建记录' : '取消创建'
    if (!await approve(label, `${label}「${item.definitionInput?.name ?? item.id}」？不会删除已创建的定时任务或执行记录。`)) return denied
    return applied(creationView(await (remove ? options.creations.deleteRecord(item.id, item.revision, guard) : options.creations.cancel(item.id, item.revision, guard))))
  }
  if (request.tool === 'resume_scheduled_run' || request.tool === 'acknowledge_scheduled_run_review' || request.tool === 'cancel_scheduled_run') {
    const run = (await list()).occurrences.find(value => value.id === request.input.runId)
    if (!run) throw new AppError('NOT_FOUND')
    const subject = `「${safeText(run.input.name)}」${formatScheduleReceiptTime(run.scheduledAt, run.input.timezone)} 的本次执行`
    const acknowledge = request.tool === 'acknowledge_scheduled_run_review', cancel = request.tool === 'cancel_scheduled_run'
    if (acknowledge ? run.status !== 'review' : !cancel && !['blocked', 'waiting_auth'].includes(run.status)) {
      throw new AppError('INVALID_STATE', { message: '本次执行当前不处于可执行该操作的状态，请重新查看。' })
    }
    if (cancel && run.status === 'cancelling') return applied(runView(run), 'unchanged')
    const label = acknowledge ? '确认关闭' : cancel ? '取消本次执行' : '恢复本次执行'
    const message = acknowledge ? `已核查${subject}产生的文件和外部操作，确认关闭记录？不会重新执行。`
      : cancel ? `取消${subject}？已产生的外部操作和文件不会撤销。` : `恢复${subject}？它将重新进入执行队列。`
    if (!await approve(label, message)) return denied
    const intent = { guard, expectedStatus: run.status, expectedAttemptId: run.attempts.at(-1)?.id }
    if (cancel) await service.cancel(run.id, intent)
    else await service.check(run.id, acknowledge, intent)
    const latest = (await list()).occurrences.find(value => value.id === run.id)
    if (!latest) throw new AppError('NOT_FOUND')
    return applied(runView(latest, true))
  }
  if (request.tool === 'create_scheduled_task_definition') {
    if (!context?.workDir) throw new AppError('INVALID_STATE', { message: '当前会话没有工作目录，无法保存配置。' })
    const input = configurationInput(request.input.configuration, context.workDir)
    if (!await approve('保存任务配置', configMessage(input, '只保存配置，不生成计划或启用'))) return denied
    return applied(taskView(await service.create(requestId(), input, undefined, options.selectOutputDirectory, guard)))
  }
  if (request.tool === 'create_scheduled_task_from_work') {
    const input = request.input
    const source = await service.workSource(input.taskId)
    guard()
    if (source.planHash !== input.expectedPlanHash) throw new AppError('CONFLICT', { message: '原工作计划已变化，请重新查看。' })
    if (!await approve('复制并启用', `将已有工作「${source.title}」复制为定时任务「${input.name}」并启用？${timing(input)}`)) return denied
    return applied(taskView(await service.createFromWork({ ...input, requestId: requestId() }, guard)))
  }
  const item = await lookup(request.input.target)
  if ('status' in item) return item
  requireRevision(request.input.expectedRevision, item.revision)
  switch (request.tool) {
    case 'edit_scheduled_task_from_work': {
      const { target: _target, expectedRevision, ...newTiming } = request.input
      if (!await approve('保存并启用', `修改复制任务「${item.input.name}」的安排并启用？新名称：${newTiming.name}。${timing(newTiming)}`)) return denied
      return applied(taskView(await service.editFromWork({ ...newTiming, id: item.id, expectedRevision }, guard)))
    }
    case 'enable_scheduled_task': {
      if (item.enabled) return applied(taskView(item), 'unchanged')
      if (item.input.mode === 'empty-text') return { status: 'needs_input', message: retiredScheduledExecutionMessage }
      if (!item.plan) return { status: 'needs_input', message: '尚未生成有效工作计划，请先生成并审核计划，再启用。' }
      if ((!item.input.recurrence || item.input.recurrence.frequency === 'once') && item.input.scheduledAt <= (options.now?.() ?? Date.now())) {
        return { status: 'needs_input', message: '单次任务的计划时间已过，请先改到未来时间再启用。' }
      }
      if (!await approve('启用任务', `启用定时任务「${item.input.name}」？${timing(item.input)}符合条件时会自动执行。\n\n工作目标：\n${item.input.goal}`)) return denied
      return applied(taskView(await service.confirm(item.id, item.revision, guard)))
    }
    case 'pause_scheduled_task': {
      if (!item.enabled && !item.nextRunAt) return applied(taskView(item), 'unchanged')
      if (!await approve('暂停任务', `暂停定时任务「${item.input.name}」的后续调度？已经生成的执行不会停止。`)) return denied
      return applied(taskView(await service.pause(item.id, item.revision, false, guard)))
    }
    case 'plan_scheduled_task': {
      if (!await approve('生成工作计划', `为定时任务「${item.input.name}」生成工作计划？这不会启用任务。`)) return denied
      const planned = await service.plan(item.id, item.revision, signal, guard)
      return applied({ ...taskView(planned), planSummary: planView(planned.plan) }, planned.revision === item.revision ? 'unchanged' : 'applied')
    }
    case UPDATE_SCHEDULED_TASK_TOOL: {
      if (!('configuration' in request.input)) break
      if ('actions' in item.input && item.input.actions) throw new AppError('INVALID_STATE', { message: '此任务含旧版业务操作，请在定时任务页面检查后再修改。' })
      const input = configurationInput(request.input.configuration, item.input.workDir, item.input)
      if (!await approve('保存配置', configMessage(input, `修改「${item.input.name}」并暂停调度，需另行启用`))) return denied
      return applied(taskView(await service.edit(item.id, item.revision, input, undefined, options.selectOutputDirectory, guard)))
    }
  }
  throw new AppError('INVALID_STATE')
}
