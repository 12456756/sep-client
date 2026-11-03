import { randomUUID } from 'node:crypto'
import type { ArrangementWorkPlan, EmployeePlanResult, ScheduleInput, ScheduledDefinition, ScheduledOccurrence, ScheduledSnapshot } from '../../src/shared/scheduled-tasks'
import { scheduleInputSchema, scheduleTimeRequestSchema, scheduleTimeResultSchema, type ScheduleTimeRequest, type ScheduleTimeResult } from '../../src/shared/scheduled-tasks'
import { occurrenceId, planInputKey, employeePlanResultSchema, scheduledPlanResultSchema, dueScheduleWindow, nextScheduledAt } from '../domain/scheduled-task'
import { AppError } from '../errors/app-error'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import { WriteChain } from '../data/write-chain'
import { withTimeout } from '../common/with-timeout'
import { ScheduledDispatcher, type ScheduledRunnerPort } from './scheduled-dispatcher'
import { ScheduledTimer } from './scheduled-timer'
import { logger } from '../common/logger'
import { createWorkScheduleSchema, editWorkScheduleSchema, type CreateWorkSchedule, type EditWorkSchedule, type WorkScheduleContext } from '../../src/shared/scheduled-tasks'
import { sourceFingerprint } from '../domain/scheduled-work-source'
import type { ScheduledWorkSource } from './scheduled-work-source'

const log = logger.child('scheduled-tasks')

