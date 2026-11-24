import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isScheduledCreationWorking, scheduledCreationRequestSchema, scheduleInterpretationSchema, type ScheduledCreation, type ScheduledCreationRequest, type ScheduledCreationInterpreterInput, type ConversationScheduleReceipt } from '../../src/shared/scheduled-creation'
import type { ScheduleInput } from '../../src/shared/scheduled-tasks'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { occurrenceId, requestsRestrictedWindowsSchedulePath, scheduledPathDenied, scheduledWorkspaceErrorMessage } from '../domain/scheduled-task'
import { scheduleCandidateInput, ScheduleCandidateError } from '../domain/scheduled-creation'
import { cronPreview } from '../../src/shared/cron-schedule'
import { AppError } from '../errors/app-error'
import { withTimeout } from '../common/with-timeout'
import { logger } from '../common/logger'
import type { ScheduledTaskService } from './scheduled-task-service'
import type { AttachmentService } from './attachment-service'

interface ConversationCreationReview {
  signal: AbortSignal
  approve(input: ScheduleInput): Promise<boolean>
  receivedAt: number
}

const log = logger.child('scheduled-creation')
const employeeSchema = z.object({ subscriptionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name: z.string().max(300),
  position: z.string().max(2000), functionalCategory: z.string().max(2000), description: z.string().max(16000),
  allowedModels: z.array(z.string().min(1).max(160)).max(200) }).strict()
type Employee = z.infer<typeof employeeSchema>
export interface ScheduledCreationOptions {
  repository: ScheduledRepository
  scope: { currentScope(): TaskOwnerScope | null }
  schedules: ScheduledTaskService
  attachments?: Pick<AttachmentService, 'referenceMaterials'>
  catalog(): Promise<Employee[]>
  authorize(subscriptionId: string, modelId: string): Promise<unknown>
  validateWorkspace(workDir: string): Promise<void>
  interpret(input: ScheduledCreationInterpreterInput, signal: AbortSignal): Promise<unknown>
  now?: () => number
}

