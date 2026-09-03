/**
 * electron/service/conversation-service.ts — 对话任务用例
 *
 * 对话与普通任务的差别只在两件事上：多轮追加（`continue`）与中途换员工
 * （`switchEmployee`）。建任务的公共部分下沉到 `TaskService.create()`，
 * 这里只留对话专属的编排（方案 Phase 5）。
 */
import type { ClientTask } from '../../src/shared/types'
import type { TaskMetadataStore } from '../data/task-metadata-store'
import type { TaskManager } from '../runtime/task-manager'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import type { EmployeeAuthorizer } from './employee-authorizer'
import type { CreateTaskInput, SessionRecoveryMode, TaskExecutionPort, TaskService } from './task-service'

export interface ConversationServiceDependencies {
  scope: ScopeSource
  taskManager: TaskManager
  taskMetadataStore: TaskMetadataStore
  employees: EmployeeAuthorizer
  tasks: TaskService
  execution: () => Promise<TaskExecutionPort>
}

export interface ContinueConversationInput {
  taskId: string
  prompt: string
  recoveryMode?: SessionRecoveryMode | undefined
  confirmRecovery?: boolean | undefined
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
    const task = await this.deps.taskManager.getTask(input.taskId)
    if (!task || !task.subscriptionId) {
      throw new AppError('NOT_FOUND', { message: '未找到任务或其硅基员工绑定。' })
    }
    if (!await this.deps.employees.authorize(task.subscriptionId)) {
      throw new AppError('INVALID_ARGUMENT')
    }
    await (await this.deps.execution()).continueConversation(input.taskId, input.prompt, {
      // 只认三种模式，其余一律按"损坏就先问用户"处理。
      mode: input.recoveryMode === 'strict' || input.recoveryMode === 'auto_rebuild_from_task_history'
        ? input.recoveryMode
        : 'confirm_rebuild',
      confirmed: input.confirmRecovery === true,
    })
  }

  /**
   * 中途换员工。先让协调器换（它会校验任务状态并落 run 记录），成功后再更新元数据里的
   * 参与者名单——顺序反过来会在协调器拒绝时留下一份对不上的元数据。
   */
  async switchEmployee(taskId: string, subscriptionId: string): Promise<void> {
    if (!await this.deps.employees.authorize(subscriptionId)) {
      throw new AppError('INVALID_ARGUMENT')
    }
    await (await this.deps.execution()).switchConversationEmployee(taskId, subscriptionId)

    const scope = requireScope(this.deps.scope)
    const metadata = await this.deps.taskMetadataStore.load(scope, taskId)
    if (metadata?.kind !== 'conversation') return
    metadata.currentSubscriptionId = subscriptionId
    if (!metadata.participantSubscriptionIds.includes(subscriptionId)) {
      metadata.participantSubscriptionIds.push(subscriptionId)
    }
    await this.deps.taskMetadataStore.save(scope, metadata)
  }
}