export interface ScheduledServiceOptions {
  source?: ScheduledWorkSource
  repository: ScheduledRepository
  scope: { currentScope(): TaskOwnerScope | null }
  employee(subscriptionId: string, modelId: string): Promise<unknown>
  planner(input: ScheduleInput, employee: unknown, signal: AbortSignal): Promise<EmployeePlanResult>
  arrangementPlanner?(input: ScheduleInput, signal: AbortSignal): Promise<ArrangementWorkPlan | { status: 'blocked'; reasons: string[] }>
  timeInterpreter?(input: ScheduleTimeRequest, signal: AbortSignal): Promise<ScheduleTimeResult>
  runner: ScheduledRunnerPort
  now?: () => number
}
export const TERMINAL_SCHEDULE_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'missed'])
export class ScheduledTaskService {
  private readonly now: () => number
  private readonly dispatcher: ScheduledDispatcher
  private readonly timer: ScheduledTimer
  private readonly scans = new WriteChain()
  private readonly planning = new Map<string, AbortController>()
  private generation = 0
  constructor(private readonly options: ScheduledServiceOptions) {
    this.now = options.now ?? Date.now
    this.dispatcher = new ScheduledDispatcher(options.repository, options.runner, this.now, () => this.options.scope.currentScope())
    this.timer = new ScheduledTimer(() => this.scan(), () => this.deadlines(), this.now)
  }
  private scope(): TaskOwnerScope {
    const scope = this.options.scope.currentScope()
    if (!scope) throw new AppError('AUTH_REQUIRED')
    return scope
  }
  private assertScope(scope: TaskOwnerScope, generation = this.generation): void {
    const current = this.options.scope.currentScope()
    if (generation !== this.generation || current?.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
  }
  private definition(data: ScheduledSnapshot, id: string, revision: number): ScheduledDefinition {
    const item = data.definitions.find(value => value.id === id && !value.deleted)
    if (!item) throw new AppError('NOT_FOUND')
    if (item.revision !== revision) throw new AppError('DRAFT_REVISION_CONFLICT')
    return item
  }
  private linkCreation(data: ScheduledSnapshot, definition: ScheduledDefinition, creation?: { id: string; revision: number; guard?: () => void }): void {
    if (!creation) return
    creation.guard?.()
    const item = data.creations?.find(value => value.id === creation.id)
    if (!item || item.revision !== creation.revision || item.stage !== 'planning') throw new AppError('DRAFT_REVISION_CONFLICT')
    item.definitionId = definition.id; item.definitionInput = structuredClone(definition.input)
    item.definitionSubmissionKey = item.submissionKey; item.revision++; item.updatedAt = this.now()
  }
  async list(): Promise<ScheduledSnapshot> {
    const scope = this.scope()
    const generation = this.generation
    const data = await this.options.repository.read(scope)
    this.assertScope(scope, generation)
    return { ...data, schedulerState: this.timer.state }
  }
  async interpretTime(raw: ScheduleTimeRequest): Promise<ScheduleTimeResult> {
    const input = scheduleTimeRequestSchema.parse(raw)
    const scope = this.scope(), generation = this.generation
    const key = `time:${input.requestId}`
    if (!this.options.timeInterpreter) throw new AppError('INVALID_STATE')
    if (this.planning.has(key) || [...this.planning.keys()].filter(value => value.startsWith('time:')).length >= 2) throw new AppError('CONFLICT')
    const controller = new AbortController()
    this.planning.set(key, controller)
    const timeout = setTimeout(() => controller.abort(), 45000)
    try {
      const employee = await withTimeout(this.options.employee(input.subscriptionId, input.modelId), 15000, 'schedule-time-authorization')
      this.assertScope(scope, generation); controller.signal.throwIfAborted()
      if (employee === null || employee === undefined || employee === false) throw new AppError('EMPLOYEE_UNAVAILABLE')
      const result = await withTimeout(this.options.timeInterpreter(input, controller.signal), 45000, 'schedule-time-interpretation')
      this.assertScope(scope, generation); controller.signal.throwIfAborted()
      return scheduleTimeResultSchema.parse(result)
    } finally {
      clearTimeout(timeout)
      this.planning.delete(key)
    }
  }
  async create(requestId: string, raw: ScheduleInput, creation?: { id: string; revision: number; guard?: () => void }): Promise<ScheduledDefinition> {
    const parsed = scheduleInputSchema.parse(raw)
    const input: ScheduleInput = { ...parsed, recurrence: parsed.recurrence ?? { frequency: 'once', interval: 1 } }
    const scope = this.scope()
    const id = occurrenceId(`definition:${requestId}`, 0)
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope)
      const existing = data.definitions.find(value => value.id === id)
      if (existing) {
        if ((existing.plan?.kind === 'arrangement' && existing.plan.source) || JSON.stringify(existing.input) !== JSON.stringify(input) || existing.deleted) throw new AppError('CONFLICT')
        this.linkCreation(data, existing, creation)
        return existing
      }
      if (input.scheduledAt <= this.now()) throw new AppError('INVALID_ARGUMENT', { message: '请选择未来的执行时间。' })
      const created: ScheduledDefinition = { id, revision: 1, input, plan: null, planInputKey: null, enabled: false, deleted: false, nextRunAt: null, pausedAt: null, createdAt: this.now(), updatedAt: this.now() }
      data.definitions.push(created)
      this.linkCreation(data, created, creation)
      return created
    })
    this.timer.request()
    log.info('scheduled definition created', { scheduledTaskId: result.id, revision: result.revision })
    return result
  }
  async edit(id: string, revision: number, raw: ScheduleInput, creation?: { id: string; revision: number; guard?: () => void }): Promise<ScheduledDefinition> {
    const input = scheduleInputSchema.parse(raw)
    const scope = this.scope()
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope)
      const item = this.definition(data, id, revision)
      if (item.plan?.kind === 'arrangement' && item.plan.source) throw new AppError('INVALID_STATE', { message: '从工作复制的定时任务只能修改标题和时间。' })
      if (data.occurrences.some(run => run.definitionId === id && !TERMINAL_SCHEDULE_STATUSES.has(run.status))) throw new AppError('INVALID_STATE', { message: '请先处理或停止当前执行，再修改任务。' })
      if (data.occurrences.some(run => run.definitionId === id && run.scheduledAt === input.scheduledAt)) throw new AppError('INVALID_ARGUMENT', { message: '这个时间点已经生成过执行记录，请选择新的执行时间。' })
      if (input.scheduledAt <= this.now()) throw new AppError('INVALID_ARGUMENT')
      const normalized = { ...input, recurrence: input.recurrence ?? { frequency: 'once' as const, interval: 1 } }
      if (planInputKey(normalized) !== item.planInputKey) { item.plan = null; item.planInputKey = null }
      Object.assign(item, { input: normalized, enabled: false, nextRunAt: null, pausedAt: null, revision: item.revision + 1, updatedAt: this.now() })
      this.linkCreation(data, item, creation)
      return item
    })
    this.planning.get(id)?.abort()
    this.timer.request()
    log.info('scheduled definition edited', { scheduledTaskId: id, revision: result.revision })
    return result
  }
  async plan(id: string, revision: number, signal?: AbortSignal): Promise<ScheduledDefinition> {
    const scope = this.scope()
    const generation = this.generation
    const snapshot = this.definition(await this.options.repository.read(scope), id, revision)
    if (snapshot.enabled) throw new AppError('INVALID_STATE')
    if (snapshot.plan && snapshot.planInputKey === planInputKey(snapshot.input)) return snapshot
    this.planning.get(id)?.abort()
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    this.planning.set(id, controller)
    const timeout = setTimeout(() => controller.abort(), 120000)
    try {
      controller.signal.throwIfAborted()
      let result: ScheduledDefinition['plan'] | { status: 'blocked'; reasons: string[] }
      if (snapshot.input.mode === 'auto') {
        if (!this.options.arrangementPlanner) throw new AppError('INVALID_STATE', { message: 'Multi-employee planning is unavailable' })
        await withTimeout(this.options.employee(snapshot.input.subscriptionId, snapshot.input.modelId), 60000, 'arrangement-planning-authorization')
        this.assertScope(scope, generation)
        const generated = await withTimeout(this.options.arrangementPlanner(snapshot.input, controller.signal), 120000, 'scheduled-arrangement-planning')
        result = scheduledPlanResultSchema.parse(generated) as ArrangementWorkPlan | { status: 'blocked'; reasons: string[] }
        if (result && 'kind' in result && result.kind === 'arrangement') {
          if (result.source) throw new AppError('INVALID_ARGUMENT')
          for (const node of result.nodes) {
            await withTimeout(this.options.employee(node.subscriptionId, node.modelId), 60000, 'scheduled-node-authorization')
            this.assertScope(scope, generation)
          }
        }
      } else {
        const employee = await withTimeout(this.options.employee(snapshot.input.subscriptionId, snapshot.input.modelId), 60000, 'employee-planning-authorization')
        this.assertScope(scope, generation)
        result = employeePlanResultSchema.parse(await withTimeout(this.options.planner(snapshot.input, employee, controller.signal), 120000, 'employee-planning'))
      }
      controller.signal.throwIfAborted()
      this.assertScope(scope, generation)
      if (result.status === 'blocked') throw new AppError('INVALID_ARGUMENT', { message: result.reasons.join('；') })
      return await this.options.repository.update(scope, data => {
        this.assertScope(scope, generation)
        controller.signal.throwIfAborted()
        const item = this.definition(data, id, revision)
        if (item.enabled) throw new AppError('INVALID_STATE')
        Object.assign(item, { plan: result, planInputKey: planInputKey(item.input), revision: item.revision + 1, updatedAt: this.now() })
        return item
      })
    } finally {
      signal?.removeEventListener('abort', abort)
      clearTimeout(timeout)
      if (this.planning.get(id) === controller) this.planning.delete(id)
    }
  }
  async confirm(id: string, revision: number): Promise<ScheduledDefinition> {
    return this.enable(id, revision)
  }
  async workSource(taskId: string): Promise<WorkScheduleContext> {
    const scope = this.scope(), generation = this.generation
    if (!this.options.source) throw new AppError('INVALID_STATE')
    const result = await this.options.source.context(scope, taskId)
    this.assertScope(scope, generation)
    return result
  }
  async createFromWork(raw: CreateWorkSchedule): Promise<ScheduledDefinition> {
    const request = createWorkScheduleSchema.parse(raw)
    const scope = this.scope(), generation = this.generation, source = this.options.source
    if (!source) throw new AppError('INVALID_STATE')
    const guard = () => this.assertScope(scope, generation)
    const id = occurrenceId(`definition:${request.requestId}`, 0), requestKey = sourceFingerprint(request)
    const existing = (await this.options.repository.read(scope)).definitions.find(item => item.id === id)
    guard()
    if (existing) {
      if (existing.deleted || existing.plan?.kind !== 'arrangement' || existing.plan.source?.requestKey !== requestKey) throw new AppError('CONFLICT')
      return existing
    }
    if (request.scheduledAt <= this.now()) throw new AppError('INVALID_ARGUMENT', { message: '请选择未来的执行时间。' })
    // Persist the empty transaction envelope before any independent template is written.
    await this.options.repository.update(scope, () => { guard() })
    const template = await source.capture(scope, request.taskId, request.expectedPlanHash, id, guard)
    guard()
    for (const node of template.nodes) {
      const employee = await withTimeout(this.options.employee(node.subscriptionId, node.modelId), 60000, 'scheduled-work-authorization')
      guard()
      if (employee === null || employee === undefined || employee === false) throw new AppError('EMPLOYEE_UNAVAILABLE')
    }
    const primary = template.nodes[0]!
    const input = scheduleInputSchema.parse({ mode: 'auto', name: request.name, goal: template.goal,
      subscriptionId: primary.subscriptionId, modelId: primary.modelId, workDir: template.workspace.path,
      permissions: { preset: template.permissions.preset, approvalMode: template.permissions.approvalMode ?? 'confirm-each' },
      scheduledAt: request.scheduledAt, timezone: request.timezone, recurrence: request.recurrence })
    const plan = source.view(template, request.taskId, requestKey)
    const created = await this.options.repository.update(scope, data => {
      guard()
      const repeated = data.definitions.find(item => item.id === id)
      if (repeated) {
        if (repeated.deleted || repeated.plan?.kind !== 'arrangement' || repeated.plan.source?.requestKey !== requestKey) throw new AppError('CONFLICT')
        return repeated
      }
      if (input.scheduledAt <= this.now()) throw new AppError('INVALID_ARGUMENT', { message: '保存过程中执行时间已过，请重新设置时间。' })
      const definition: ScheduledDefinition = { id, revision: 1, input, plan, planInputKey: planInputKey(input), enabled: true, deleted: false,
        nextRunAt: input.scheduledAt, pausedAt: null, createdAt: this.now(), updatedAt: this.now() }
      data.definitions.push(definition)
      return definition
    })
    this.timer.request()
    log.info('========== [SCHEDULED TASK] WORK COPIED AND ENABLED ==========', { scheduledTaskId: id, sourceTaskId: request.taskId, nextRunAt: created.nextRunAt, nodeCount: template.nodes.length })
    return created
  }
  async editFromWork(raw: EditWorkSchedule): Promise<ScheduledDefinition> {
    const request = editWorkScheduleSchema.parse(raw), scope = this.scope(), generation = this.generation
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope, generation)
      const item = this.definition(data, request.id, request.expectedRevision)
      if (item.plan?.kind !== 'arrangement' || !item.plan.source) throw new AppError('INVALID_STATE')
      if (data.occurrences.some(run => run.definitionId === item.id && !TERMINAL_SCHEDULE_STATUSES.has(run.status))) throw new AppError('INVALID_STATE', { message: '请先处理或停止当前执行，再修改时间。' })
      if (request.scheduledAt <= this.now() || data.occurrences.some(run => run.definitionId === item.id && run.scheduledAt === request.scheduledAt)) throw new AppError('INVALID_ARGUMENT', { message: '请选择尚未执行过的未来时间。' })
      const input = scheduleInputSchema.parse({ ...item.input, name: request.name, scheduledAt: request.scheduledAt, recurrence: request.recurrence, timezone: request.timezone })
      Object.assign(item, { input, planInputKey: planInputKey(input), enabled: true, nextRunAt: input.scheduledAt, pausedAt: null, revision: item.revision + 1, updatedAt: this.now() })
      return item
    })
    this.timer.request()
    log.info('========== [SCHEDULED TASK] COPIED WORK TIMING UPDATED ==========', { scheduledTaskId: result.id, revision: result.revision, nextRunAt: result.nextRunAt })
    return result
  }
  async confirmCreation(id: string, revision: number, creationId: string, creationRevision: number, guard?: () => void): Promise<ScheduledDefinition> {
    return this.enable(id, revision, { id: creationId, revision: creationRevision, guard })
  }
  private async enable(id: string, revision: number, creation?: { id: string; revision: number; guard?: () => void }): Promise<ScheduledDefinition> {
    const scope = this.scope()
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope)
      creation?.guard?.()
      const preparation = creation ? data.creations?.find(item => item.id === creation.id) : undefined
      if (creation && (!preparation || preparation.revision !== creation.revision || preparation.stage !== 'enabling' || preparation.definitionId !== id)) throw new AppError('DRAFT_REVISION_CONFLICT')
      const item = this.definition(data, id, revision)
      if (preparation && JSON.stringify(preparation.definitionInput) !== JSON.stringify(item.input)) throw new AppError('DRAFT_REVISION_CONFLICT')
      if (!item.plan || item.planInputKey !== planInputKey(item.input)) throw new AppError('INVALID_STATE', { message: '请先生成并确认工作计划。' })
      const recurrence = item.input.recurrence ?? { frequency: 'once' as const, interval: 1 }
      if (data.occurrences.some(run => run.definitionId === id && !TERMINAL_SCHEDULE_STATUSES.has(run.status))) throw new AppError('INVALID_STATE')
      let nextRunAt: number | null = item.input.scheduledAt
      if (recurrence.frequency === 'once') {
        if (data.occurrences.some(run => run.definitionId === id && run.scheduledAt === item.input.scheduledAt)) throw new AppError('INVALID_STATE')
        if (item.input.scheduledAt <= this.now()) throw new AppError('INVALID_ARGUMENT')
      } else if (recurrence.frequency === 'cron') {
        nextRunAt = item.input.scheduledAt > this.now() ? item.input.scheduledAt : nextScheduledAt(this.now(), recurrence, item.input.timezone)
      } else {
        for (let count = 0; nextRunAt !== null && nextRunAt <= this.now() && count < 10000; count++) {
          nextRunAt = nextScheduledAt(nextRunAt, recurrence, item.input.timezone, item.input.scheduledAt)
        }
        if (nextRunAt === null || nextRunAt <= this.now()) throw new AppError('INVALID_STATE', { message: 'Unable to determine next recurring execution' })
      }
      Object.assign(item, { enabled: true, nextRunAt, pausedAt: null, revision: item.revision + 1, updatedAt: this.now() })
      if (preparation) { preparation.stage = 'completed'; preparation.error = null; preparation.revision++; preparation.updatedAt = this.now() }
      return item
    })
    this.timer.request()
    log.info('scheduled definition enabled', { scheduledTaskId: id, revision: result.revision, nextRunAt: result.nextRunAt })
    return result
  }
  async pause(id: string, revision: number, remove = false): Promise<void> {
    const scope = this.scope()
    await this.options.repository.update(scope, data => {
      this.assertScope(scope)
      const item = this.definition(data, id, revision)
      if (remove && data.occurrences.some(run => run.definitionId === id && !TERMINAL_SCHEDULE_STATUSES.has(run.status))) throw new AppError('INVALID_STATE', { message: '请先停止并核查当前执行，再删除任务。' })
      item.pausedAt = remove ? null : item.enabled ? this.now() : item.pausedAt ?? null
      item.enabled = false; item.nextRunAt = null; item.deleted = remove; item.revision++; item.updatedAt = this.now()
    })
    this.planning.get(id)?.abort()
    this.timer.request()
    log.info(remove ? 'scheduled definition archived' : 'scheduled definition paused', { scheduledTaskId: id })
  }
  async check(runId: string, acknowledgeReview = false): Promise<void> {
    const scope = this.scope()
    const snapshot = (await this.options.repository.read(scope)).occurrences.find(run => run.id === runId)
    if (acknowledgeReview && snapshot?.status !== 'review') throw new AppError('INVALID_STATE', { message: '执行状态已变化，请刷新记录后再核查。' })
    if (snapshot?.status === 'review') {
      if (!acknowledgeReview) throw new AppError('INVALID_STATE', { message: '请先核查已有文件和外部操作，再明确确认关闭本次执行。' })
      const result = await withTimeout(this.options.runner.inspect(snapshot), 15000, 'scheduled-review')
      this.assertScope(scope)
      if (['running', 'pending', 'waiting_approval'].includes(result.state)) throw new AppError('INVALID_STATE', { message: '执行仍在运行或等待审批，请先停止后再关闭记录。' })
      await this.options.repository.update(scope, data => {
        this.assertScope(scope)
        const run = data.occurrences.find(item => item.id === runId)
        if (!run || run.status !== 'review') throw new AppError('INVALID_STATE')
        run.status = 'cancelled'; run.finishedAt = this.now(); run.nextRetryAt = null
        run.error = { code: 'REVIEW_ACKNOWLEDGED', action: 'blocked', message: '用户已核查并关闭本次执行，未重新执行任务。请保留并确认已有文件及外部操作结果。' }
        const attempt = run.attempts.at(-1)
        if (attempt && !attempt.finishedAt) { attempt.status = 'interrupted'; attempt.finishedAt = this.now(); attempt.error = run.error }
      })
      this.timer.request()
      return
    }
    await this.options.repository.update(scope, data => {
      this.assertScope(scope)
      const run = data.occurrences.find(value => value.id === runId)
      if (!run || !['blocked', 'waiting_auth'].includes(run.status)) throw new AppError('INVALID_STATE')
      run.status = 'pending'; run.nextRetryAt = null
    })
    this.timer.request()
  }
  async cancel(runId: string): Promise<void> { await this.dispatcher.cancel(this.scope(), runId); this.timer.request() }
  async scan(): Promise<void> {
    const scope = this.options.scope.currentScope()
    if (!scope) return
    const generation = this.generation
    await this.scans.run('scan', async () => {
      this.assertScope(scope, generation)
      const before = await this.options.repository.read(scope)
      const dueLogs: { level: 'info' | 'warn'; message: string; fields: Record<string, unknown> }[] = []
      if (before.definitions.some(item => item.enabled && !item.deleted && item.nextRunAt !== null && item.nextRunAt <= this.now())) await this.options.repository.update(scope, data => {
        this.assertScope(scope, generation)
        for (const item of data.definitions) {
          if (!item.enabled || item.deleted || item.nextRunAt === null || item.nextRunAt > this.now() || !item.plan) continue
          const recurrence = item.input.recurrence ?? { frequency: 'once' as const, interval: 1 }
          const { points: missedSchedulePoints, following, consolidated } = dueScheduleWindow(item.nextRunAt, this.now(), recurrence, item.input.timezone, item.input.scheduledAt)
          const scheduledAt = missedSchedulePoints.at(-1)!
          for (const missedAt of missedSchedulePoints.slice(0, -1)) {
            const missedId = occurrenceId(item.id, missedAt)
            if (data.occurrences.some(run => run.id === missedId)) continue
            dueLogs.push({ level: 'warn', message: '========== [SCHEDULED TASK] MISSED OCCURRENCE RECORDED ==========', fields: {
              scheduledTaskId: item.id, occurrenceId: missedId, revision: item.revision,
              scheduledAt: missedAt, consolidated,
            } })
            const missedIssue: ScheduledOccurrence['error'] = {
              code: 'MISFIRE_COALESCED', message: consolidated ? '长期停机期间的较早时间点已合并；仅补执行最近一次安排。' : '此时间点已错过，仅补执行最近一次安排。', action: 'blocked',
            }
            data.occurrences.push({ id: missedId, definitionId: item.id, revision: item.revision, scheduledAt: missedAt, taskId: randomUUID(),
              input: structuredClone(item.input), plan: structuredClone(item.plan), status: 'missed', firstEligibleAt: this.now(),
              startDeadline: Math.min(this.now() + 3600000, missedAt + 86400000), startedAt: null, finishedAt: this.now(), nextRetryAt: null,
              error: missedIssue,
              attempts: [], stopReason: null })
          }
          const id = occurrenceId(item.id, scheduledAt)
          if (!data.occurrences.some(run => run.id === id)) {
            const missed = this.now() - scheduledAt > 86400000
            dueLogs.push({ level: missed ? 'warn' : 'info', message: missed
              ? '========== [SCHEDULED TASK] DUE TIME OUTSIDE RECOVERY WINDOW =========='
              : '========== [SCHEDULED TASK] DUE OCCURRENCE CREATED ==========', fields: {
              scheduledTaskId: item.id, occurrenceId: id, revision: item.revision,
              scheduledAt, timezone: item.input.timezone, missed,
              recurrence: recurrence.frequency,
            } })
            const run: ScheduledOccurrence = { id, definitionId: item.id, revision: item.revision, scheduledAt, taskId: randomUUID(),
              input: structuredClone(item.input), plan: structuredClone(item.plan), status: missed ? 'missed' : 'pending',
              firstEligibleAt: this.now(), startDeadline: Math.min(this.now() + 3600000, scheduledAt + 86400000), startedAt: null,
              finishedAt: missed ? this.now() : null, nextRetryAt: null,
              error: missed ? { code: 'MISFIRE_WINDOW_EXCEEDED', message: '已错过执行时间超过 24 小时，本次不补执行。', action: 'blocked' } : null, attempts: [], stopReason: null }
            data.occurrences.push(run)
          }
          item.nextRunAt = following
          if (following === null) item.enabled = false
        }
      })
      this.assertScope(scope, generation)
      for (const entry of dueLogs) log[entry.level](entry.message, entry.fields)
      await this.dispatcher.scan(scope, () => this.assertScope(scope, generation))
    })
  }
  async recover(): Promise<void> {
    const scope = this.scope()
    log.info('========== [SCHEDULED TASK] RECOVERY SCAN START ==========')
    await this.dispatcher.recover(scope)
    log.info('========== [SCHEDULED TASK] RECOVERY SCAN COMPLETE ==========')
  }
  async resume(): Promise<void> {
    const scope = this.scope()
    this.timer.stop()
    const generation = ++this.generation
    await this.scans.run('scan', async () => { this.assertScope(scope, generation); await this.recover() })
    this.assertScope(scope, generation)
    this.timer.start()
    log.info('========== [SCHEDULED TASK] SCHEDULER RESUMED ==========')
  }
  stop(): void { this.generation++; this.timer.stop(); for (const controller of this.planning.values()) controller.abort(); this.planning.clear() }
  wake(): void { this.timer.request() }
  private async deadlines(): Promise<number[]> {
    if (!this.options.scope.currentScope()) return []
    const data = await this.list()
    return [...data.definitions.filter(item => item.enabled && item.nextRunAt !== null).map(item => item.nextRunAt!),
      ...data.occurrences.filter(run => !TERMINAL_SCHEDULE_STATUSES.has(run.status) && run.status !== 'review').map(run => {
        if (['running', 'waiting_approval', 'launching', 'cancelling'].includes(run.status)) return this.now() + 2000
        if (['blocked', 'waiting_auth'].includes(run.status)) return run.startDeadline
        return run.nextRetryAt ?? this.now()
      })]
  }
}
