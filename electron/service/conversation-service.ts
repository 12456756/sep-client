/**
 * electron/service/conversation-service.ts — 对话任务用例
 *
 * 对话与普通任务的差别只在两件事上：多轮追加（`continue`）与中途换员工
 * （`switchEmployee`）。建任务的公共部分下沉到 `TaskService.create()`，
 * 这里只保留对话专属用例。
 */
import type { ClientTask } from '../../src/shared/types'
import type { TaskMetadataStore } from '../data/task-metadata-store'
import type { TaskManager } from '../runtime/task-manager'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import type { EmployeeAuthorizer } from './employee-authorizer'
import type { CreateTaskInput, TaskExecutionPort, TaskService } from './task-service'
import type { SessionRecoveryMode } from '../runtime/run-types'
import type { AttachmentRef } from '../../src/shared/attachment-contracts'
import type { AttachmentService } from './attachment-service'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { KnowledgeSelection } from '../../src/shared/knowledge-selection'
import type { ConversationQueueService } from './conversation-queue-service'
import { createHash } from 'node:crypto'
import type { ConversationQueueInput, ConversationQueueView } from '../../src/shared/conversation-queue'
import type { WorkPlan } from '../domain/arrangement-plan'

export interface ConversationServiceDependencies {
  scope: ScopeSource
  taskManager: TaskManager
  taskMetadataStore: TaskMetadataStore
  employees: EmployeeAuthorizer
  tasks: TaskService
  execution: () => Promise<TaskExecutionPort>
  attachments?: AttachmentService
  workPlans?: WorkPlanStorePort
  queue?: ConversationQueueService
}

export interface ContinueConversationInput {
  messageId?: string
  taskId: string
  prompt: string
  recoveryMode?: SessionRecoveryMode | undefined
  confirmRecovery?: boolean | undefined
  attachmentSessionId?: string
  attachmentRefs?: AttachmentRef[]
  knowledge?: KnowledgeSelection
}

type ConversationHandoffTarget = string | { kind: 'general'; modelId: string }

export class ConversationService {
  constructor(private readonly deps: ConversationServiceDependencies) {}

  /** 新建对话任务。与 `task:create` 共用同一个方法，两个 channel 只是薄入口。 */
  async create(input: CreateTaskInput): Promise<ClientTask> {
    return this.deps.tasks.create(input, 'conversation')
  }

