/**
 * electron/service/task-service.ts — 任务用例编排
 *
 * 服务层只负责任务用例和授权：不碰 Pi 对象、不发 IPC、不拼文件路径。
 * 执行能力经 `TaskExecutionPort` 端口注入，所以本文件不 import `runtime/` 的实现，
 * 也就不会把 pi SDK 拉进来（B2）。
 *
 * 参数形状由控制层校验；这里负责业务前置条件和错误语义。
 */
import type { ClientTask, ClientTaskMessage, ClientTaskStats, TaskExecutionEvent } from '../../src/shared/types'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskMetadata, TaskMetadataStore } from '../data/task-metadata-store'
import type { TaskRunRecord, TaskRunStore } from '../data/task-run-store'
import { projectTaskMessages } from '../data/task-messages'
import type { TaskManager } from '../runtime/task-manager'
import type { SessionRecoveryMode } from '../runtime/run-types'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import type { EmployeeAuthorizer } from './employee-authorizer'

/**
 * 服务层用到的执行能力。实现由 `runtime/task-runtime.ts` 提供；
 * 声明成端口可以隔离运行时和 Pi SDK。
 * 词汇（`SessionRecoveryMode` 等）取自 `runtime/run-types.ts`，那是个零依赖的
 * 类型模块，import 它不会把 SDK 拉进来。
 */
export interface TaskExecutionPort {
  executeTask(taskId: string, options?: { conversation?: boolean }): Promise<void>
  retryTask(taskId: string, options?: { conversation?: boolean; nodeId?: string }): Promise<void>
  continueConversation(
    taskId: string,
    prompt: string,
    recovery?: { mode?: SessionRecoveryMode; confirmed?: boolean },
  ): Promise<void>
  switchConversationEmployee(taskId: string, subscriptionId: string): Promise<void>
  pauseTask(taskId: string): Promise<void>
  cancelTask(taskId: string, reason?: string): Promise<void>
  stopArrangement(taskId: string, reason?: string): Promise<void>
}

export interface TaskServiceDependencies {
  scope: ScopeSource
  taskManager: TaskManager
  taskRunStore: TaskRunStore
  taskMetadataStore: TaskMetadataStore
  employees: EmployeeAuthorizer
  /** 惰性取运行时：它必须在异步边界之后才能加载（Electron 33 / undici 边界）。 */
  execution: () => Promise<TaskExecutionPort>
}

