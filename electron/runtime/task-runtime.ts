/**
 * 任务运行时的统一入口。
 *
 * 本类只负责入队、工作目录锁、运行状态和事件路由；对话上下文由
 * ConversationExecutor 维护，编排节点由 ArrangementExecutor 执行。
 * 这样任务生命周期的公共约束集中在这里，具体执行方式不会反向污染调度逻辑。
 */
import { randomUUID } from 'node:crypto'
import { TaskStatus, type TaskExecutionEvent, type ToolAuthorizationRequest } from '../../src/shared/types'
import { ToolApprovals } from './run-approvals'
import { PiTaskWorker, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import { TaskRunStore, type TaskRunStorePort } from '../data/task-run-store'
import type { TaskManager } from './task-manager'
import { WorkspaceLockManager } from './workspace-lock-manager'
import { ConversationExecutor } from './conversation-executor'
import { RunQueue } from './run-queue'
import { EventPipeline } from './run-events'
import { createRunCompletion, WorkerRegistry } from './run-workers'
import type {
  EmployeeRuntimeConfig,
  QueuedRun,
  SessionRecoveryMode,
  TaskWorkerPort,
  ControlIntent,
} from './run-types'
import { logger } from '../common/logger'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import { ArrangementExecutor } from './arrangement-executor'
import { createArrangementExecutionState, resumeArrangement, retryArrangementNode, stopArrangement, type ArrangementExecutionState } from '../domain/arrangement-execution'
import { shouldPushTaskEvent } from './task-event-visibility'

const log = logger.child('task-runtime')

export interface TaskRuntimeOptions {
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
  workPlanStore?: WorkPlanStorePort
  arrangementCheckpointStore?: ArrangementCheckpointStorePort
}

export class TaskRuntime {
  private readonly taskManager: TaskManager
  private readonly getRefreshToken: () => string
  private readonly onAuthenticationRequired: () => void
  private readonly onEvent: (event: TaskExecutionEvent) => void
  private readonly resolveEmployee: (subscriptionId: string) => EmployeeRuntimeConfig | null
  private readonly authorizeEmployee: (subscriptionId: string) => Promise<EmployeeRuntimeConfig | null>
  private readonly taskRunStore: TaskRunStorePort | null
  private readonly getTaskWorkspaceRoot: () => string
  private readonly workPlanStore: WorkPlanStorePort | null
  private readonly arrangementCheckpointStore: ArrangementCheckpointStorePort | null
  private readonly activeArrangements = new Map<string, { taskId: string; runId: string; subscriptionId: string; executor: ArrangementExecutor; completion: Promise<void>; releaseWorkspace: () => void; control: ControlIntent }>()
  private readonly locks: WorkspaceLockManager
  private readonly approvals: ToolApprovals

  private readonly admission = new RunQueue()
  private pumping = false
  private pumpRequested = false

  private readonly workers = new WorkerRegistry()

  private readonly events: EventPipeline
  private readonly createWorker: (options: PiTaskWorkerOptions) => TaskWorkerPort
  private readonly conversationExecutor: ConversationExecutor

  constructor(options: TaskRuntimeOptions) {
    this.taskManager = options.taskManager
    this.getRefreshToken = options.getRefreshToken
    this.onAuthenticationRequired = options.onAuthenticationRequired
    this.onEvent = options.onEvent
    this.resolveEmployee = options.resolveEmployee
    this.authorizeEmployee = options.authorizeEmployee ?? (async subscriptionId => this.resolveEmployee(subscriptionId))
    this.createWorker = options.createWorker ?? (workerOptions => new PiTaskWorker(workerOptions))
    this.taskRunStore = options.taskRunStore ?? (options.userDataDir ? new TaskRunStore(options.userDataDir) : null)
    this.getTaskWorkspaceRoot = options.getTaskWorkspaceRoot ?? (() => process.cwd())
    this.workPlanStore = options.workPlanStore ?? null
    this.arrangementCheckpointStore = options.arrangementCheckpointStore ?? null
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
    this.conversationExecutor = new ConversationExecutor({
      taskManager: this.taskManager,
      taskRunStore: this.taskRunStore,
      createWorker: this.createWorker,
      getRefreshToken: this.getRefreshToken,
      onAuthenticationRequired: this.onAuthenticationRequired,
      authorizeEmployee: this.authorizeEmployee,
      workspaceRoot: this.getTaskWorkspaceRoot,
      approvals: this.approvals,
      events: this.events,
      workers: this.workers,
      enqueue: queued => this.admission.push(queued),
      requestPump: () => { void this.pump() },
    })
  }

  async executeTask(taskId: string, options: { conversation?: boolean } = {}): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      throw new Error('Terminal tasks cannot be executed.')
    }
    const scope = this.taskManager.getCurrentUserScope()
    const arrangement = scope && this.workPlanStore ? await this.workPlanStore.get(scope, taskId) : null
    if (arrangement && arrangement.mode !== 'conversation') {
      const checkpoint = scope && this.arrangementCheckpointStore
        ? await this.arrangementCheckpointStore.get(scope, taskId)
        : null
      if (checkpoint?.state.status === 'waiting-user') {
        throw new Error('Arrangement is waiting for a failed node retry or stop.')
      }
      if (checkpoint?.state.status === 'interrupted') {
        throw new Error('Arrangement is interrupted. Resume it explicitly before execution.')
      }
      if (checkpoint?.state.status === 'stopped') {
        throw new Error('Stopped arrangements cannot be executed again.')
      }
      const primarySubscriptionId = arrangement.nodes[0]?.subscriptionId ?? task.subscriptionId
      if (!primarySubscriptionId) throw new Error('Select a silicon employee before executing the task.')
      const employee = await this.authorizeEmployee(primarySubscriptionId)
      if (!employee) throw new Error('The selected employee is no longer available.')
      if (task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
      const runId = randomUUID()
      await this.taskManager.admitTask(taskId, runId)
      const admittedTask = await this.taskManager.getTask(taskId)
      if (!admittedTask || admittedTask.activeRunId !== runId) return
      this.admission.push({ taskId, runId, subscriptionId: primarySubscriptionId, employee, prompt: arrangement.goal, conversation: false, arrangement })
      void this.pump()
      return
    }
    const subscriptionId = task.subscriptionId
    if (!subscriptionId) throw new Error('Select a silicon employee before executing the task.')
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
    return this.conversationExecutor.continue(taskId, prompt, recovery)
  }

  async switchConversationEmployee(taskId: string, subscriptionId: string): Promise<void> {
    return this.conversationExecutor.switchEmployee(taskId, subscriptionId)
  }

  async retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string } = {}): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    const scope = this.taskManager.getCurrentUserScope()
    const arrangement = scope && this.workPlanStore ? await this.workPlanStore.get(scope, taskId) : null
    if (arrangement && arrangement.mode !== 'conversation') {
      await this.retryArrangement(task, arrangement, options.nodeId)
      return
    }
    if (task.status !== TaskStatus.FAILED && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.INTERRUPTED) {
      throw new Error('Only terminal or interrupted tasks can be retried.')
    }
    await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    await this.executeTask(taskId, options)
  }

  async stopArrangement(taskId: string, reason?: string): Promise<void> {
    const activeArrangement = this.activeArrangements.get(taskId)
    if (activeArrangement) {
      activeArrangement.control = 'stop'
      await this.enqueueEvent({
        taskId, runId: activeArrangement.runId, subscriptionId: activeArrangement.subscriptionId, sequence: 0,
        type: 'stop_requested', occurredAt: Date.now(), data: reason ? { reason } : null,
      })
      this.approvals.denyRun(activeArrangement.runId)
      await activeArrangement.executor.stop()
      await activeArrangement.completion
      return
    }
    const scope = this.taskManager.getCurrentUserScope()
    if (!scope || !this.workPlanStore || !this.arrangementCheckpointStore) throw new Error('Arrangement storage is unavailable.')
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    const plan = await this.workPlanStore.get(scope, taskId)
    if (!plan || plan.mode === 'conversation') throw new Error('The task is not an arrangement.')
    this.removeQueuedTask(taskId)
    const checkpoint = await this.arrangementCheckpointStore.get(scope, taskId)
    const state = checkpoint?.state ?? createArrangementExecutionState(plan.nodes)
    const stopped = stopArrangement(state)
    await this.saveArrangementCheckpoint(scope, taskId, plan.planHash, null, stopped)
    const latest = await this.taskManager.getTask(taskId)
    if (!latest || latest.status === TaskStatus.COMPLETED || latest.status === TaskStatus.FAILED) return
    if (latest.activeRunId) {
      if (latest.status === TaskStatus.INTERRUPTED) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
      const pending = await this.taskManager.getTask(taskId)
      if (pending?.status !== TaskStatus.PAUSED) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PAUSED, reason)
      await this.taskManager.clearTaskRun(taskId, latest.activeRunId)
      return
    }
    if (latest.status === TaskStatus.INTERRUPTED) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    const current = await this.taskManager.getTask(taskId)
    if (current?.status === TaskStatus.PENDING) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PAUSED, reason)
  }

  private async retryArrangement(
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    plan: NonNullable<Awaited<ReturnType<WorkPlanStorePort['get']>>>,
    nodeId?: string,
  ): Promise<void> {
    const scope = this.taskManager.getCurrentUserScope()
    if (!scope || !this.arrangementCheckpointStore) throw new Error('Arrangement checkpoint storage is unavailable.')
    const checkpoint = await this.arrangementCheckpointStore.get(scope, task.id)
    if (!checkpoint) throw new Error('Arrangement has no recoverable checkpoint.')
    if (checkpoint.state.status === 'stopped' || checkpoint.state.status === 'completed') throw new Error('This arrangement cannot be retried.')
    let nextState: ArrangementExecutionState
    if (nodeId) {
      nextState = retryArrangementNode(checkpoint.state, plan.nodes, nodeId)
      if (nextState === checkpoint.state) throw new Error('The selected node is not waiting for a retry.')
    } else {
      if (checkpoint.state.status !== 'interrupted') throw new Error('A failed arrangement node must be selected for retry.')
      nextState = resumeArrangement(checkpoint.state)
    }
    await this.saveArrangementCheckpoint(scope, task.id, checkpoint.planHash, null, nextState)
    if (task.status !== TaskStatus.PENDING) await this.taskManager.updateTaskStatus(task.id, TaskStatus.PENDING)
    await this.executeTask(task.id, { conversation: false })
  }

  private async saveArrangementCheckpoint(
    scope: NonNullable<ReturnType<TaskManager['getCurrentUserScope']>>,
    taskId: string,
    planHash: string,
    activeRunId: string | null,
    state: ArrangementExecutionState,
  ): Promise<void> {
    if (!this.arrangementCheckpointStore) throw new Error('Arrangement checkpoint storage is unavailable.')
    await this.arrangementCheckpointStore.save(scope, {
      version: 1, taskId, owner: { ...scope }, planHash, activeRunId,
      state: structuredClone(state), updatedAt: Date.now(),
    })
  }

  async pauseTask(taskId: string): Promise<void> {
    const activeArrangement = this.activeArrangements.get(taskId)
    if (activeArrangement) {
      activeArrangement.control = 'pause'
      this.approvals.denyRun(activeArrangement.runId)
      await activeArrangement.executor.abort()
      await activeArrangement.completion
      return
    }
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
    const activeArrangement = this.activeArrangements.get(taskId)
    if (activeArrangement) {
      activeArrangement.control = 'cancel'
      await this.enqueueEvent({
        taskId,
        runId: activeArrangement.runId,
        subscriptionId: activeArrangement.subscriptionId,
        sequence: 0,
        type: 'cancel_requested',
        occurredAt: Date.now(),
        data: null,
      })
      this.approvals.denyRun(activeArrangement.runId)
      await activeArrangement.executor.abort()
      await activeArrangement.completion
      return
    }
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
    const arrangementStops = Array.from(this.activeArrangements.values()).map(async activeArrangement => {
      activeArrangement.control = 'interrupt'
      await this.enqueueEvent({
        taskId: activeArrangement.taskId,
        runId: activeArrangement.runId,
        subscriptionId: activeArrangement.subscriptionId,
        sequence: 0,
        type: 'shutdown_requested',
        occurredAt: Date.now(),
        data: null,
      })
      await activeArrangement.executor.abort()
      await activeArrangement.completion
    })
    await Promise.all([Promise.all(arrangementStops), Promise.all(this.workers.list().map(async active => {
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
    }))])
    await this.conversationExecutor.disposeSessions()
  }

  respondToApproval(response: { requestId: string; approved: boolean; reason?: string }): boolean {
    return this.approvals.respond(response)
  }

  private enqueueEvent(event: TaskExecutionEvent): Promise<void> {
    return this.events.enqueue(event)
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

  private async startRun(
    queued: QueuedRun,
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    releaseWorkspace: () => void,
  ): Promise<void> {
    if (queued.arrangement) {
      await this.startArrangementRun(queued, task, releaseWorkspace)
      return
    }
    await this.conversationExecutor.execute(queued, task, releaseWorkspace)
  }

  private async startArrangementRun(
    queued: QueuedRun,
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    releaseWorkspace: () => void,
  ): Promise<void> {
    const plan = queued.arrangement
    if (!plan) {
      releaseWorkspace()
      return
    }
    const taskId = queued.taskId
    const runId = queued.runId
    const scope = this.taskManager.getCurrentUserScope()
    const completion = createRunCompletion()
    let parentCreated = false
    let arrangement: ArrangementExecutor | null = null
    try {
      if (scope && this.taskRunStore) {
        await this.taskRunStore.create(scope, {
          taskId,
          runId,
          subscriptionId: queued.subscriptionId,
          modelId: queued.employee.modelId,
          runtimeKey: `${queued.subscriptionId}:${queued.employee.modelId}`,
          workspaceDir: task.workDir ?? this.getTaskWorkspaceRoot(),
          prompt: plan.goal,
        })
        parentCreated = true
      }
      arrangement = new ArrangementExecutor({
        scope,
        taskManager: this.taskManager,
        taskRunStore: this.taskRunStore,
        checkpointStore: this.arrangementCheckpointStore,
        createWorker: this.createWorker,
        getRefreshToken: this.getRefreshToken,
        onAuthenticationRequired: this.onAuthenticationRequired,
        onApprovalRequest: request => this.approvals.request(request),
        onEvent: event => this.enqueueEvent(event),
        authorizeEmployee: this.authorizeEmployee,
        workspaceRoot: task.workDir ?? this.getTaskWorkspaceRoot(),
        arrangementSubscriptionId: queued.subscriptionId,
      })
      this.activeArrangements.set(taskId, {
        taskId,
        runId,
        subscriptionId: queued.subscriptionId,
        executor: arrangement,
        completion: completion.promise,
        releaseWorkspace,
        control: 'none',
      })
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.RUNNING)
      const result = await arrangement.execute(plan, taskId, runId)
      await this.events.drain(taskId)
      const activeArrangement = this.activeArrangements.get(taskId)
      const control = activeArrangement?.runId === runId ? activeArrangement.control : 'none'
      const error = result.error
      const outcome = control === 'cancel'
        ? 'cancelled'
        : control === 'interrupt'
          ? 'interrupted'
          : control === 'pause' || control === 'stop'
            ? 'stopped'
            : result.status === 'completed'
              ? 'completed'
              : result.status === 'interrupted'
                ? 'interrupted'
                : result.status === 'stopped' || result.status === 'waiting-user'
                  ? 'stopped'
                  : 'failed'
      if (parentCreated && scope && this.taskRunStore) {
        await this.taskRunStore.finish(scope, taskId, runId, outcome, error)
      }
      if (activeArrangement?.runId === runId) {
        const status = control === 'cancel'
          ? TaskStatus.PENDING
          : control === 'interrupt' || result.status === 'interrupted'
            ? TaskStatus.INTERRUPTED
            : control === 'pause' || control === 'stop' || result.status === 'stopped' || result.status === 'waiting-user'
              ? TaskStatus.PAUSED
              : result.status === 'completed'
                ? TaskStatus.COMPLETED
                : TaskStatus.FAILED
        await this.taskManager.settleTaskRun(taskId, runId, status, error)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (parentCreated && scope && this.taskRunStore) {
        await this.taskRunStore.finish(scope, taskId, runId, 'failed', message).catch(() => undefined)
      }
      await this.taskManager.settleTaskRun(taskId, runId, TaskStatus.FAILED, message).catch(() => undefined)
    } finally {
      this.events.forgetRun(runId)
      if (this.activeArrangements.get(taskId)?.runId === runId) this.activeArrangements.delete(taskId)
      releaseWorkspace()
      await this.taskManager.clearTaskRun(taskId, runId).catch(() => undefined)
      completion.settle()
      void this.pump()
    }
  }

  private async handleWorkerEvent(event: TaskExecutionEvent): Promise<void> {
    const active = this.workers.active(event.taskId)
    const arrangement = this.activeArrangements.get(event.taskId)
    if (active && active.runId !== event.runId) return
    if (!active && !arrangement) return

    const scope = this.taskManager.getCurrentUserScope()
    if (!active && arrangement && event.runId !== arrangement.runId) {
      const nodeRun = scope && this.taskRunStore
        ? await this.taskRunStore.get(scope, event.taskId, event.runId)
        : null
      if (!nodeRun) return
    }
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
        this.events.sideEffectStarted(event.runId, data.toolId, data.toolName, event.occurredAt)
      }
      await this.taskManager.addTaskLog(event.taskId, `Executing tool: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'tool_execution_end') {
      const data = event.data as { toolId?: unknown; toolName?: unknown }
      if (typeof data.toolId === 'string') this.events.sideEffectEnded(event.runId, data.toolId)
      await this.taskManager.addTaskLog(event.taskId, `Tool completed: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'auto_retry_start') {
      await this.taskManager.addTaskLog(event.taskId, 'Automatic retry started.', 'warning')
    }
    if (shouldPushTaskEvent(persistedEvent)) this.onEvent(persistedEvent)
  }

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

}