/** Creation is resumable configuration work, never an admission to the Agent runtime. */
export class ScheduledCreationService {
  private readonly operations = new Map<string, { key: string; controller: AbortController; promise: Promise<ScheduledCreation> }>()
  private readonly now: () => number
  private generation = 0
  constructor(private readonly options: ScheduledCreationOptions) { this.now = options.now ?? Date.now }
  private scope(): TaskOwnerScope {
    const scope = this.options.scope.currentScope()
    if (!scope) throw new AppError('AUTH_REQUIRED')
    return scope
  }
  private assertScope(scope: TaskOwnerScope, generation: number): void {
    const current = this.scope()
    if (generation !== this.generation || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
  }
  private key(scope: TaskOwnerScope, id: string): string { return JSON.stringify([scope.enterpriseId, scope.memberId, id]) }
  private async validateWorkspace(workDir: string, label: string): Promise<void> {
    try { await withTimeout(this.options.validateWorkspace(workDir), 15000, label) }
    catch (error) {
      const errno = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const message = scheduledWorkspaceErrorMessage(errno)
      if (!message) throw error
      throw new AppError('WORKSPACE_INVALID', { message, cause: error })
    }
  }
  submit(raw: ScheduledCreationRequest): Promise<ScheduledCreation> {
    return this.start(raw)
  }
  async submitConversation(raw: ScheduledCreationRequest, review: ConversationCreationReview): Promise<ConversationScheduleReceipt> {
    const scope = this.scope(), generation = this.generation
    const record = await this.start(raw, review)
    this.assertScope(scope, generation)
    if (record.stage === 'completed') {
      const definition = (await this.options.repository.read(scope)).definitions.find(item => item.id === record.definitionId)
      this.assertScope(scope, generation)
      if (definition?.enabled && definition.nextRunAt !== null) return { status: 'created', id: definition.id, title: definition.input.name,
        timezone: definition.input.timezone, nextRunAt: definition.nextRunAt }
      return { status: 'blocked', message: '这条消息已创建过定时任务；请前往「定时任务」查看当前状态。' }
    }
    if (record.stage === 'needs_input') return { status: 'needs_input', message: record.interpretation?.questions.map(item => item.question).join('\n').slice(0, 3800) || '请补充工作内容和明确的开始时间。' }
    if (record.stage === 'blocked') return { status: 'blocked', message: record.interpretation?.reasons.map(item => item.message).join('\n').slice(0, 3800) || '当前请求不能创建定时任务。' }
    if (record.stage === 'cancelled') return { status: 'cancelled', message: '未获确认，定时任务未启用。' }
    return { status: 'failed', message: record.error ?? '定时任务未启用，请查看后重试。' }
  }
  private start(raw: ScheduledCreationRequest, review?: ConversationCreationReview): Promise<ScheduledCreation> {
    const request = scheduledCreationRequestSchema.parse(raw), scope = this.scope(), generation = this.generation
    const { requestId, expectedRevision: _revision, ...input } = request
    const submissionKey = createHash('sha256').update(JSON.stringify(review ? ['conversation', input] : input)).digest('hex')
    const key = this.key(scope, requestId), running = this.operations.get(key)
    if (running) {
      if (running.key !== submissionKey) return Promise.reject(new AppError('CONFLICT'))
      return running.promise
    }
    if (this.operations.size >= 2) return Promise.reject(new AppError('CONFLICT', { message: '正在准备其他定时任务，请稍后重试。' }))
    const controller = new AbortController()
    const promise = this.run(scope, generation, request, submissionKey, controller, review).finally(() => {
      if (this.operations.get(key)?.controller === controller) this.operations.delete(key)
    })
    this.operations.set(key, { key: submissionKey, controller, promise })
    return promise
  }
  private async run(scope: TaskOwnerScope, generation: number, request: ScheduledCreationRequest, submissionKey: string, controller: AbortController, review?: ConversationCreationReview): Promise<ScheduledCreation> {
    const { requestId, expectedRevision, ...input } = request
    const signal = review ? AbortSignal.any([controller.signal, review.signal]) : controller.signal
    const guard = () => { this.assertScope(scope, generation); signal.throwIfAborted() }
    const prior = input.referenceFiles ? (await this.options.repository.read(scope)).creations?.find(item => item.id === requestId) : undefined
    guard()
    const message = { role: 'user' as const, content: input.message, receivedAt: review?.receivedAt ?? this.now() }
    if (input.referenceFiles && prior?.submissionKey !== submissionKey && !this.options.attachments) throw new AppError('SERVICE_UNAVAILABLE')
    const referenceMaterials = input.referenceFiles && prior?.submissionKey !== submissionKey
      ? await this.options.attachments!.referenceMaterials(scope, input.referenceFiles) : undefined
    const messageWithReferences = referenceMaterials ? { ...message, referenceMaterials } : message
    let record = await this.options.repository.update(scope, data => {
      guard()
      const records = data.creations ??= []
      const existing = records.find(item => item.id === requestId)
      if (existing) {
        if (!!existing.fromConversation !== !!review) throw new AppError('INVALID_STATE')
        if (existing.submissionKey === submissionKey) return existing
        if (existing.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
        if (existing.deleted || ['completed', 'cancelled'].includes(existing.stage)) throw new AppError('INVALID_STATE', { message: '本次创建已结束，请从任务详情修改配置，或新建任务。' })
        if (existing.messages.length >= 20) throw new AppError('INVALID_ARGUMENT', { message: '补充次数已达上限，请重新描述并新建任务。' })
        Object.assign(existing, { request: input, submissionKey,
          messages: [...existing.messages, messageWithReferences], stage: 'parsing', error: null,
          revision: existing.revision + 1, updatedAt: this.now() })
        return existing
      }
      if (expectedRevision !== undefined) throw new AppError('DRAFT_REVISION_CONFLICT')
      const created: ScheduledCreation = { id: requestId, revision: 1, request: input, submissionKey,
        ...(review ? { fromConversation: true } : {}),
        referenceNow: this.now(), messages: [messageWithReferences], interpretation: null, parsedSubmissionKey: null, definitionSubmissionKey: null,
        stage: 'parsing', definitionId: null, definitionInput: null, error: null, createdAt: this.now(), updatedAt: this.now() }
      records.push(created)
      return created
    })
    this.assertScope(scope, generation)
    if (record.deleted || ['completed', 'cancelled', 'needs_input', 'blocked'].includes(record.stage)) return record
    const change = async (mutate: (item: ScheduledCreation) => void) => {
      guard()
      record = await this.options.repository.update(scope, data => {
        guard()
        const item = data.creations?.find(value => value.id === requestId)
        if (!item || item.revision !== record.revision) throw new AppError('DRAFT_REVISION_CONFLICT')
        if (item.stage === 'cancelled' || item.stage === 'completed') throw new AppError('INVALID_STATE')
        mutate(item); item.revision++; item.updatedAt = this.now()
        return item
      })
      log.info('scheduled creation progress saved', { creationId: record.id, scheduledTaskId: record.definitionId, stage: record.stage, revision: record.revision })
    }
    try {
      const catalog = z.array(employeeSchema).max(1000).parse(await withTimeout(this.options.catalog(), 30000, 'scheduled-creation-catalog'))
      guard()
      const planningEmployee = catalog.find(item => item.allowedModels.includes(input.modelId))
      if (!planningEmployee) throw new AppError('MODEL_NOT_ALLOWED')
      await withTimeout(this.options.authorize(planningEmployee.subscriptionId, input.modelId), 30000, 'scheduled-creation-authorization')
      guard()
      await this.validateWorkspace(input.workDir, 'scheduled-creation-workspace')
      guard()
      if (record.parsedSubmissionKey !== submissionKey || !record.interpretation) {
        await change(item => { item.stage = 'parsing'; item.error = null })
        const timeout = setTimeout(() => controller.abort(), 45000)
        let result: unknown
        try {
          result = await withTimeout(this.options.interpret({ subscriptionId: planningEmployee.subscriptionId, modelId: input.modelId,
            ...(review ? { fromConversation: true } : {}),
            referenceNow: record.referenceNow, timezone: input.timezone, employeeCatalog: catalog,
            currentDraft: record.interpretation, messages: record.messages }, signal), 45000, 'scheduled-creation-interpretation')
        } finally { clearTimeout(timeout) }
        guard()
        const parsed = scheduleInterpretationSchema.parse(result)
        await change(item => { item.interpretation = parsed; item.parsedSubmissionKey = submissionKey; item.stage = parsed.status === 'ready' ? 'planning' : parsed.status })
        if (parsed.status !== 'ready') return record
      }
      const candidate = record.interpretation!
      if (candidate.status === 'ready' && requestsRestrictedWindowsSchedulePath(input.permissions,
        input.message, candidate.task.goal ?? '', ...candidate.task.deliverables)) {
        await change(item => {
          item.stage = 'blocked'
          item.interpretation = { ...candidate, status: 'blocked', questions: [],
            reasons: [{ code: 'UNSUPPORTED_SETTING', message: scheduledPathDenied.message }] }
        })
        return record
      }
      const execution = candidate.task.execution
      const selected = execution.mode === 'employee' ? catalog.find(item => item.subscriptionId === execution.subscriptionId) : planningEmployee
      if (!selected) throw new AppError('EMPLOYEE_UNAVAILABLE')
      if (!selected.allowedModels.includes(input.modelId)) throw new AppError('MODEL_NOT_ALLOWED')
      let configured: ScheduleInput
      try { configured = scheduleCandidateInput(candidate, { ...input, subscriptionId: selected.subscriptionId }, this.now()) }
      catch (error) {
        if (!(error instanceof ScheduleCandidateError)) throw error
        await change(item => {
          item.stage = 'needs_input'; item.error = null
          item.interpretation = { ...candidate, status: 'needs_input', questions: [{ field: error.field, question: error.field === 'schedule'
            ? '执行时间已过、无效或处于夏令时歧义时段，请补充一个明确的未来时间。' : '工作内容与交付要求过长，请精简后继续。' }], reasons: [] }
        })
        return record
      }
      const snapshot = await this.options.repository.read(scope)
      guard()
      let definition = record.definitionId ? snapshot.definitions.find(item => item.id === record.definitionId) : undefined
      if (definition?.deleted || definition?.enabled) throw new AppError('CONFLICT', { message: '任务配置已在其他入口变更，请从任务详情查看。' })
      if (definition && record.definitionInput && JSON.stringify(definition.input) !== JSON.stringify(record.definitionInput)) throw new AppError('DRAFT_REVISION_CONFLICT')
      // Keep the original calendar anchor on replay; recomputing it changes the create request.
      const sameSubmission = record.definitionInput && record.definitionSubmissionKey === submissionKey
      if (sameSubmission && definition) configured = record.definitionInput!
      if (configured.recurrence?.frequency === 'cron' && configured.scheduledAt <= this.now() && !definition) {
        configured = { ...configured, scheduledAt: cronPreview(configured.recurrence.expression, configured.timezone, this.now(), 1)[0]! }
      }
      const definitionId = occurrenceId(`definition:${requestId}`, 0)
      if (review) {
        const approved = await review.approve(configured)
        guard()
        if (!approved) {
          await change(item => { item.stage = 'cancelled' })
          return record
        }
      }
      const previousInput = record.definitionInput
      await change(item => { item.definitionId = definitionId; item.stage = 'planning'; item.error = null })
      if (!definition) definition = await this.options.schedules.create(requestId, configured, { id: record.id, revision: record.revision, guard })
      else if (JSON.stringify(definition.input) !== JSON.stringify(configured)) {
        if (!previousInput || JSON.stringify(definition.input) !== JSON.stringify(previousInput)) throw new AppError('DRAFT_REVISION_CONFLICT')
        definition = await this.options.schedules.edit(definition.id, definition.revision, configured, { id: record.id, revision: record.revision, guard })
      } else if (record.definitionSubmissionKey !== submissionKey) {
        definition = await this.options.schedules.create(requestId, configured, { id: record.id, revision: record.revision, guard })
      }
      guard()
      const linked = (await this.options.repository.read(scope)).creations?.find(item => item.id === requestId)
      guard()
      if (!linked || linked.stage === 'cancelled') throw new AppError('INVALID_STATE')
      record = linked
      try { definition = await this.options.schedules.plan(definition.id, definition.revision, signal) }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== 'INVALID_ARGUMENT') throw error
        await change(item => {
          item.stage = 'needs_input'
          item.interpretation = { ...candidate, status: 'needs_input', questions: [{ field: 'goal', question: error.userMessage.slice(0, 2000) }], reasons: [] }
        })
        return record
      }
      guard()
      if (configured.mode === 'general' || configured.mode === 'empty-text') throw new AppError('INVALID_STATE')
      const nodes = definition.plan?.kind === 'arrangement' ? definition.plan.nodes : [{ subscriptionId: configured.subscriptionId, modelId: configured.modelId }]
      for (const node of nodes) {
        await withTimeout(this.options.authorize(node.subscriptionId, node.modelId), 30000, 'scheduled-creation-final-authorization')
        guard()
      }
      await this.validateWorkspace(input.workDir, 'scheduled-creation-final-workspace')
      guard()
      await change(item => { item.stage = 'enabling' })
      try { await this.options.schedules.confirmCreation(definition.id, definition.revision, record.id, record.revision, guard) }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== 'INVALID_ARGUMENT' || configured.recurrence?.frequency !== 'once') throw error
        await change(item => {
          item.stage = 'needs_input'
          item.interpretation = { ...candidate, status: 'needs_input', questions: [{ field: 'schedule', question: '规划期间原执行时间已过，请补充一个未来的执行时间。' }], reasons: [] }
        })
        return record
      }
      guard()
      const completed = (await this.options.repository.read(scope)).creations?.find(item => item.id === requestId)
      guard()
      if (!completed || completed.stage !== 'completed') throw new AppError('PERSISTENCE_ERROR')
      return completed
    } catch (error) {
      this.assertScope(scope, generation)
      const current = (await this.options.repository.read(scope)).creations?.find(item => item.id === requestId)
      this.assertScope(scope, generation)
      if (current?.stage === 'cancelled' || current?.stage === 'completed') return current
      // Do not let a timed-out model or a stale continuation overwrite a newer answer.
      if (!current || current.revision !== record.revision) throw error
      const code = error instanceof AppError ? error.code : 'CREATION_FAILED'
      const message = code === 'MODEL_NOT_ALLOWED' ? '当前模型未获授权，或指定员工不能使用此模型，请调整模型后重试。'
        : code === 'EMPLOYEE_UNAVAILABLE' ? '指定员工不在当前可用员工中，请检查授权或补充员工信息。'
          : error instanceof AppError && error.code === 'WORKSPACE_INVALID' ? error.userMessage
            : code === 'AUTH_REQUIRED' ? '请重新登录后继续创建。'
              : '定时任务创建未完成，输入和已保存进度已保留，可继续重试。'
      record = await this.options.repository.update(scope, data => {
        this.assertScope(scope, generation)
        const item = data.creations?.find(value => value.id === requestId)
        if (!item || item.revision !== current.revision || ['cancelled', 'completed'].includes(item.stage)) throw new AppError('DRAFT_REVISION_CONFLICT')
        item.stage = 'failed'; item.error = message; item.revision++; item.updatedAt = this.now()
        return item
      })
      log.warn('scheduled creation did not complete', { creationId: record.id, scheduledTaskId: record.definitionId, code })
      this.assertScope(scope, generation)
      return record
    }
  }
  async cancel(id: string, revision: number): Promise<ScheduledCreation> {
    const scope = this.scope(), generation = this.generation
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope, generation)
      const item = data.creations?.find(value => value.id === id)
      if (!item) throw new AppError('NOT_FOUND')
      if (item.stage === 'cancelled') return item
      if (item.deleted) throw new AppError('NOT_FOUND')
      if (item.revision !== revision) throw new AppError('DRAFT_REVISION_CONFLICT')
      if (item.stage === 'completed') throw new AppError('INVALID_STATE', { message: '任务已创建，请从任务详情暂停或删除。' })
      item.stage = 'cancelled'; item.error = null; item.revision++; item.updatedAt = this.now()
      return item
    })
    this.assertScope(scope, generation)
    this.operations.get(this.key(scope, id))?.controller.abort()
    return result
  }
  async deleteRecord(id: string, revision: number): Promise<ScheduledCreation> {
    const scope = this.scope(), generation = this.generation
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope, generation)
      const item = data.creations?.find(value => value.id === id)
      if (!item) throw new AppError('NOT_FOUND')
      if (item.deleted) return item
      if (item.revision !== revision) throw new AppError('DRAFT_REVISION_CONFLICT')
      if (isScheduledCreationWorking(item.stage) || (item.stage !== 'cancelled' && this.operations.has(this.key(scope, id)))) {
        throw new AppError('INVALID_STATE', { message: '创建正在处理中，请等操作完成后再删除记录。' })
      }
      // Keep the request identity so a delayed retry cannot create or enable work again.
      item.deleted = true; item.revision++; item.updatedAt = this.now()
      return item
    })
    this.assertScope(scope, generation)
    return result
  }
  async recover(): Promise<void> {
    const scope = this.scope(), generation = this.generation
    await this.options.repository.update(scope, data => {
      this.assertScope(scope, generation)
      for (const item of data.creations ?? []) {
        if (isScheduledCreationWorking(item.stage) && !this.operations.has(this.key(scope, item.id))) {
          item.stage = 'failed'; item.error = '创建过程已中断，已保存进度，请继续创建。'; item.revision++; item.updatedAt = this.now()
        }
      }
    })
    this.assertScope(scope, generation)
  }
  stop(): void { this.generation++; for (const operation of this.operations.values()) operation.controller.abort(); this.operations.clear() }
}