export interface CreateTaskInput {
  title: string
  prompt: string
  workDir?: string | undefined
  subscriptionId: string
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDependencies) {}

  /**
   * 建任务 + 落一份元数据。`task:create` 与 `conversation:create` 的公共部分
   * 授权必须在建任务之前：建完再发现员工不可用，就留下一个永远跑不起来的任务。
   */
  async create(input: CreateTaskInput, kind: TaskMetadata['kind']): Promise<ClientTask> {
    await this.requireAuthorizedEmployee(input.subscriptionId)
    const task = await this.deps.taskManager.createTask(
      input.title,
      input.prompt,
      input.workDir,
      input.subscriptionId,
    )
    await this.deps.taskMetadataStore.save(this.scope(), {
      version: 1,
      taskId: task.id,
      kind,
      participantSubscriptionIds: [input.subscriptionId],
      currentSubscriptionId: input.subscriptionId,
      createdAt: Date.now(),
    })
    return task
  }

  /** 首次执行。是不是对话任务由元数据决定，而不是由调用方声明。 */
  async execute(taskId: string): Promise<void> {
    const conversation = await this.isConversation(taskId)
    await (await this.deps.execution()).executeTask(taskId, { conversation })
  }

  /** 重试。与 execute 一样要先确认任务归属与员工可用性。 */
  async retry(taskId: string, nodeId?: string): Promise<void> {
    const task = await this.requireTask(taskId)
    const conversation = await this.isConversation(taskId)
    if (conversation) await this.requireAuthorizedEmployee(task.subscriptionId)
    await (await this.deps.execution()).retryTask(taskId, { conversation, ...(nodeId ? { nodeId } : {}) })
  }

  async pause(taskId: string): Promise<void> {
    await (await this.deps.execution()).pauseTask(taskId)
  }

  async cancel(taskId: string, reason?: string): Promise<void> {
    await this.requireTask(taskId)
    await (await this.deps.execution()).cancelTask(taskId, reason)
  }

  /** 删除。任务正在执行时不允许删（判断在 TaskManager 的 commit 闭包内，C9）。 */
  async delete(taskId: string): Promise<void> {
    if (!await this.deps.taskManager.deleteTask(taskId)) {
      throw new AppError('INVALID_STATE', { message: '任务正在执行，无法删除。' })
    }
  }

  // ── 查询 ────────────────────────────────────────────────────────────────────

  async get(taskId: string): Promise<ClientTask> {
    return this.requireTask(taskId)
  }

  async list(): Promise<ClientTask[]> {
    return this.deps.taskManager.getAllTasks()
  }

  async stats(): Promise<ClientTaskStats> {
    return this.deps.taskManager.getTaskStats()
  }

  async messages(taskId: string): Promise<ClientTaskMessage[]> {
    const task = await this.requireTask(taskId)
    const scope = this.scope()
    return projectTaskMessages({
      listRuns: id => this.deps.taskRunStore.list(scope, id),
      getTimeline: (id, runId) => this.deps.taskRunStore.events.getTimeline(scope, id, runId),
    }, taskId, task.prompt)
  }

  async listRuns(taskId: string): Promise<TaskRunRecord[]> {
    await this.requireTask(taskId)
    return this.deps.taskRunStore.list(this.scope(), taskId)
  }

  async getRun(taskId: string, runId: string): Promise<TaskRunRecord> {
    await this.requireTask(taskId)
    const run = await this.deps.taskRunStore.get(this.scope(), taskId, runId)
    if (!run) throw new AppError('NOT_FOUND', { message: '未找到该执行记录。' })
    return run
  }

  async timeline(taskId: string, runId: string): Promise<TaskExecutionEvent[]> {
    await this.requireTask(taskId)
    const scope = this.scope()
    // 先确认 run 存在，否则"空时间线"与"记录不存在"对用户是同一个结果。
    if (!await this.deps.taskRunStore.get(scope, taskId, runId)) {
      throw new AppError('NOT_FOUND', { message: '未找到该执行记录。' })
    }
    return this.deps.taskRunStore.events.getTimeline(scope, taskId, runId)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** 唯一的 scope 取用点，失效清理进行中也在这里被拒（C7）。 */
  private scope(): TaskOwnerScope {
    return requireScope(this.deps.scope)
  }

  private async requireTask(taskId: string): Promise<ClientTask> {
    const task = await this.deps.taskManager.getTask(taskId)
    if (!task) throw new AppError('NOT_FOUND', { message: '未找到该任务。' })
    return task
  }

  /**
   * 员工必须当下可用才放行。授权顺带把技能备好，结果由运行时在入队时复用（C4）。
   * `subscriptionId` 为空说明任务没绑定员工——那是数据问题，同样不能跑。
   *
   * 当前错误码表仍使用 `INVALID_ARGUMENT` 表达无效员工选择；更细的错误码需要独立的
   * 对外协议变更，不能在本服务内悄悄改变。
   */
  private async requireAuthorizedEmployee(subscriptionId: string | null | undefined): Promise<void> {
    if (!subscriptionId || !await this.deps.employees.authorize(subscriptionId)) {
      throw new AppError('INVALID_ARGUMENT')
    }
  }

  private async isConversation(taskId: string): Promise<boolean> {
    const metadata = await this.deps.taskMetadataStore.load(this.scope(), taskId)
    return metadata?.kind === 'conversation'
  }
}