  /**
   * 先持久化本轮输入；真正执行时再次授权，避免等待期间授权发生变化。
   */
  async continue(input: ContinueConversationInput): Promise<{ queued: boolean }> {
    const scope = requireScope(this.deps.scope)
    const task = await this.deps.taskManager.getTask(input.taskId)
    if (!task || !task.subscriptionId) {
      throw new AppError('NOT_FOUND', { message: '未找到任务或其硅基员工绑定。' })
    }
    if (task.scheduledOrigin) throw new AppError('INVALID_STATE', { message: '定时执行记录不能追加对话，请在定时任务中处理。' })
    const plan = await this.deps.workPlans?.get(scope, input.taskId)
    if (plan && plan.mode !== 'conversation') throw new AppError('INVALID_ARGUMENT')
    if (this.deps.queue) {
      if (!input.messageId) throw new AppError('INVALID_ARGUMENT')
      const type = (await this.deps.tasks.get(input.taskId)).workType
      if (type.state !== 'resolved' || type.kind !== 'conversation') throw new AppError('INVALID_ARGUMENT')
      const current = requireScope(this.deps.scope)
      if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
      const requestKey = createHash('sha256').update(JSON.stringify([input.prompt, input.attachmentSessionId, input.attachmentRefs, input.knowledge, input.recoveryMode, input.confirmRecovery])).digest('hex')
      const result = await this.deps.queue.enqueue(input.taskId, { id: input.messageId, prompt: input.prompt, requestKey }, async () => {
        if (plan?.conversation?.kind !== 'general' && !await this.deps.employees.authorize(task.subscriptionId!)) throw new AppError('EMPLOYEE_UNAVAILABLE')
        const current = requireScope(this.deps.scope)
        if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
        let attachmentRefs
        let attachmentNames: string[] = []
        if (input.attachmentRefs?.length) {
          if (!input.attachmentSessionId || !this.deps.attachments) throw new AppError('INVALID_ARGUMENT')
          attachmentNames = (await this.deps.attachments.validateRefs(scope, input.attachmentSessionId, input.attachmentRefs)).map(item => item.displayName)
          attachmentRefs = (await this.deps.attachments.claimTask(input.attachmentSessionId, input.taskId, input.attachmentRefs)).attachments
        }
        return { attachmentRefs, attachmentNames, knowledge: input.knowledge ?? plan?.knowledge ?? { mode: 'none' as const, knowledgeBaseIds: [] }, mode: input.recoveryMode, confirmed: input.confirmRecovery }
      })
      return { queued: result.queued }
    }
    if (plan?.conversation?.kind !== 'general' && !await this.deps.employees.authorize(task.subscriptionId)) {
      throw new AppError('INVALID_ARGUMENT')
    }
    const current = requireScope(this.deps.scope)
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    let inputSnapshot
    if (input.attachmentRefs?.length) {
      if (!input.attachmentSessionId || !this.deps.attachments) throw new AppError('INVALID_ARGUMENT', { message: '附件需要有效的导入会话。' })
      inputSnapshot = await this.deps.attachments.claimTask(input.attachmentSessionId, input.taskId, input.attachmentRefs)
    }
    await (await this.deps.execution()).continueConversation(input.taskId, input.prompt, {
      // 只认三种模式，其余一律按"损坏就先问用户"处理。
      mode: input.recoveryMode === 'strict' || input.recoveryMode === 'auto_rebuild_from_task_history'
        ? input.recoveryMode
        : 'confirm_rebuild',
      confirmed: input.confirmRecovery === true,
      ...(inputSnapshot ? { inputSnapshot } : {}),
      ...(input.knowledge ? { knowledge: input.knowledge } : {}),
    })
    return { queued: false }
  }

  /**
   * 中途换员工。更新执行配置后切换运行时，失败时恢复配置；
   * 成功后再更新元数据里的参与者名单。
   */
  async switchEmployee(taskId: string, target: ConversationHandoffTarget): Promise<WorkPlan | undefined> {
    let updated: WorkPlan | undefined
    const change = async () => { updated = await this.switchEmployeeNow(taskId, target) }
    if (this.deps.queue) await this.deps.queue.whenIdle(taskId, change)
    else await change()
    return updated
  }

  private async switchEmployeeNow(taskId: string, target: ConversationHandoffTarget): Promise<WorkPlan | undefined> {
    const scope = requireScope(this.deps.scope)
    const assertScope = () => {
      const current = requireScope(this.deps.scope)
      if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    }
    const task = await this.deps.taskManager.getTask(taskId)
    if (!task) throw new AppError('NOT_FOUND')
    if (task.scheduledOrigin) throw new AppError('INVALID_STATE', { message: '定时执行不能中途更换员工，请修改任务配置。' })
    if (task.activeRunId || task.status === 'running' || task.status === 'waiting_approval') throw new AppError('INVALID_STATE')
    const plan = await this.deps.workPlans?.get(scope, taskId)
    if (plan && plan.mode !== 'conversation') throw new AppError('INVALID_ARGUMENT')
    const toGeneral = typeof target !== 'string'
    if (toGeneral && !plan) throw new AppError('INVALID_STATE', { message: '未找到可修改的会话配置。' })
    const general = plan?.conversation?.kind === 'general'
    const participants = general ? [] : plan?.conversation?.participants ?? []
    const employee = typeof target !== 'string'
      ? await this.deps.employees.authorizeModel(target.modelId, task.subscriptionId ?? undefined)
      : await this.deps.employees.authorize(target, participants.find(item => item.subscriptionId === target)?.modelId)
    assertScope()
    if (!employee) throw new AppError(toGeneral ? 'MODEL_NOT_ALLOWED' : 'INVALID_ARGUMENT')
    const subscriptionId = employee.subscriptionId
    const conversation = toGeneral ? {
      kind: 'general' as const, modelId: employee.modelId,
      participants: [{ subscriptionId, modelId: employee.modelId }], activeSubscriptionId: subscriptionId,
    } : {
      kind: 'employee' as const,
      participants: [...participants.filter(item => item.subscriptionId !== subscriptionId), { subscriptionId, modelId: employee.modelId }],
      activeSubscriptionId: subscriptionId,
    }
    const updated = plan ? { ...plan, conversation } : undefined
    // Persist the execution mode before publishing the new employee; undo it if runtime rejects the switch.
    if (updated) await this.deps.workPlans!.save(scope, updated)
    try {
      assertScope()
      const execution = await this.deps.execution()
      assertScope()
      await execution.switchConversationEmployee(taskId, subscriptionId)
      assertScope()
    } catch (error) {
      if (updated && plan) await this.deps.workPlans!.save(scope, plan)
      throw error
    }

    const metadata = await this.deps.taskMetadataStore.load(scope, taskId)
    assertScope()
    if (metadata?.kind !== 'conversation') return updated
    const participantSubscriptionIds = metadata.participantSubscriptionIds.includes(subscriptionId)
      ? [...metadata.participantSubscriptionIds]
      : [...metadata.participantSubscriptionIds, subscriptionId]
    await this.deps.taskMetadataStore.save(scope, {
      ...metadata,
      currentSubscriptionId: subscriptionId,
      participantSubscriptionIds,
    })
    return updated
  }

