import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isScheduledCreationFinished, isScheduledCreationWorking, scheduledCreationProgressAction, scheduledCreationRequestSchema, scheduleInterpretationSchema, type ScheduledCreation, type ScheduledCreationRequest, type ScheduledCreationInterpreterInput, type ConversationScheduleDraft, type ConversationScheduleReceipt, type ScheduleInterpretation } from '../../src/shared/scheduled-creation'
import { retiredScheduledExecutionMessage, type ModelScheduledInput, type ScheduledSnapshot } from '../../src/shared/scheduled-tasks'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { occurrenceId, requestsRestrictedWindowsSchedulePath, scheduledPathDenied, scheduledWorkspaceErrorMessage } from '../domain/scheduled-task'
import { applyConversationScheduleTime, conversationScheduleClock, conversationScheduleRestart, conversationScheduleRetry, reviseConversationScheduleClock, scheduleCandidateInput, ScheduleCandidateError } from '../domain/scheduled-creation'
import { cronPreview } from '../../src/shared/cron-schedule'
import { AppError } from '../errors/app-error'
import { withTimeout } from '../common/with-timeout'
import { logger } from '../common/logger'
import type { ScheduledTaskService } from './scheduled-task-service'
import type { AttachmentService } from './attachment-service'
import type { ConversationCreationReview } from '../runtime/conversation-schedule'
import { redactText } from '../common/redact'

type CreationReview = ConversationCreationReview & { reissueSource?: ScheduledCreation; turnId?: string }
const draftRef = (item: ScheduledCreation): ConversationScheduleDraft => ({ id: item.id, revision: item.revision })
const awaiting = (item: ScheduledCreation) => item.stage === 'needs_input' || item.stage === 'needs_confirmation'
const verifiedLegacy = (item: ScheduledCreation, records: ScheduledCreation[], sources?: ReadonlyMap<string, string>) =>
  !item.conversationId && !item.definitionId && item.stage === 'cancelled' && sources?.get(item.id) === item.messages[0]?.content &&
  !!sources?.has(item.id) && !records.some(record => record.reissuedFrom === item.id)
const canReissue = (item: ScheduledCreation, records: ScheduledCreation[], review: ConversationCreationReview) =>
  !!review.conversationId && item.fromConversation && !item.deleted && !item.definitionId && item.stage === 'cancelled' &&
  (item.conversationId ? item.conversationId === review.conversationId && !records.some(record => record.reissuedFrom === item.id)
    : verifiedLegacy(item, records, review.legacySources))
