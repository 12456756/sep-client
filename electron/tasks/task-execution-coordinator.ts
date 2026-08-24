import { randomUUID } from 'node:crypto'
import { TaskStatus, type TaskExecutionEvent } from '../../src/shared/types'
import { ApprovalBroker } from '../pi/approval-broker'
import { PiTaskWorker } from '../pi/pi-task-worker'
import { TaskRunStore, type TaskRunStorePort } from './task-run-store'
import { TaskManager } from './task-manager'
import { WorkspaceLockManager } from './workspace-lock-manager'

export interface EmployeeRuntimeConfig {
  employeeInstanceId: string
  modelId: string
  gatewayUrl: string
}

export interface TaskExecutionCoordinatorOptions {
  taskManager: TaskManager
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  onEvent: (event: TaskExecutionEvent) => void
  onApprovalRequest: (request: Parameters<ApprovalBroker['request']>[0]) => void
  resolveEmployee: (employeeInstanceId: string) => EmployeeRuntimeConfig | null
  taskRunStore?: TaskRunStorePort
  userDataDir?: string
  getTaskWorkspaceRoot?: () => string
}

type ControlIntent = 'none' | 'pause' | 'cancel' | 'interrupt'

interface ActiveRun {
  taskId: string
  runId: string
  employeeInstanceId: string
  releaseWorkspace: () => void
  worker: PiTaskWorker
  control: ControlIntent
  completion: Promise<void>
}

interface QueuedRun { taskId: string; prompt: string; resumeRunId?: string }

export class TaskExecutionCoordinator {
  private readonly taskManager: TaskManager
  private readonly getRefreshToken: () => string
  private readonly onAuthenticationRequired: () => void
  private readonly onEvent: (event: TaskExecutionEvent) => void
  private readonly resolveEmployee: (employeeInstanceId: string) => EmployeeRuntimeConfig | null
  private readonly taskRunStore: TaskRunStorePort | null
  private readonly getTaskWorkspaceRoot: () => string
  private readonly locks = new WorkspaceLockManager()
  private readonly approvalBroker: ApprovalBroker
  private readonly queues = new Map<string, QueuedRun[]>()
  private readonly activeByEmployee = new Map<string, ActiveRun>()
  private readonly activeByTask = new Map<string, ActiveRun>()
  private eventChain: Promise<void> = Promise.resolve()

  constructor(options: TaskExecutionCoordinatorOptions) {
    this.taskManager = options.taskManager
    this.getRefreshToken = options.getRefreshToken
    this.onAuthenticationRequired = options.onAuthenticationRequired
    this.onEvent = options.onEvent
    this.resolveEmployee = options.resolveEmployee
    this.taskRunStore = options.taskRunStore ?? (options.userDataDir ? new TaskRunStore(options.userDataDir) : null)
    this.getTaskWorkspaceRoot = options.getTaskWorkspaceRoot ?? (() => process.cwd())
    this.approvalBroker = new ApprovalBroker({ onRequest: options.onApprovalRequest })
  }