  async switchModel(taskId: string, modelId: string): Promise<WorkPlan> {
    const scope = requireScope(this.deps.scope)
    let updated: WorkPlan | undefined
    const change = async (): Promise<void> => {
      const assertScope = (): void => {
        const current = requireScope(this.deps.scope)
        if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
      }
      assertScope()
      const task = await this.deps.taskManager.getTask(taskId)
      if (!task) throw new AppError('NOT_FOUND')
      if (task.scheduledOrigin) throw new AppError('INVALID_STATE', { message: '定时执行不能中途更换模型，请修改任务配置。' })
      if (task.activeRunId || task.status === 'running' || task.status === 'waiting_approval') {
        throw new AppError('INVALID_STATE', { message: '请等待当前回复结束或终止后再切换模型。' })
      }
      const plan = await this.deps.workPlans?.get(scope, taskId)
      if (!plan || plan.mode !== 'conversation' || !plan.conversation || !this.deps.workPlans) throw new AppError('INVALID_STATE', { message: '未找到可修改的会话配置。' })
      const general = plan.conversation.kind === 'general'
      if (!task.subscriptionId) throw new AppError('INVALID_STATE')
      const authorized = general
        ? await this.deps.employees.authorizeModel(modelId, task.subscriptionId)
        : await this.deps.employees.authorize(task.subscriptionId, modelId)
      assertScope()
      if (!authorized) throw new AppError('MODEL_NOT_ALLOWED')
      const conversation = general
        ? { ...plan.conversation, modelId }
        : { ...plan.conversation, participants: [
          ...plan.conversation.participants.filter(item => item.subscriptionId !== task.subscriptionId),
          { subscriptionId: task.subscriptionId, modelId },
        ] }
      const next = { ...plan, conversation }
      await this.deps.workPlans.save(scope, next)
      assertScope()
      updated = next
    }
    if (this.deps.queue) await this.deps.queue.whenIdle(taskId, change)
    else await change()
    if (!updated) throw new AppError('INTERNAL_ERROR')
    return updated
  }

  async queue(input: ConversationQueueInput): Promise<ConversationQueueView> {
    const { taskId, action } = input
    if (!this.deps.queue) throw new AppError('INTERNAL_ERROR')
    const scope = requireScope(this.deps.scope)
    const type = (await this.deps.tasks.get(taskId)).workType
    if (type.state !== 'resolved' || type.kind !== 'conversation') throw new AppError('INVALID_ARGUMENT')
    const current = requireScope(this.deps.scope)
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    if (action === 'skip') return this.deps.queue.skip(taskId, input.skipToken)
    if (action === 'resume') await this.deps.queue.resume(taskId)
    if (action === 'prioritize') {
      await this.deps.queue.prioritize(taskId, input.entryId)
    }
    if (action === 'recover') await this.deps.queue.resume(taskId, { messageId: input.messageId, confirmed: input.confirmRecovery })
    return this.deps.queue.view(taskId)
  }
}


