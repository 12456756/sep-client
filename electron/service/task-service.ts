/**
 * electron/service/task-service.ts — 任务用例编排
 *
 * 服务层只负责任务用例和授权：不碰 Pi 对象、不发 IPC、不拼文件路径。
 * 执行能力经 `TaskExecutionPort` 端口注入，所以本文件不 import `runtime/` 的实现，
 * 也就不会把 pi SDK 拉进来（B2）。
 *
 * 参数形状由控制层校验；这里负责业务前置条件和错误语义。
 */
import type { ClientTask, ClientTaskMessage, ClientTaskStats, TaskExecutionEvent, TaskReadView } from '../../src/shared/types'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskMetadata, TaskMetadataStore } from '../data/task-metadata-store'
import type { TaskRunRecord, TaskRunStore } from '../data/task-run-store'
import { projectTaskMessages } from '../data/task-messages'
import type { TaskManager } from '../runtime/task-manager'
import type { SessionRecoveryMode } from '../runtime/run-types'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import type { EmployeeAuthorizer } from './employee-authorizer'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { JsonReadDiagnostic } from '../data/atomic-file'
import { describeError } from '../common/redact'
import { TaskCreationGate } from './task-creation-gate'
import { resolveWorkType } from './work-type'
import type { AttachmentRef, InputSnapshotRef } from '../../src/shared/attachment-contracts'
import type { AttachmentService } from './attachment-service'
import type { KnowledgeSelection } from '../../src/shared/knowledge-selection'
import { arrangementInputReplySchema, type ArrangementInputReply } from '../../src/shared/arrangement-input'

/**
 * 服务层用到的执行能力。实现由 `runtime/task-runtime.ts` 提供；
 * 声明成端口可以隔离运行时和 Pi SDK。
 * 词汇（`SessionRecoveryMode` 等）取自 `runtime/run-types.ts`，那是个零依赖的
 * 类型模块，import 它不会把 SDK 拉进来。
 */
export interface TaskExecutionPort {
  executeTask(taskId: string, options?: { conversation?: boolean; knowledge?: KnowledgeSelection }): Promise<void>
  retryTask(taskId: string, options?: { conversation?: boolean; nodeId?: string; inputReply?: ArrangementInputReply }): Promise<void>
  confirmArrangementNodes(taskId: string, nodeIds: string[]): Promise<void>
  continueConversation(
    taskId: string,
    prompt: string,
    recovery?: { mode?: SessionRecoveryMode; confirmed?: boolean; inputSnapshot?: InputSnapshotRef; knowledge?: KnowledgeSelection },
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
  workPlans?: WorkPlanStorePort
  creationGate?: TaskCreationGate
  employees: EmployeeAuthorizer
  /** 惰性取运行时：它必须在异步边界之后才能加载（Electron 33 / undici 边界）。 */
  execution: () => Promise<TaskExecutionPort>
  media?: { archiveIfMedia(taskId: string): Promise<boolean>; isArchived?(taskId: string): Promise<boolean> }
  attachments?: AttachmentService
}

export interface CreateTaskInput {
  title: string
  prompt: string
  workDir?: string | undefined
  subscriptionId: string
  attachmentSessionId?: string
  attachmentRefs?: AttachmentRef[]
  knowledge?: KnowledgeSelection
}

export class TaskService {
  private readonly creationGate: TaskCreationGate

  constructor(private readonly deps: TaskServiceDependencies) {
    this.creationGate = deps.creationGate ?? new TaskCreationGate()
  }