  async executeTask(taskId: string, options: { resumeRunId?: string } = {}): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      throw new Error('Terminal tasks cannot be executed.')
    }
    if (this.activeByTask.has(taskId) || this.isQueued(taskId)) return

    const employeeInstanceId = task.employeeInstanceId
    if (!employeeInstanceId) throw new Error('Select a silicon employee before executing the task.')
    if (!this.resolveEmployee(employeeInstanceId)) throw new Error('The selected employee is no longer available.')

    if (task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED) {
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    }

    const queue = this.queues.get(employeeInstanceId) ?? []
    queue.push({ taskId, prompt: task.prompt, resumeRunId: options.resumeRunId })
    this.queues.set(employeeInstanceId, queue)
    void this.pump(employeeInstanceId)
  }

  async continueConversation(taskId: string, prompt: string): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (!prompt.trim()) throw new Error('A message is required.')
    if (this.activeByTask.has(taskId) || this.isQueued(taskId)) throw new Error('Task is already running.')
    const employeeId = task.employeeInstanceId
    if (!employeeId || !this.resolveEmployee(employeeId)) throw new Error('The selected employee is no longer available.')
    const scope = this.taskManager.getCurrentUserScope()
    const runs = scope && this.taskRunStore ? await this.taskRunStore.list(scope, taskId) : []
    const prior = runs.find(run => Boolean(run.sessionFile) && run.outcome !== 'running')
    if (!prior) throw new Error('No resumable Pi session is available for this conversation.')
    if (task.status !== TaskStatus.PENDING) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    const queue = this.queues.get(employeeId) ?? []
    queue.push({ taskId, prompt: prompt.trim(), resumeRunId: prior.id })
    this.queues.set(employeeId, queue)
    void this.pump(employeeId)
  }

  async retryTask(taskId: string): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (this.activeByTask.has(taskId) || this.isQueued(taskId)) return
    if (task.status !== TaskStatus.FAILED && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.INTERRUPTED) {
      throw new Error('Only terminal or interrupted tasks can be retried.')
    }
    await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    await this.executeTask(taskId)
  }

  async pauseTask(taskId: string): Promise<void> {
    const active = this.activeByTask.get(taskId)
    if (!active) {
      this.removeQueuedTask(taskId)
      const task = await this.taskManager.getTask(taskId)
      if (task?.status === TaskStatus.PENDING) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PAUSED)
      return
    }
    active.control = 'pause'
    this.approvalBroker.denyRun(active.runId)
    await active.worker.abort()
    await active.completion
  }

  async cancelTask(taskId: string): Promise<void> {
    const active = this.activeByTask.get(taskId)
    if (!active) {
      this.removeQueuedTask(taskId)
      const task = await this.taskManager.getTask(taskId)
      if (task && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) {
        await this.taskManager.updateTaskStatus(taskId, TaskStatus.FAILED, '用户取消')
      }
      return
    }
    active.control = 'cancel'
    this.approvalBroker.denyRun(active.runId)
    await active.worker.abort()
    await active.completion
  }

  async stopAll(): Promise<void> {
    this.approvalBroker.denyAll()
    await Promise.all(Array.from(this.activeByTask.values()).map(async active => {
      active.control = 'interrupt'
      await active.worker.abort()
      await active.completion
    }))
  }

  respondToApproval(response: { requestId?: string; approved: boolean; reason?: string }): boolean {
    return this.approvalBroker.respond(response)
  }

  private async pump(employeeInstanceId: string): Promise<void> {
    if (this.activeByEmployee.has(employeeInstanceId)) return
    const queue = this.queues.get(employeeInstanceId)
    const queued = queue?.[0]
    if (!queued) return
    const taskId = queued.taskId

    const task = await this.taskManager.getTask(taskId)
    if (!task) {
      queue?.shift()
      return this.pump(employeeInstanceId)
    }
    const employee = this.resolveEmployee(employeeInstanceId)
    if (!employee) {
      queue?.shift()
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.FAILED, '硅基员工当前不可用')
      return this.pump(employeeInstanceId)
    }

    const runId = randomUUID()
    const releaseWorkspace = this.locks.acquire(runId, task.workDir)
    if (!releaseWorkspace) return

    queue?.shift()
    const scope = this.taskManager.getCurrentUserScope()
    const resumeRunId = queued.resumeRunId
    const priorRun = scope && this.taskRunStore && resumeRunId
      ? await this.taskRunStore.get(scope, taskId, resumeRunId)
      : null
    if (resumeRunId && (!priorRun || !priorRun.sessionFile || priorRun.employeeInstanceId !== employeeInstanceId)) {
      releaseWorkspace()
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.FAILED, '所选运行没有可恢复的 Pi 会话')
      return this.pump(employeeInstanceId)
    }
    const runPaths = scope && this.taskRunStore
      ? this.taskRunStore.getPaths(scope, taskId, runId)
      : null
    const worker = new PiTaskWorker({
      context: {
        taskId,
        runId,
        employeeInstanceId,
        modelId: employee.modelId,
        gatewayUrl: employee.gatewayUrl,
        workspaceDir: task.workDir ?? this.getTaskWorkspaceRoot(),
        agentDir: runPaths?.agentDir ?? `${this.getTaskWorkspaceRoot()}/.pi-runs/${runId}`,
        sessionDir: runPaths?.sessionDir ?? `${this.getTaskWorkspaceRoot()}/.pi-sessions/${runId}`,
        resumeSessionFile: priorRun?.sessionFile ?? undefined,
      },
      getRefreshToken: this.getRefreshToken,
      onAuthenticationRequired: this.onAuthenticationRequired,
      onApprovalRequest: request => this.approvalBroker.request(request),
      onEvent: event => this.enqueueEvent(event),
      onSessionCreated: async session => {
        if (scope && this.taskRunStore) await this.taskRunStore.setSession(scope, taskId, runId, session)
      },
    })
    let resolveCompletion!: () => void
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve })
    const active: ActiveRun = { taskId, runId, employeeInstanceId, releaseWorkspace, worker, control: 'none', completion }
    let runCreated = false

    this.activeByEmployee.set(employeeInstanceId, active)
    this.activeByTask.set(taskId, active)
    try {
      if (scope && this.taskRunStore) {
        await this.taskRunStore.create(scope, {
          taskId,
          runId,
          employeeInstanceId,
          modelId: employee.modelId,
          runtimeKey: `${employeeInstanceId}:${employee.modelId}`,
          workspaceDir: task.workDir ?? this.getTaskWorkspaceRoot(),
          prompt: queued.prompt,
        })
        runCreated = true
      }
      await this.taskManager.setTaskRun(taskId, runId)
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.RUNNING)
      await worker.run(queued.prompt)
      await this.eventChain
      if (this.activeByTask.get(taskId) !== active) return
      if (active.control === 'pause') {
        await this.taskManager.updateTaskStatus(taskId, TaskStatus.PAUSED)
      } else if (active.control === 'interrupt') {
        await this.taskManager.updateTaskStatus(taskId, TaskStatus.INTERRUPTED, '运行被中断')
      } else if (active.control === 'cancel') {
        await this.taskManager.updateTaskStatus(taskId, TaskStatus.FAILED, '用户取消')
      } else {
        await this.taskManager.updateTaskStatus(taskId, TaskStatus.COMPLETED)
      }
      if (runCreated && scope && this.taskRunStore) {
        await this.taskRunStore.finish(scope, taskId, runId, active.control === 'pause' ? 'stopped' : active.control === 'interrupt' ? 'interrupted' : active.control === 'cancel' ? 'cancelled' : 'completed')
      }
    } catch (error) {
      console.error('[TaskExecutionCoordinator] run failed', {
        taskId,
        runId,
        employeeInstanceId,
        modelId: employee.modelId,
        control: active.control,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      if (this.activeByTask.get(taskId) === active) {
        if (active.control === 'pause') {
          await this.taskManager.updateTaskStatus(taskId, TaskStatus.PAUSED)
        } else if (active.control === 'interrupt') {
          await this.taskManager.updateTaskStatus(taskId, TaskStatus.INTERRUPTED, '运行被中断')
        } else if (active.control === 'cancel') {
          await this.taskManager.updateTaskStatus(taskId, TaskStatus.FAILED, '用户取消')
        } else {
          await this.taskManager.updateTaskStatus(
            taskId,
            TaskStatus.FAILED,
            error instanceof Error ? error.message : 'Agent execution failed.',
          )
        }
      }
      if (runCreated && scope && this.taskRunStore) {
        await this.taskRunStore.finish(scope, taskId, runId, active.control === 'pause' ? 'stopped' : active.control === 'interrupt' ? 'interrupted' : active.control === 'cancel' ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'Agent execution failed.')
      }
    } finally {
      await worker.dispose()
      releaseWorkspace()
      if (this.activeByTask.get(taskId) === active) this.activeByTask.delete(taskId)
      if (this.activeByEmployee.get(employeeInstanceId) === active) this.activeByEmployee.delete(employeeInstanceId)
      const currentTask = await this.taskManager.getTask(taskId)
      if (currentTask?.activeRunId === runId) await this.taskManager.clearTaskRun(taskId, runId)
      resolveCompletion()
      void this.pump(employeeInstanceId)
    }
  }

  private enqueueEvent(event: TaskExecutionEvent): Promise<void> {
    const operation = this.eventChain.catch(() => undefined).then(() => this.handleWorkerEvent(event))
    this.eventChain = operation
    return operation
  }

  private async handleWorkerEvent(event: TaskExecutionEvent): Promise<void> {
    const active = this.activeByTask.get(event.taskId)
    if (!active || active.runId !== event.runId) return

    const scope = this.taskManager.getCurrentUserScope()
    if (scope && this.taskRunStore) await this.taskRunStore.appendEvent(scope, event)

    if (event.type === 'approval_requested') {
      await this.taskManager.updateTaskStatus(event.taskId, TaskStatus.WAITING_APPROVAL)
    } else if (event.type === 'approval_resolved') {
      await this.taskManager.updateTaskStatus(event.taskId, TaskStatus.RUNNING)
    } else if (event.type === 'tool_execution_start') {
      const data = event.data as { toolName?: unknown }
      await this.taskManager.addTaskLog(event.taskId, `执行工具: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'tool_execution_end') {
      const data = event.data as { toolName?: unknown }
      await this.taskManager.addTaskLog(event.taskId, `工具执行完成: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'auto_retry_start') {
      await this.taskManager.addTaskLog(event.taskId, '开始自动重试', 'warning')
    }
    this.onEvent(event)
  }

  private isQueued(taskId: string): boolean {
    return Array.from(this.queues.values()).some(queue => queue.some(item => item.taskId === taskId))
  }

  private removeQueuedTask(taskId: string): void {
    for (const queue of this.queues.values()) {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index].taskId === taskId) queue.splice(index, 1)
      }
    }
  }
}
