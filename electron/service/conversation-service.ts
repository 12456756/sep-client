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

export interface ConversationServiceDependencies {
  scope: ScopeSource
  taskManager: TaskManager
  taskMetadataStore: TaskMetadataStore
  employees: EmployeeAuthorizer
  tasks: TaskService
  execution: () => Promise<TaskExecutionPort>
  attachments?: AttachmentService
  workPlans?: WorkPlanStorePort
}

export interface ContinueConversationInput {
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
   * 追加一轮。任务必须已绑定员工且该员工当下可用——排队过的 run 依赖入队时的
   * 那一次授权结果（C4）。
   */
  async continue(input: ContinueConversationInput): Promise<void> {
    const scope = requireScope(this.deps.scope)
    const task = await this.deps.taskManager.getTask(input.taskId)
    if (!task || !task.subscriptionId) {
      throw new AppError('NOT_FOUND', { message: '未找到任务或其硅基员工绑定。' })
    }
    const plan = await this.deps.workPlans?.get(scope, input.taskId)
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
  }

  /**
   * 中途换员工。先让运行时切换并落 run 记录，成功后再更新元数据里的参与者名单；
   * 顺序反过来会在运行时拒绝时留下不一致的元数据。
   */
  async switchEmployee(taskId: string, subscriptionId: string): Promise<void> {
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
}