const timeOnly = (candidate: ScheduleInterpretation): ScheduleInterpretation => ({ ...candidate, status: 'needs_input', reasons: [],
  questions: [{ field: 'schedule', question: '任务尚未启用。请提供明确的未来执行时间。' }] })

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
  async hasConversationDrafts(conversationId: string, legacySources?: ReadonlyMap<string, string>): Promise<boolean> {
    const scope = this.scope(), generation = this.generation
    const { creations = [] } = await this.options.repository.read(scope)
    this.assertScope(scope, generation)
    return creations.some(item => item.fromConversation && !item.deleted &&
      (item.conversationId === conversationId && awaiting(item) || verifiedLegacy(item, creations, legacySources)))
  }
  async submitConversation(raw: ScheduledCreationRequest, review: ConversationCreationReview): Promise<ConversationScheduleReceipt> {
    const scope = this.scope(), generation = this.generation
    let resolved: CreationReview = { ...review, ...(review.conversationId && raw.expectedRevision === undefined ? { turnId: raw.requestId } : {}) }
    if (review.allowContext && raw.expectedRevision !== undefined && !review.draftAction) {
      const { creations } = await this.options.repository.read(scope)
      this.assertScope(scope, generation)
      review.signal.throwIfAborted()
      if (!creations?.some(item => item.id === raw.requestId)) {
        return { status: 'needs_context', message: '已保存的配置不可用，请从相关的会话原话复原。' }
      }
    }
    if (review.continuation || review.resumeDrafts || review.draftAction) {
      const revisions = new Map(review.resumeDrafts?.map(draft => [draft.id, draft.revision]))
      const snapshot = await this.options.repository.read(scope)
      const records = snapshot.creations ?? []
      const guard = () => { this.assertScope(scope, generation); review.signal.throwIfAborted() }
      guard()
      const replay = records.find(item => item.conversationId === review.conversationId && item.conversationTurnId === resolved.turnId && !!resolved.turnId)
      if (replay) return this.conversationReceipt(scope, generation, replay)
      const restarting = review.continuation === 'restart'
      const sources = review.contextSources ?? []
      const contextual = review.continuation === 'contextual' && sources.length > 0 && !!review.candidate
      const target = review.draftAction?.draft ?? (restarting ? review.precedingDiscard : undefined)
      if (contextual && sources.some(source => source.schedule?.status === 'created' || records.some(item =>
        item.conversationId === review.conversationId && item.definitionId && item.stage === 'completed' &&
        (item.contextSourceTurns?.includes(source.id) || item.messages.some(message => message.receivedAt === source.receivedAt && message.content === source.content))))) {
        return { status: 'blocked', message: '这项安排已经创建过。请在「定时任务」中核对并管理已有任务；不会重复创建。' }
      }
      const explicitRetry = review.continuation === 'review' && !!conversationScheduleRetry(raw.message)
      const available = records.filter(item => item.fromConversation && !item.deleted && (
        !restarting && awaiting(item) && (item.conversationId ? item.conversationId === review.conversationId : revisions.has(item.id)) ||
        (restarting || contextual || review.draftAction?.kind === 'review' || explicitRetry && !item.conversationId) && canReissue(item, records, review)))
      const matches = target ? available.filter(item => item.id === target.id) : contextual ? available.filter(item => sources.some(source =>
        (source.schedule && 'draft' in source.schedule && source.schedule.draft?.id === item.id) ||
        item.contextSourceTurns?.includes(source.id) || item.messages.some(message => message.receivedAt === source.receivedAt && message.content === source.content))) : available
      if (matches.length > 1) {
        const clock = (restarting ? conversationScheduleRestart(raw.message) : conversationScheduleRetry(raw.message))?.clock ?? conversationScheduleClock(raw.message)
        const time = clock && `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`
        return { status: 'choose_draft', message: '本会话有多份定时草稿，请选择要继续的一份。',
          drafts: matches.map(item => ({ draft: draftRef(item), title: redactText(item.interpretation?.task.title ?? '定时任务') })), ...(time ? { time } : {}) }
      }
      const draft = matches[0]
      if (!draft && !review.draftAction && (!target || !records.some(item => item.id === target.id))) {
        if (contextual) {
          const record = await this.start(raw, { ...resolved, transient: true })
          guard()
          return this.conversationReceipt(scope, generation, record)
        }
        if (review.allowContext && !review.candidate) return { status: 'needs_context', message: '没有可复用的任务配置。请用本会话中相关的用户原话复原要求；只问缺失的条件，并先核对是否已有任务。' }
      }
      if (!draft || target && draft.revision !== target.revision || !draft.conversationId && awaiting(draft) && revisions.get(draft.id) !== draft.revision) {
        return { status: 'blocked', message: target ? '这份定时草稿已变更或结束，请使用最新的确认入口。'
          : restarting ? '本会话没有可重新创建的已放弃草稿。' : '本会话没有可核实的定时草稿。请说明要定时执行的工作。' }
      }
      const current = this.operations.has(this.key(scope, draft.id))
      if (current) return { status: 'blocked', message: '这份定时草稿正在处理中，请稍后再试。' }
      if (review.draftAction?.kind === 'discard') {
        const item = await this.cancel(draft.id, draft.revision, guard)
        return { status: 'discarded', message: '已放弃草稿，定时任务未启用。', draft: draftRef(item) }
      }
      if (draft.stage === 'cancelled') resolved = { ...resolved, candidate: contextual ? review.candidate : undefined, reissueSource: draft }
      else raw = { ...raw, requestId: draft.id, expectedRevision: draft.revision }
    }
    const record = await this.start(raw, resolved)
    this.assertScope(scope, generation)
    return this.conversationReceipt(scope, generation, record)
  }
  private async conversationReceipt(scope: TaskOwnerScope, generation: number, record: ScheduledCreation): Promise<ConversationScheduleReceipt> {
    if (record.deleted || record.confirmationOutcome === 'pending') return { status: 'blocked', message: '这份定时草稿已结束或仍在等待确认。' }
    let savedDraft: ConversationScheduleDraft | undefined
    if (record.stage === 'needs_input' || record.stage === 'needs_confirmation') {
      const { creations } = await this.options.repository.read(scope)
      this.assertScope(scope, generation)
      if (creations?.some(item => item.id === record.id && item.revision === record.revision && !item.deleted)) savedDraft = draftRef(record)
    }
    if (record.stage === 'needs_confirmation') {
      if (!savedDraft) return { status: 'cancelled', message: record.confirmationOutcome === 'timeout'
        ? '本次确认已超时，任务未创建。' : '未获确认，任务未创建。' }
      const message = record.confirmationOutcome === 'timeout' ? '上次确认已超时，任务未启用，草稿已保留。'
        : '上次未完成确认，任务未启用，草稿已保留。'
      return { status: 'needs_confirmation', message, draft: savedDraft }
    }
    if (record.stage === 'completed') {
      const definition = (await this.options.repository.read(scope)).definitions.find(item => item.id === record.definitionId)
      this.assertScope(scope, generation)
      if (definition?.enabled && definition.nextRunAt !== null) return { status: 'created', id: definition.id, title: definition.input.name,
        timezone: definition.input.timezone, nextRunAt: definition.nextRunAt, ...(record.conversationId ? { draft: draftRef(record) } : {}),
        ...(record.contextSourceTurns ? { sourceTurns: record.contextSourceTurns } : {}) }
      return { status: 'blocked', message: '这条消息已创建过定时任务；请前往「定时任务」查看当前状态。' }
    }
    if (record.stage === 'needs_input') return { status: 'needs_input', message: record.interpretation?.questions.map(item => item.question).join('\n').slice(0, 3800) || '请补充工作内容和明确的开始时间。',
      ...(savedDraft ? { draft: savedDraft } : {}),
      ...(record.interpretation?.questions.length && record.interpretation.questions.every(question => question.field === 'schedule') ? { timeOnly: true } : {}) }
    if (record.stage === 'blocked') return { status: 'blocked', message: record.interpretation?.reasons.map(item => item.message).join('\n').slice(0, 3800) || '当前请求不能创建定时任务。' }
    if (record.stage === 'cancelled') return { status: 'cancelled', message: '未获确认，定时任务未启用。' }
    return { status: 'failed', message: record.error ?? '定时任务未启用，请查看后重试。' }
  }
  private start(raw: ScheduledCreationRequest, review?: CreationReview): Promise<ScheduledCreation> {
    const request = scheduledCreationRequestSchema.parse(raw), scope = this.scope(), generation = this.generation
    const { requestId, expectedRevision, resumeFromProgress, ...input } = request
    if (review && resumeFromProgress) throw new AppError('INVALID_ARGUMENT')
    const submission = resumeFromProgress ? ['creation-progress', resumeFromProgress, expectedRevision, input]
      : review ? ['conversation', input, ...(expectedRevision === undefined ? [] : [expectedRevision])] : input
    const submissionKey = createHash('sha256').update(JSON.stringify(review?.contextSources?.length
      ? [submission, review.reissueSource?.id, review.contextSources.map(source => source.id), review.candidate]
      : review?.draftAction || review?.reissueSource
      ? [submission, review.draftAction, review.reissueSource?.id] : review?.candidate ? [submission, review.candidate] : submission)).digest('hex')
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
  private async run(scope: TaskOwnerScope, generation: number, request: ScheduledCreationRequest, submissionKey: string, controller: AbortController, review?: CreationReview): Promise<ScheduledCreation> {
    const { requestId, expectedRevision, resumeFromProgress, ...submitted } = request
    const proposal = review?.candidate && scheduleInterpretationSchema.parse(review.candidate)
    const retry = review?.continuation === 'review' ? conversationScheduleRetry(submitted.message)
      : review?.continuation === 'restart' ? conversationScheduleRestart(submitted.message)
        : review?.continuation === 'contextual' ? conversationScheduleRestart(submitted.message) ?? conversationScheduleRetry(submitted.message) : undefined
    const clock = retry?.clock ?? (review && (expectedRevision !== undefined || review.continuation === 'contextual') ? conversationScheduleClock(submitted.message) : undefined)
    const actionTime = review?.draftAction?.kind === 'review' ? review.draftAction.time : undefined
    if (review && expectedRevision !== undefined && ((!clock && !retry && !proposal && !review.draftAction) || submitted.referenceFiles)) throw new AppError('INVALID_ARGUMENT')
    const signal = review ? AbortSignal.any([controller.signal, review.signal]) : controller.signal
    const guard = () => { this.assertScope(scope, generation); signal.throwIfAborted() }
    const referenceFiles = resumeFromProgress === 'retry' ? undefined : submitted.referenceFiles
    const prior = referenceFiles ? (await this.options.repository.read(scope)).creations?.find(item => item.id === requestId) : undefined
    guard()
    const message = { role: 'user' as const, content: submitted.message, receivedAt: review?.receivedAt ?? this.now() }
    if (referenceFiles && prior?.submissionKey !== submissionKey && !this.options.attachments) throw new AppError('SERVICE_UNAVAILABLE')
    const referenceMaterials = referenceFiles && prior?.submissionKey !== submissionKey
      ? await this.options.attachments!.referenceMaterials(scope, referenceFiles) : undefined
    const messageWithReferences = referenceMaterials ? { ...message, referenceMaterials } : message
    const sourceIds = review?.contextSources?.map(source => source.id) ?? []
    const sources = review?.contextSources?.map(source => ({ role: 'user' as const, content: source.content, receivedAt: source.receivedAt })) ?? []
    const initialize = (data: ScheduledSnapshot): ScheduledCreation => {
      guard()
      const records = data.creations ??= []
      const existing = records.find(item => item.id === requestId)
      if (existing) {
        if (resumeFromProgress) {
          if (existing.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
          if (scheduledCreationProgressAction(existing) !== resumeFromProgress) throw new AppError('INVALID_STATE')
          if (resumeFromProgress === 'retry') {
            // Replay the checkpoint without adding a duplicate user message or discarding the saved plan input.
            if (JSON.stringify(existing.request) !== JSON.stringify(submitted)) throw new AppError('INVALID_ARGUMENT')
            existing.stage = 'parsing'; existing.error = null; delete existing.confirmationOutcome
            existing.revision++; existing.updatedAt = this.now()
            return existing
          }
        } else if (!!existing.fromConversation !== !!review || existing.conversationId && existing.conversationId !== review?.conversationId) throw new AppError('INVALID_STATE')
        if (existing.submissionKey === submissionKey) return existing
        if (existing.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
        if (existing.deleted || ['completed', 'cancelled'].includes(existing.stage)) throw new AppError('INVALID_STATE', { message: '本次创建已结束，请从任务详情修改配置，或新建任务。' })
        if (review && !awaiting(existing)) {
          throw new AppError('DRAFT_REVISION_CONFLICT')
        }
        if (existing.messages.length >= 20) throw new AppError('INVALID_ARGUMENT', { message: '补充次数已达上限，请重新描述并新建任务。' })
        const input = review ? { ...existing.request, message: submitted.message } : submitted
        Object.assign(existing, { request: input, submissionKey, ...(review?.conversationId ? { conversationId: review.conversationId } : {}),
          ...(review?.turnId ? { conversationTurnId: review.turnId } : {}),
          ...(sourceIds.length ? { contextSourceTurns: [...new Set([...(existing.contextSourceTurns ?? []), ...sourceIds])].slice(-19) } : {}),
          messages: [...existing.messages, messageWithReferences], stage: 'parsing', error: null,
          revision: existing.revision + 1, updatedAt: this.now() })
        return existing
      }
      if (expectedRevision !== undefined) throw new AppError('DRAFT_REVISION_CONFLICT')
      const source = review?.reissueSource
      const reissue = source && records.find(item => item.id === source.id)
      if (source && (!reissue || reissue.revision !== source.revision || !canReissue(reissue, records, review))) throw new AppError('DRAFT_REVISION_CONFLICT')
      const history = reissue ? (reissue.conversationId ? reissue.messages : reissue.messages.slice(0, 1)) : []
      const messages = sources.length ? [...history.filter(old => !sources.some(item => item.receivedAt === old.receivedAt && item.content === old.content)),
        ...sources, messageWithReferences].slice(-20) : reissue ? history : [messageWithReferences]
      const created: ScheduledCreation = { id: requestId, revision: 1, request: reissue?.request ?? submitted, submissionKey,
        ...(review ? { fromConversation: true } : {}),
        ...(review?.conversationId ? { conversationId: review.conversationId } : {}),
        ...(review?.turnId ? { conversationTurnId: review.turnId } : {}),
        ...(sourceIds.length ? { contextSourceTurns: sourceIds } : {}),
        ...(reissue ? { reissuedFrom: reissue.id } : {}),
        referenceNow: reissue?.referenceNow ?? this.now(),
        messages,
        interpretation: reissue?.conversationId ? reissue.interpretation : null, parsedSubmissionKey: null, definitionSubmissionKey: null,
        stage: 'parsing', definitionId: null, definitionInput: null, error: null, createdAt: this.now(), updatedAt: this.now() }
      records.push(created)
      return created
    }
    const before = review?.transient && expectedRevision === undefined && !review.reissueSource && !referenceFiles ? await this.options.repository.read(scope) : undefined
    let transient = !!before && !before.creations?.some(item => item.id === requestId)
    let record = transient ? initialize(before!) : await this.options.repository.update(scope, initialize)
    this.assertScope(scope, generation)
    if (record.deleted || ['completed', 'cancelled', 'needs_input', 'needs_confirmation', 'blocked'].includes(record.stage)) return record
    submissionKey = record.submissionKey
    const input = record.request
    const change = async (mutate: (item: ScheduledCreation) => void) => {
      guard()
      if (transient) { mutate(record); record.revision++; record.updatedAt = this.now(); return }
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
      const stored = scheduleInterpretationSchema.safeParse(record.interpretation)
      const previousDraft = stored.success ? stored.data : null
      const catalog = z.array(employeeSchema).max(1000).parse(await withTimeout(this.options.catalog(), 30000, 'scheduled-creation-catalog'))
      guard()
      const planningEmployee = catalog.find(item => (!input.parserSubscriptionId || item.subscriptionId === input.parserSubscriptionId) && item.allowedModels.includes(input.modelId))
      if (!planningEmployee) throw new AppError('MODEL_NOT_ALLOWED')
      await withTimeout(this.options.authorize(planningEmployee.subscriptionId, input.modelId), 30000, 'scheduled-creation-authorization')
      guard()
      await this.validateWorkspace(input.workDir, 'scheduled-creation-workspace')
      guard()
      if (record.parsedSubmissionKey !== submissionKey || !previousDraft) {
        await change(item => { item.stage = 'parsing'; item.error = null })
        const previous = clock ? previousDraft : null
        const preserve = previousDraft && (review?.reissueSource && (!proposal || clock) || actionTime || retry || review?.draftAction ||
          review && record.confirmationOutcome && previousDraft.questions.length > 0 && previousDraft.questions.every(question => question.field === 'schedule'))
        let parsed = preserve ? (actionTime ? applyConversationScheduleTime(previousDraft, actionTime) ?? timeOnly(previousDraft)
          : clock ? reviseConversationScheduleClock(previousDraft, clock) ?? (review?.reissueSource ? timeOnly(previousDraft) : undefined)
          : proposal?.status === 'ready' && previousDraft.task.schedule.kind === 'once' && proposal.task.schedule.localDateTime
            ? applyConversationScheduleTime(previousDraft, proposal.task.schedule.localDateTime) ?? timeOnly(previousDraft)
            : previousDraft) : (previous && clock ? reviseConversationScheduleClock(previous, clock) : undefined) ?? proposal
        if (!parsed) {
          const timeout = setTimeout(() => controller.abort(), 45000)
          try {
            const result = await withTimeout(this.options.interpret({ subscriptionId: planningEmployee.subscriptionId, modelId: input.modelId,
              ...(record.fromConversation ? { fromConversation: true } : {}),
              referenceNow: record.referenceNow, timezone: input.timezone, employeeCatalog: catalog,
              currentDraft: previousDraft, messages: record.messages }, signal), 45000, 'scheduled-creation-interpretation')
            guard()
            parsed = scheduleInterpretationSchema.parse(result)
          } finally { clearTimeout(timeout) }
          if (review?.reissueSource && parsed.status !== 'blocked') {
            parsed = actionTime ? applyConversationScheduleTime(parsed, actionTime) ?? timeOnly(parsed)
              : clock ? reviseConversationScheduleClock(parsed, clock) ?? timeOnly(parsed) : parsed
          }
          if (previous) {
            parsed.task.title = previous.task.title ?? parsed.task.title
            parsed.task.goal = previous.task.goal ?? parsed.task.goal
            if (previous.task.deliverables.length) parsed.task.deliverables = previous.task.deliverables
            if (!previous.questions.some(item => item.field === 'execution')) parsed.task.execution = previous.task.execution
            parsed.task.schedule.timezone = previous.task.schedule.timezone
            if (previous.task.schedule.kind && parsed.task.schedule.kind !== previous.task.schedule.kind) {
              parsed = { ...previous, status: 'needs_input', reasons: [] }
            }
            if (clock && parsed.status === 'ready') parsed = reviseConversationScheduleClock(parsed, clock) ?? parsed
            parsed = scheduleInterpretationSchema.parse(parsed)
          }
        }
        if (clock && !previousDraft && proposal && review?.continuation === 'contextual' && parsed.status !== 'blocked') {
          parsed = reviseConversationScheduleClock(parsed, clock) ?? parsed
        }
        const candidate = parsed
        await change(item => { item.interpretation = candidate; item.parsedSubmissionKey = submissionKey; item.stage = candidate.status === 'ready' ? 'planning' : candidate.status })
        if (candidate.status !== 'ready') return record
      }
      const candidate = scheduleInterpretationSchema.parse(record.interpretation)
      if (candidate.status === 'ready' && requestsRestrictedWindowsSchedulePath(input.permissions,
        ...(record.fromConversation ? record.messages.map(message => message.content) : [input.message]), candidate.task.goal ?? '', ...candidate.task.deliverables)) {
        await change(item => {
          item.stage = 'blocked'
          item.interpretation = { ...candidate, status: 'blocked', questions: [],
            reasons: [{ code: 'UNSUPPORTED_SETTING', message: scheduledPathDenied.message }] }
        })
        return record
      }
      const execution = candidate.task.execution
      if (execution.mode === 'auto' && !(execution.collaborationRequest && record.messages.some(message => message.content.includes(execution.collaborationRequest!)))) {
        await change(item => {
          item.stage = 'needs_input'; item.error = null
          item.interpretation = { ...candidate, status: 'needs_input', reasons: [], questions: [{ field: 'execution', question: '请确认这项任务是否需要多员工协作或独立复核。' }] }
        })
        return record
      }
      const selected = execution.mode === 'employee' ? catalog.find(item => item.subscriptionId === execution.subscriptionId) : planningEmployee
      if (!selected) throw new AppError('EMPLOYEE_UNAVAILABLE')
      if (!selected.allowedModels.includes(input.modelId)) throw new AppError('MODEL_NOT_ALLOWED')
      if (execution.mode === 'employee' && !record.messages.some(message =>
        [selected.name, selected.subscriptionId].some(value => value && message.content.toLowerCase().includes(value.toLowerCase())))) {
        await change(item => {
          item.stage = 'needs_input'; item.error = null
          item.interpretation = { ...candidate, status: 'needs_input', reasons: [], questions: [{ field: 'execution', question: `如需由「${selected.name}」执行，请在任务描述中明确指定该员工。` }] }
        })
        return record
      }
      let configured: ModelScheduledInput
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
      if (sameSubmission && definition) {
        const savedInput = record.definitionInput!
        if (savedInput.mode === 'empty-text') throw new AppError('INVALID_STATE', { message: retiredScheduledExecutionMessage })
        configured = savedInput
      }
      if (configured.recurrence?.frequency === 'cron' && configured.scheduledAt <= this.now() && !definition) {
        configured = { ...configured, scheduledAt: cronPreview(configured.recurrence.expression, configured.timezone, this.now(), 1)[0]! }
      }
      const definitionId = occurrenceId(`definition:${requestId}`, 0)
      if (review) {
        if (record.conversationId && !transient) await change(item => { item.stage = 'needs_confirmation'; item.confirmationOutcome = 'pending' })
        const approved = await review.approve(configured)
        guard()
        if (approved === 'revise_time') {
          await change(item => {
            item.stage = 'needs_input'
            if (item.conversationId) item.confirmationOutcome = 'dismissed'
            item.interpretation = { ...candidate, status: 'needs_input', questions: [{ field: 'schedule', question: '定时任务尚未启用。请直接回复新的执行时间，例如「改成早上 10 点」。' }] }
          })
          return record
        }
        if (approved === 'timeout' || approved === 'dismissed' || approved === 'interrupted') {
          await change(item => { item.stage = 'needs_confirmation'; item.confirmationOutcome = approved })
          return record
        }
        if (approved !== true) {
          await change(item => { item.stage = 'cancelled' })
          return record
        }
      }
      if (transient) {
        // Persist only after this exact proposal was approved. Until then, scope and lifetime are the active turn.
        if (configured.recurrence?.frequency === 'once' && configured.scheduledAt <= this.now()) {
          await change(item => { item.stage = 'needs_input'; item.interpretation = timeOnly(candidate) })
          return record
        }
        if (configured.recurrence?.frequency === 'cron' && configured.scheduledAt <= this.now()) {
          configured = { ...configured, scheduledAt: cronPreview(configured.recurrence.expression, configured.timezone, this.now(), 1)[0]! }
        }
        record = await this.options.repository.update(scope, data => {
          guard()
          const records = data.creations ??= []
          if (records.some(item => item.id === requestId)) throw new AppError('DRAFT_REVISION_CONFLICT')
          records.push(record)
          return record
        })
        transient = false
      }
      const previousInput = record.definitionInput
      await change(item => { item.definitionId = definitionId; item.stage = 'planning'; item.error = null; delete item.confirmationOutcome })
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
      const nodes = configured.mode === 'general' ? [] : definition.plan?.kind === 'arrangement' ? definition.plan.nodes : [{ subscriptionId: configured.subscriptionId, modelId: configured.modelId }]
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
      if (transient) throw error
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
        if (item.stage === 'needs_confirmation' && item.confirmationOutcome === 'pending') item.confirmationOutcome = 'interrupted'
        else { item.stage = 'failed'; item.error = message }
        item.revision++; item.updatedAt = this.now()
        return item
      })
      log.warn('scheduled creation did not complete', { creationId: record.id, scheduledTaskId: record.definitionId, code })
      this.assertScope(scope, generation)
      return record
    }
  }
  async cancel(id: string, revision: number, guard?: () => void): Promise<ScheduledCreation> {
    const scope = this.scope(), generation = this.generation
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope, generation)
      guard?.()
      const item = data.creations?.find(value => value.id === id)
      if (!item) throw new AppError('NOT_FOUND')
      if (item.stage === 'cancelled') return item
      if (item.deleted) throw new AppError('NOT_FOUND')
      if (item.revision !== revision) throw new AppError('DRAFT_REVISION_CONFLICT')
      if (item.stage === 'completed') throw new AppError('INVALID_STATE', { message: '任务已创建，请从任务详情暂停或删除。' })
      item.stage = 'cancelled'; item.error = null; delete item.confirmationOutcome; item.revision++; item.updatedAt = this.now()
      return item
    })
    this.assertScope(scope, generation)
    this.operations.get(this.key(scope, id))?.controller.abort()
    return result
  }
  async deleteRecord(id: string, revision: number, guard?: () => void): Promise<ScheduledCreation> {
    const scope = this.scope(), generation = this.generation
    const result = await this.options.repository.update(scope, data => {
      this.assertScope(scope, generation)
      guard?.()
      const item = data.creations?.find(value => value.id === id)
      if (!item) throw new AppError('NOT_FOUND')
      if (item.deleted) return item
      if (item.revision !== revision) throw new AppError('DRAFT_REVISION_CONFLICT')
      if (!isScheduledCreationFinished(item.stage)) {
        throw new AppError('INVALID_STATE', { message: '创建尚未结束，请在创建完成或取消后删除记录。' })
      }
      if (item.stage !== 'cancelled' && this.operations.has(this.key(scope, id))) {
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
        if (this.operations.has(this.key(scope, item.id))) continue
        if (item.stage === 'needs_confirmation' && item.confirmationOutcome === 'pending') {
          item.confirmationOutcome = 'interrupted'; item.revision++; item.updatedAt = this.now()
        } else if (isScheduledCreationWorking(item.stage)) {
          item.stage = 'failed'; item.error = '创建过程已中断，已保存进度，请继续创建。'; item.revision++; item.updatedAt = this.now()
        }
      }
    })
    this.assertScope(scope, generation)
  }
  stop(): void { this.generation++; for (const operation of this.operations.values()) operation.controller.abort(); this.operations.clear() }
}
