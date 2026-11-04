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
import type { ConversationQueueView } from '../../src/shared/conversation-queue'

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
   * 中途换员工。先让运行时切换并落 run 记录，成功后再更新元数据里的参与者名单；
   * 顺序反过来会在运行时拒绝时留下不一致的元数据。
   */
  async switchEmployee(taskId: string, subscriptionId: string): Promise<void> {
    if (this.deps.queue) return this.deps.queue.whenIdle(taskId, () => this.switchEmployeeNow(taskId, subscriptionId))
    return this.switchEmployeeNow(taskId, subscriptionId)
  }

  private async switchEmployeeNow(taskId: string, subscriptionId: string): Promise<void> {
    if ((await this.deps.taskManager.getTask(taskId))?.scheduledOrigin) throw new AppError('INVALID_STATE', { message: '定时执行不能中途更换员工，请修改任务配置。' })
    const plan = await this.deps.workPlans?.get(requireScope(this.deps.scope), taskId)
    if (plan?.conversation?.kind === 'general') throw new AppError('INVALID_STATE', { message: '通用助手会话不支持切换员工，请新建员工对话。' })
    if (!await this.deps.employees.authorize(subscriptionId)) {
      throw new AppError('INVALID_ARGUMENT')
    }
    await (await this.deps.execution()).switchConversationEmployee(taskId, subscriptionId)

    const scope = requireScope(this.deps.scope)
    const metadata = await this.deps.taskMetadataStore.load(scope, taskId)
    if (metadata?.kind !== 'conversation') return
    const participantSubscriptionIds = metadata.participantSubscriptionIds.includes(subscriptionId)
      ? [...metadata.participantSubscriptionIds]
      : [...metadata.participantSubscriptionIds, subscriptionId]
    await this.deps.taskMetadataStore.save(scope, {
      ...metadata,
      currentSubscriptionId: subscriptionId,
      participantSubscriptionIds,
    })
  }

  async queue(taskId: string, action: 'get' | 'resume' | 'prioritize', entryId?: string): Promise<ConversationQueueView> {
    if (!this.deps.queue) throw new AppError('INTERNAL_ERROR')
    const scope = requireScope(this.deps.scope)
    const type = (await this.deps.tasks.get(taskId)).workType
    if (type.state !== 'resolved' || type.kind !== 'conversation') throw new AppError('INVALID_ARGUMENT')
    const current = requireScope(this.deps.scope)
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    if (action === 'resume') await this.deps.queue.resume(taskId)
    if (action === 'prioritize') {
      if (!entryId) throw new AppError('INVALID_ARGUMENT')
      await this.deps.queue.prioritize(taskId, entryId)
    }
    return this.deps.queue.view(taskId)
  }
}