  /**
   * 建任务 + 落一份元数据。`task:create` 与 `conversation:create` 的公共部分
   * 授权必须在建任务之前：建完再发现员工不可用，就留下一个永远跑不起来的任务。
   */
  async create(input: CreateTaskInput, kind: TaskMetadata['kind']): Promise<TaskReadView> {
    const scope = this.scope()
    await this.requireAuthorizedEmployee(input.subscriptionId)
    this.assertScope(scope)
    if (input.attachmentRefs?.length && (!input.attachmentSessionId || !this.deps.attachments)) throw new AppError('INVALID_ARGUMENT', { message: '附件需要有效的导入会话。' })
    const lease = this.creationGate.begin(scope)
    let success = false
    try {
      const task = await this.deps.taskManager.createTask(input.title, input.prompt, input.workDir, input.subscriptionId)
      lease.taskCreated(task.id)
      if (input.attachmentRefs?.length) await this.deps.attachments!.claimTask(input.attachmentSessionId!, task.id, input.attachmentRefs)
      this.assertScope(scope)
      await this.deps.taskMetadataStore.save(scope, {
        version: 1,
        taskId: task.id,
        kind,
        participantSubscriptionIds: [input.subscriptionId],
        currentSubscriptionId: input.subscriptionId,
        createdAt: Date.now(),
        ...(input.knowledge ? { knowledge: structuredClone(input.knowledge) } : {}),
      })
      this.assertScope(scope)
      success = true
      return { ...task, workType: { state: 'resolved', kind } }
    } finally {
      lease.finish(success)
    }
  }

  /** 首次执行。是不是对话任务由元数据决定，而不是由调用方声明。 */
  async execute(taskId: string): Promise<void> {
    const conversation = await this.isConversation(taskId)
    const scope = this.scope()
    const metadata = await this.deps.taskMetadataStore.load(scope, taskId)
    const workPlan = await this.deps.workPlans?.get(scope, taskId)
    this.assertScope(scope)
    try {
      await (await this.deps.execution()).executeTask(taskId, {
        conversation,
        ...(workPlan ? {} : metadata?.knowledge ? { knowledge: structuredClone(metadata.knowledge) } : {}),
      })
    } catch (error) {
      try { await this.deps.taskManager.recordStartFailure?.(taskId, describeError(error)) } catch { /* preserve the original start error */ }
      throw error
    }
  }

  /** 重试。与 execute 一样要先确认任务归属与员工可用性。 */
  async retry(taskId: string, nodeId?: string, inputReply?: ArrangementInputReply): Promise<void> {
    const task = await this.requireTask(taskId)
    const conversation = await this.isConversation(taskId)
    if (inputReply && (!nodeId || conversation || !arrangementInputReplySchema.safeParse(inputReply).success)) throw new AppError('INVALID_ARGUMENT')
    const plan = conversation ? await this.deps.workPlans?.get(this.scope(), taskId) : null
    if (conversation && plan?.conversation?.kind !== 'general') await this.requireAuthorizedEmployee(task.subscriptionId)
    try {
      await (await this.deps.execution()).retryTask(taskId, { conversation, ...(nodeId ? { nodeId } : {}), ...(inputReply ? { inputReply } : {}) })
    } catch (error) {
      try { await this.deps.taskManager.recordStartFailure?.(taskId, describeError(error)) } catch { /* preserve the original retry error */ }
      throw error
    }
  }

  async confirmArrangementNodes(taskId: string, nodeIds: string[]): Promise<void> {
    await this.requireTask(taskId)
    await (await this.deps.execution()).confirmArrangementNodes(taskId, nodeIds)
  }

  async pause(taskId: string): Promise<void> {
    await (await this.deps.execution()).pauseTask(taskId)
  }

  async cancel(taskId: string, reason?: string): Promise<void> {
    await this.requireTask(taskId)
    await (await this.deps.execution()).cancelTask(taskId, reason)
  }

  /** Media records retain receipts; ordinary running-task deletion is guarded inside TaskManager's commit. */
  async delete(taskId: string): Promise<void> {
    const scope = this.scope()
    if (await this.deps.media?.archiveIfMedia(taskId)) {
      this.assertScope(scope)
      this.deps.taskManager.hideTaskRecord(taskId, scope)
      return
    }
    if (!await this.deps.taskManager.deleteTask(taskId)) {
      const task = await this.deps.taskManager.getTask(taskId)
      this.assertScope(scope)
      const message = task?.activeRunId
        ? '任务正在执行，无法删除。'
        : '工作状态已变化，无法删除，请刷新后重试。'
      throw new AppError('INVALID_STATE', { message })
    }
  }

