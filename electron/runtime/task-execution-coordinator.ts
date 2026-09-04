/**
 * electron/runtime/task-execution-coordinator.ts — 执行编排者（Phase 8）
 *
 * 拆分之后这个文件只做编排：把一次 run 的生命周期串起来，具体机制交给五个协作者。
 *   - `RunQueue`             run-queue.ts       准入队列，按 runId 寻址（C1）
 *   - `WorkerRegistry`       run-workers.ts     在跑的 run + 完成信号（C2、不变式 I1）
 *   - `EventPipeline`        run-events.ts      事件串行化 / drain / 派生状态（C6、I4、I7）
 *   - `WorkspaceLockManager` workspace-lock-manager.ts  工作目录互斥（I2）
 *   - `ToolApprovals`        run-approvals.ts   工具授权与 60s 超时自动拒绝（C5）
 *
 * 共享词汇在 `run-types.ts`（零依赖类型模块）。
 *
 * 8 个公开方法的签名不变：executeTask / continueConversation /
 * switchConversationEmployee / retryTask / pauseTask / cancelTask / stopAll /
 * respondToApproval。协调器自己只保留三样东西：调度循环 `pump()`、一次 run 的
 * 建仓与收尾 `startRun()` / `finalizeRun()`、以及会话上下文的按 scope 缓存。
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TaskStatus, type TaskExecutionEvent, type ToolAuthorizationRequest } from '../../src/shared/types'
import { ToolApprovals } from './run-approvals'
import { createDefaultSharedPiSession, PiTaskWorker, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import { TaskRunStore, type TaskRunStorePort } from '../data/task-run-store'
import type { TaskManager } from './task-manager'
import { WorkspaceLockManager } from './workspace-lock-manager'
import { ConversationContextStore, type ConversationMessage } from '../domain/conversation-context'
import type { SharedPiSession } from '../pi/sdk/pi-shared-session'
import { ConversationRecoveryError } from './conversation-recovery-error'
import { RunQueue } from './run-queue'
import { EventPipeline } from './run-events'
import { createRunCompletion, WorkerRegistry } from './run-workers'
import type {
  ActiveRun,
  EmployeeRuntimeConfig,
  QueuedRun,
  SessionRecoveryMode,
  TaskWorkerPort,
} from './run-types'
import { logger } from '../common/logger'

const log = logger.child('task-execution-coordinator')

export interface TaskExecutionCoordinatorOptions {
  taskManager: TaskManager
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  onEvent: (event: TaskExecutionEvent) => void
  onApprovalRequest: (request: ToolAuthorizationRequest) => void
  resolveEmployee: (subscriptionId: string) => EmployeeRuntimeConfig | null
  authorizeEmployee?: (subscriptionId: string) => Promise<EmployeeRuntimeConfig | null>
  createWorker?: (options: PiTaskWorkerOptions) => TaskWorkerPort
  taskRunStore?: TaskRunStorePort
  userDataDir?: string
  getTaskWorkspaceRoot?: () => string
}

export class TaskExecutionCoordinator {
  private readonly taskManager: TaskManager
  private readonly getRefreshToken: () => string
  private readonly onAuthenticationRequired: () => void
  private readonly onEvent: (event: TaskExecutionEvent) => void
  private readonly resolveEmployee: (subscriptionId: string) => EmployeeRuntimeConfig | null
  private readonly authorizeEmployee: (subscriptionId: string) => Promise<EmployeeRuntimeConfig | null>
  private readonly taskRunStore: TaskRunStorePort | null
  private readonly getTaskWorkspaceRoot: () => string
  private readonly locks: WorkspaceLockManager
  private readonly approvals: ToolApprovals
  /** 准入队列。runId 寻址，没有任何按下标的接口（C1）。 */
  private readonly admission = new RunQueue()
  private pumping = false
  private pumpRequested = false
  /** 在跑的 run 与完成信号（C2 / 不变式 I1）。 */
  private readonly workers = new WorkerRegistry()
  /** 事件串行化 + drain + 派生状态（C6）。 */
  private readonly events: EventPipeline
  private readonly createWorker: (options: PiTaskWorkerOptions) => TaskWorkerPort
  private readonly conversationStores = new Map<string, ConversationContextStore>()
  private readonly conversationAdapters = new Map<string, SharedPiSession>()

  constructor(options: TaskExecutionCoordinatorOptions) {
    this.taskManager = options.taskManager
    this.getRefreshToken = options.getRefreshToken
    this.onAuthenticationRequired = options.onAuthenticationRequired
    this.onEvent = options.onEvent
    this.resolveEmployee = options.resolveEmployee
    this.authorizeEmployee = options.authorizeEmployee ?? (async subscriptionId => this.resolveEmployee(subscriptionId))
    this.createWorker = options.createWorker ?? (workerOptions => new PiTaskWorker(workerOptions))
    this.taskRunStore = options.taskRunStore ?? (options.userDataDir ? new TaskRunStore(options.userDataDir) : null)
    this.getTaskWorkspaceRoot = options.getTaskWorkspaceRoot ?? (() => process.cwd())
    this.locks = new WorkspaceLockManager(this.getTaskWorkspaceRoot())
    this.events = new EventPipeline({ handle: event => this.handleWorkerEvent(event) })
    this.approvals = new ToolApprovals({
      onRequest: async request => {
        await this.enqueueEvent({
          taskId: request.taskId,
          runId: request.runId,
          subscriptionId: request.subscriptionId,
          sequence: 0,
          type: 'approval_requested',
          occurredAt: request.timestamp,
          data: {
            requestId: request.requestId,
            toolName: request.toolName,
            input: request.input,
          },
        })
        options.onApprovalRequest(request)
      },
      onResolved: (request, approved, reason) => this.enqueueEvent({
        taskId: request.taskId,
        runId: request.runId,
        subscriptionId: request.subscriptionId,
        sequence: 0,
        type: 'approval_resolved',
        occurredAt: Date.now(),
        data: { requestId: request.requestId, toolName: request.toolName, approved, reason },
      }),
    })
  }

  async executeTask(taskId: string, options: { conversation?: boolean } = {}): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      throw new Error('Terminal tasks cannot be executed.')
    }
    const subscriptionId = task.subscriptionId
    if (!subscriptionId) throw new Error('Select a silicon employee before executing the task.')
    // C4：授权（含平台往返）在入队前完成一次，结果随队列条目携带。
    const employee = await this.authorizeEmployee(subscriptionId)
    if (!employee) throw new Error('The selected employee is no longer available.')

    if (task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED) {
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    }

    const runId = randomUUID()
    await this.taskManager.admitTask(taskId, runId)
    const admittedTask = await this.taskManager.getTask(taskId)
    if (!admittedTask || admittedTask.activeRunId !== runId) return
    this.admission.push({ taskId, runId, subscriptionId, employee, prompt: task.prompt, conversation: options.conversation === true })
    void this.pump()
  }

  async continueConversation(
    taskId: string,
    prompt: string,
    recovery: { mode?: SessionRecoveryMode; confirmed?: boolean } = {},
  ): Promise<void> {
    return this.continueConversationAs(taskId, prompt, undefined, recovery)
  }

  async switchConversationEmployee(taskId: string, subscriptionId: string): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (!await this.authorizeEmployee(subscriptionId)) throw new Error('The selected employee is no longer available.')
    await this.taskManager.setTaskEmployee(taskId, subscriptionId)
    const scope = this.taskManager.getCurrentUserScope()
    if (scope) await this.conversationAdapter(scope, taskId).reset()
  }

  private async continueConversationAs(
    taskId: string,
    prompt: string,
    employeeOverride?: string,
    recovery: { mode?: SessionRecoveryMode; confirmed?: boolean } = {},
  ): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (!prompt.trim()) throw new Error('A message is required.')
    const employeeId = employeeOverride ?? task.subscriptionId
    if (!employeeId) throw new Error('The selected employee is no longer available.')
    // C4：与 executeTask 一致，授权在入队前完成一次。
    const employee = await this.authorizeEmployee(employeeId)
    if (!employee) throw new Error('The selected employee is no longer available.')
    const scope = this.taskManager.getCurrentUserScope()
    if (!scope || !this.taskRunStore) throw new Error('Conversation storage is unavailable.')
    const contextStore = this.conversationStore(scope, taskId)
    const sharedSession = await contextStore.getSharedSession()
    if (!sharedSession?.sessionFile) throw new Error('No resumable Pi session is available for this conversation.')
    let resumeSessionFile: string | undefined = sharedSession.sessionFile
    let degradedRecovery: { originalSessionFile: string; mode: SessionRecoveryMode } | undefined
    let workerPrompt: string | undefined
    if (!await this.isReadableSessionFile(sharedSession.sessionFile)) {
      const mode = recovery.mode ?? 'confirm_rebuild'
      if (mode === 'strict') throw new ConversationRecoveryError('SESSION_UNRECOVERABLE', 'The Pi session file cannot be read.')
      if (mode === 'confirm_rebuild' && recovery.confirmed !== true) {
        throw new ConversationRecoveryError('RECOVERY_CONFIRMATION_REQUIRED', 'Confirm rebuilding the damaged Pi session from task history.')
      }
      degradedRecovery = { originalSessionFile: sharedSession.sessionFile, mode }
      workerPrompt = this.buildRecoveryPrompt(await contextStore.listMessages(), prompt.trim())
      resumeSessionFile = undefined
      await this.replaceConversationAdapter(scope, taskId)
    }
    if (task.status !== TaskStatus.PENDING) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    if (employeeId !== task.subscriptionId) {
      await this.taskManager.setTaskEmployee(taskId, employeeId)
      await this.conversationAdapter(scope, taskId).reset()
    }
    const runId = randomUUID()
    await this.taskManager.admitTask(taskId, runId)
    const admittedTask = await this.taskManager.getTask(taskId)
    if (!admittedTask || admittedTask.activeRunId !== runId) return
    this.admission.push({ taskId, runId, subscriptionId: employeeId, employee, prompt: prompt.trim(), conversation: true, resumeSessionFile, workerPrompt, degradedRecovery })
    void this.pump()
  }

  async retryTask(taskId: string, options: { conversation?: boolean } = {}): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (task.status !== TaskStatus.FAILED && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.INTERRUPTED) {
      throw new Error('Only terminal or interrupted tasks can be retried.')
    }
    await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    await this.executeTask(taskId, options)
  }

  async pauseTask(taskId: string): Promise<void> {
    const active = this.workers.active(taskId)
    if (!active) {
      this.removeQueuedTask(taskId)
      const task = await this.taskManager.getTask(taskId)
      if (task?.status === TaskStatus.PENDING && task.activeRunId) {
        await this.taskManager.pauseTask(taskId)
        await this.taskManager.clearTaskRun(taskId, task.activeRunId)
      }
      return
    }
    active.control = 'pause'
    this.approvals.denyRun(active.runId)
    await active.worker.abort()
    await active.completion
  }

  async cancelTask(taskId: string): Promise<void> {
    const active = this.workers.active(taskId)
    if (!active) {
      this.removeQueuedTask(taskId)
      const task = await this.taskManager.getTask(taskId)
      if (task?.activeRunId && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) {
        await this.taskManager.settleTaskRun(taskId, task.activeRunId, TaskStatus.PENDING)
        await this.taskManager.addTaskLog(taskId, 'Queued conversation run cancelled.', 'warning')
      }
      return
    }
    active.control = 'cancel'
    await this.enqueueEvent({
      taskId,
      runId: active.runId,
      subscriptionId: active.subscriptionId,
      sequence: 0,
      type: 'cancel_requested',
      occurredAt: Date.now(),
      data: null,
    })
    this.approvals.denyRun(active.runId)
    await active.worker.abort()
    await active.completion
  }

  async stopAll(): Promise<void> {
    this.approvals.denyAll()
    await Promise.all(this.workers.list().map(async active => {
      active.control = 'interrupt'
      await this.enqueueEvent({
        taskId: active.taskId,
        runId: active.runId,
        subscriptionId: active.subscriptionId,
        sequence: 0,
        type: 'shutdown_requested',
        occurredAt: Date.now(),
        data: null,
      })
      await active.worker.abort()
      await active.completion
    }))
    await Promise.all(Array.from(this.conversationAdapters.values()).map(adapter => adapter.dispose()))
    this.conversationAdapters.clear()
  }

  respondToApproval(response: { requestId: string; approved: boolean; reason?: string }): boolean {
    return this.approvals.respond(response)
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpRequested = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpRequested = false
        // 对队列快照迭代，条目一律按 runId 寻址（C1）：本轮的两个挂起点
        // （getTask 与工作区加锁）期间 pauseTask / cancelTask 会同步移除队列
        // 条目，按下标操作会删掉别的条目。`take()` 返回 false 就说明该条目
        // 已被别人取走，直接跳过。
        for (const snapshot of this.admission.snapshot()) {
          const queued = this.admission.find(snapshot.runId)
          if (!queued) continue
          const task = await this.taskManager.getTask(queued.taskId)
          if (!task || task.activeRunId !== queued.runId) {
            if (this.admission.take(queued.runId)) {
              log.warn('dropped queued run', {
                taskId: queued.taskId,
                runId: queued.runId,
                reason: task ? 'run_no_longer_admitted' : 'task_missing',
              })
            }
            continue
          }
          // C4：调度循环内禁止任何网络调用。授权已在入队前完成，配置随条目携带；
          // 这里只用同步快照做一次存活性检查——一次慢的平台请求不该拖住全局准入。
          if (!this.resolveEmployee(queued.subscriptionId)) {
            if (!this.admission.take(queued.runId)) continue
            log.warn('dropped queued run', {
              taskId: queued.taskId,
              runId: queued.runId,
              reason: 'employee_unavailable',
            })
            await this.taskManager.updateTaskStatus(queued.taskId, TaskStatus.FAILED, 'Selected employee is unavailable.')
            await this.taskManager.clearTaskRun(queued.taskId, queued.runId)
            continue
          }
          const releaseWorkspace = this.locks.acquire(queued.runId, task.workDir)
          if (!releaseWorkspace) continue
          if (!this.admission.take(queued.runId)) {
            releaseWorkspace()
            continue
          }
          void this.startRun(queued, task, releaseWorkspace)
        }
      } while (this.pumpRequested)
    } finally {
      this.pumping = false
    }
  }

  private async isReadableSessionFile(file: string): Promise<boolean> {
    try {
      const content = await readFile(file, 'utf8')
      const lines = content.split(/\r?\n/).filter(line => line.trim())
      if (lines.length === 0) return false
      for (const line of lines) JSON.parse(line)
      return true
    } catch {
      return false
    }
  }

  private buildRecoveryPrompt(messages: ConversationMessage[], prompt: string): string {
    const transcript = messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${message.content}`)
      .join('\n\n')
    return [
      'The previous Pi session file is unavailable. Continue from the complete persisted conversation transcript below.',
      'The transcript contains messages only. Do not infer, repeat, or replay any tool operation from it.',
      transcript,
      `NEW USER MESSAGE:\n${prompt}`,
    ].filter(Boolean).join('\n\n')
  }

  private async startRun(
    queued: QueuedRun,
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    releaseWorkspace: () => void,
  ): Promise<void> {
    const taskId = queued.taskId
    const runId = queued.runId
    const subscriptionId = queued.subscriptionId
    const employee = queued.employee
    const scope = this.taskManager.getCurrentUserScope()
    // C2：锁的获取与释放必须在同一个词法块内。getPaths 会对非法 taskId/runId 抛
    // TaskScopeError，createWorker 构造 PiTaskWorker 也可能抛；这些步骤此前在 try 之外，
    // 一抛就再也走不到 finally，该工作目录被永久锁死且没有任何日志。
    let worker: TaskWorkerPort | null = null
    let active: ActiveRun | null = null
    // C2：完成信号必须在建仓之前就建好，否则建仓抛出时 finally 里没有可调用的 settle，
    // 等 completion 的 pauseTask / cancelTask / stopAll 会永远等下去。
    const completion = createRunCompletion()
    let runCreated = false
    try {
      const runPaths = scope && this.taskRunStore
        ? this.taskRunStore.getPaths(scope, taskId, runId)
        : null
      const conversationPaths = queued.conversation && scope && this.taskRunStore
        ? this.taskRunStore.getConversationSessionPaths(scope, taskId)
        : null
      worker = this.createWorker({
        context: {
          taskId,
          runId,
          subscriptionId,
          modelId: employee.modelId,
          gatewayUrl: employee.gatewayUrl,
          workspaceDir: task.workDir ?? this.getTaskWorkspaceRoot(),
          agentDir: conversationPaths?.agentDir ?? runPaths?.agentDir ?? `${this.getTaskWorkspaceRoot()}/.pi-runs/${runId}`,
          sessionDir: conversationPaths?.sessionDir ?? runPaths?.sessionDir ?? `${this.getTaskWorkspaceRoot()}/.pi-sessions/${runId}`,
          resumeSessionFile: queued.resumeSessionFile,
          additionalSkillPaths: employee.additionalSkillPaths,
        },
        getRefreshToken: this.getRefreshToken,
        onAuthenticationRequired: this.onAuthenticationRequired,
        onApprovalRequest: request => this.approvals.request(request),
        onEvent: event => this.enqueueEvent(event),
        onSessionCreated: async session => {
          if (scope && this.taskRunStore) {
            await this.taskRunStore.setSession(scope, taskId, runId, session)
            if (queued.conversation) await this.conversationStore(scope, taskId).setSharedSession({
              sessionId: session.sessionId,
              sessionFile: session.sessionFile,
              lastRunId: runId,
              updatedAt: Date.now(),
            })
          }
        },
        sessionAdapter: queued.conversation && scope ? this.conversationAdapter(scope, taskId) : undefined,
      })
      active = { taskId, runId, subscriptionId, releaseWorkspace, worker, control: 'none', completion: completion.promise }
      this.workers.register(active)

      if (scope && this.taskRunStore) {
        await this.taskRunStore.create(scope, {
          taskId,
          runId,
          subscriptionId,
          modelId: employee.modelId,
          runtimeKey: `${subscriptionId}:${employee.modelId}`,
          workspaceDir: task.workDir ?? this.getTaskWorkspaceRoot(),
          prompt: queued.prompt,
        })
        runCreated = true
        if (queued.conversation) {
          await this.conversationStore(scope, taskId).appendMessage(
            this.userMessage(taskId, runId, subscriptionId, employee.modelId, queued.prompt),
          )
        }
        if (queued.degradedRecovery) {
          await this.enqueueEvent({
            taskId,
            runId,
            subscriptionId,
            sequence: 0,
            type: 'recovery_started',
            occurredAt: Date.now(),
            data: { ...queued.degradedRecovery, degradedRecovery: true, replayedTools: false },
          })
        }
      }
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.RUNNING)
      await worker.run(queued.workerPrompt ?? queued.prompt)
      await this.events.drain(taskId)
      if (!this.workers.isCurrent(active)) return
      await this.finalizeRun(active, queued, scope, runCreated)
      return
    } catch (error) {
      log.error('run failed', {
        taskId,
        runId,
        subscriptionId,
        modelId: employee.modelId,
        control: active?.control ?? 'none',
        stage: active ? 'run' : 'setup',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error as unknown),
      })
      if (active) {
        await this.finalizeRun(active, queued, scope, runCreated, error)
      } else {
        // 建仓阶段就失败：既没有 worker 也没有 run 记录，只把任务本身结算掉。
        await this.taskManager
          .settleTaskRun(taskId, runId, TaskStatus.FAILED, 'The run could not be started.')
          .catch(() => undefined)
      }
    } finally {
      this.events.forgetRun(runId)
      if (worker) await worker.dispose().catch(() => undefined)
      releaseWorkspace()
      if (active) this.workers.forget(active)
      const currentTask = await this.taskManager.getTask(taskId).catch(() => null)
      if (currentTask?.activeRunId === runId) await this.taskManager.clearTaskRun(taskId, runId).catch(() => undefined)
      completion.settle()
      void this.pump()
    }
  }

  /**
   * 事件入列。串行化、错误上报、排空全在 `EventPipeline` 里（C6）——协调器只是把
   * 自己造的事件和 worker 报上来的事件汇到同一个入口。
   */
  private enqueueEvent(event: TaskExecutionEvent): Promise<void> {
    return this.events.enqueue(event)
  }

  private async finalizeRun(
    active: ActiveRun,
    queued: QueuedRun,
    scope: { memberId: string; enterpriseId: string } | null,
    runCreated: boolean,
    failure?: unknown,
  ): Promise<void> {
    const employee = queued.employee
    const outcome = active.control === 'cancel'
      ? 'cancelled'
      : active.control === 'interrupt'
        ? 'interrupted'
        : active.control === 'pause'
          ? 'stopped'
          : failure ? 'failed' : 'completed'
    const error = failure instanceof Error ? failure.message : failure ? String(failure) : undefined
    if (active.control !== 'none' || failure) {
      // I7：每个还没收到 tool_execution_end 的副作用调用都必须留下一条
      // SIDE_EFFECT_UNKNOWN，否则下次启动无法判定副作用是否已经发生。
      for (const [toolId, tool] of this.events.pendingSideEffects(active.runId)) {
        await this.enqueueEvent({
          taskId: active.taskId,
          runId: active.runId,
          subscriptionId: active.subscriptionId,
          sequence: 0,
          type: 'SIDE_EFFECT_UNKNOWN',
          occurredAt: Date.now(),
          data: { toolId, toolName: tool.toolName, startedAt: tool.startedAt, replayAllowed: false },
        })
      }
    }
    if (runCreated) {
      if (queued.degradedRecovery) {
        await this.enqueueEvent({
          taskId: active.taskId,
          runId: active.runId,
          subscriptionId: active.subscriptionId,
          sequence: 0,
          type: outcome === 'completed' ? 'recovery_finished' : 'recovery_failed',
          occurredAt: Date.now(),
          data: { degradedRecovery: true, replayedTools: false, error },
        })
      }
      await this.enqueueEvent({
        taskId: active.taskId,
        runId: active.runId,
        subscriptionId: active.subscriptionId,
        sequence: 0,
        type: `run_${outcome}`,
        occurredAt: Date.now(),
        data: error ? { error } : null,
      })
    }
    const response = this.events.takeResponse(active.runId)
    if (response && scope && queued.conversation) {
      await this.conversationStore(scope, active.taskId).appendMessage({
        id: `${active.runId}-assistant`, taskId: active.taskId, turnId: active.runId, runId: active.runId,
        subscriptionId: active.subscriptionId, modelId: employee.modelId, role: 'assistant', content: response, createdAt: Date.now(),
      })
    }
    if (runCreated && scope && this.taskRunStore) {
      await this.taskRunStore.finish(scope, active.taskId, active.runId, outcome, error)
    }
    if (this.workers.isCurrent(active)) {
      const nextStatus = active.control === 'interrupt'
        ? TaskStatus.INTERRUPTED
        : active.control === 'pause'
          ? TaskStatus.PAUSED
          : failure && active.control !== 'cancel'
            ? TaskStatus.FAILED
            : queued.conversation ? TaskStatus.PENDING : TaskStatus.COMPLETED
      await this.taskManager.settleTaskRun(active.taskId, active.runId, nextStatus, error)
    }
  }

  private async handleWorkerEvent(event: TaskExecutionEvent): Promise<void> {
    const active = this.workers.active(event.taskId)
    if (!active || active.runId !== event.runId) return

    const scope = this.taskManager.getCurrentUserScope()
    const persistedEvent = scope && this.taskRunStore
      ? await this.taskRunStore.events.appendEvent(scope, event)
      : event

    if (persistedEvent.type === 'text_delta') {
      const data = persistedEvent.data as { text?: unknown }
      if (typeof data.text === 'string') this.events.appendResponse(persistedEvent.runId, data.text)
    }

    if (event.type === 'approval_requested') {
      await this.taskManager.updateTaskStatus(event.taskId, TaskStatus.WAITING_APPROVAL)
    } else if (event.type === 'approval_resolved') {
      await this.taskManager.updateTaskStatus(event.taskId, TaskStatus.RUNNING)
    } else if (event.type === 'tool_execution_start') {
      const data = event.data as { toolId?: unknown; toolName?: unknown }
      if (typeof data.toolId === 'string' && typeof data.toolName === 'string') {
        // 是不是副作用工具由 EventPipeline 判定——hasSideEffects 只有一个调用点。
        this.events.sideEffectStarted(event.runId, data.toolId, data.toolName, event.occurredAt)
      }
      await this.taskManager.addTaskLog(event.taskId, `执行工具: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'tool_execution_end') {
      const data = event.data as { toolId?: unknown; toolName?: unknown }
      if (typeof data.toolId === 'string') this.events.sideEffectEnded(event.runId, data.toolId)
      await this.taskManager.addTaskLog(event.taskId, `工具执行完成: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'auto_retry_start') {
      await this.taskManager.addTaskLog(event.taskId, 'Automatic retry started.', 'warning')
    }
    this.onEvent(persistedEvent)
  }

  private conversationStore(scope: { memberId: string; enterpriseId: string }, taskId: string): ConversationContextStore {
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    let store = this.conversationStores.get(key)
    if (!store && this.taskRunStore) {
      store = new ConversationContextStore(this.taskRunStore.getTaskDir(scope, taskId))
      this.conversationStores.set(key, store)
    }
    if (!store) throw new Error('Conversation storage is unavailable.')
    return store
  }

  private userMessage(taskId: string, runId: string, subscriptionId: string, modelId: string, content: string): ConversationMessage {
    return { id: `${runId}-user`, taskId, turnId: runId, runId, subscriptionId, modelId, role: 'user', content, createdAt: Date.now() }
  }

  /** 移除某个 task 的全部排队条目，逐条按 runId 取出（C1）。返回被移除的 runId。 */
  private removeQueuedTask(taskId: string): string[] {
    const removed = this.admission.runIdsFor(taskId).filter(runId => this.admission.take(runId))
    if (removed.length > 0) {
      log.warn('dropped queued run', {
        taskId,
        runId: removed.join(','),
        reason: 'task_paused_or_cancelled',
      })
    }
    return removed
  }

  private conversationAdapter(scope: { memberId: string; enterpriseId: string }, taskId: string): SharedPiSession {
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    let adapter = this.conversationAdapters.get(key)
    if (!adapter) {
      adapter = createDefaultSharedPiSession()
      this.conversationAdapters.set(key, adapter)
    }
    return adapter
  }

  private async replaceConversationAdapter(
    scope: { memberId: string; enterpriseId: string },
    taskId: string,
  ): Promise<void> {
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    const adapter = this.conversationAdapters.get(key)
    if (adapter) await adapter.dispose()
    this.conversationAdapters.delete(key)
  }
}