  async updateDetails(taskId: string, input: { title?: string; pinned?: boolean }): Promise<TaskReadView> {
    const scope = this.scope()
    const updated = await this.deps.taskManager.updateTaskDetails(taskId, input)
    this.assertScope(scope)
    const projected = await this.projectTask(scope, updated)
    this.assertScope(scope)
    return projected
  }

  // ── 查询 ────────────────────────────────────────────────────────────────────

  async get(taskId: string): Promise<TaskReadView> {
    return this.stableRead(async scope => this.projectTask(scope, await this.requireTask(taskId)))
  }

  async list(): Promise<TaskReadView[]> {
    return this.stableRead(async scope => {
      const tasks = await this.deps.taskManager.getAllTasks()
      const visible = await Promise.all(tasks.map(async task => ({ task, archived: await this.deps.media?.isArchived?.(task.id) ?? false })))
      return Promise.all(visible.filter(item => !item.archived).map(item => this.projectTask(scope, item.task)))
    })
  }

  async stats(): Promise<ClientTaskStats> {
    return this.deps.taskManager.getTaskStats()
  }

  async prepareDirectorySelection(currentPath?: string): Promise<string> {
    this.scope()
    return this.deps.taskManager.prepareDirectorySelection(currentPath)
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
    const task = await this.requireTask(taskId)
    const scope = this.scope()
    // Admission publishes the queued run ID before the executor creates its record.
    if (!await this.deps.taskRunStore.get(scope, taskId, runId)) {
      if (task.status === 'pending' && task.activeRunId === runId) return []
      throw new AppError('NOT_FOUND', { message: '未找到该执行记录。' })
    }
    return this.deps.taskRunStore.events.getTimeline(scope, taskId, runId)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** 唯一的 scope 取用点，失效清理进行中也在这里被拒（C7）。 */
  private scope(): TaskOwnerScope {
    return requireScope(this.deps.scope)
  }

  private assertScope(expected: TaskOwnerScope): void {
    const current = this.scope()
    if (current.memberId !== expected.memberId || current.enterpriseId !== expected.enterpriseId) {
      throw new AppError('AUTH_REQUIRED')
    }
  }

  private async stableRead<T>(read: (scope: TaskOwnerScope) => Promise<T>): Promise<T> {
    const scope = this.scope()
    for (;;) {
      const version = await this.creationGate.waitForIdle(scope)
      this.assertScope(scope)
      const result = await read(scope)
      this.assertScope(scope)
      if (this.creationGate.isStable(scope, version)) return result
    }
  }

  private async diagnose<T>(read: (() => Promise<JsonReadDiagnostic<T>>) | undefined): Promise<JsonReadDiagnostic<T>> {
    if (!read) return { state: 'unavailable' }
    try {
      return await read()
    } catch {
      return { state: 'unavailable' }
    }
  }

  private async projectTask(scope: TaskOwnerScope, task: ClientTask): Promise<TaskReadView> {
    if (this.creationGate.hasFailed(scope, task.id)) return { ...task, workType: { state: 'unavailable' } }
    const plans = this.deps.workPlans
    const [metadata, plan] = await Promise.all([
      this.diagnose(() => this.deps.taskMetadataStore.diagnose(scope, task.id)),
      this.diagnose(plans?.diagnose ? () => plans.diagnose!(scope, task.id) : undefined),
    ])
    return { ...task, workType: resolveWorkType(metadata, plan, task.prompt) }
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
      throw new AppError('INVALID_ARGUMENT', { details: { reason: 'employee-unavailable' } })
    }
  }

  private async isConversation(taskId: string): Promise<boolean> {
    const metadata = await this.deps.taskMetadataStore.load(this.scope(), taskId)
    return metadata?.kind === 'conversation'
  }
}


