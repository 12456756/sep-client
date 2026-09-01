import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TaskStatus, type TaskExecutionEvent, type ToolAuthorizationRequest } from '../../src/shared/types'
import { ApprovalBroker } from '../pi/approval-broker'
import { createDefaultSharedPiSessionAdapter, PiTaskWorker, type PiTaskWorkerOptions } from '../pi/pi-task-worker'
import { TaskRunStore, type TaskRunStorePort } from './task-run-store'
import { TaskManager } from './task-manager'
import { WorkspaceLockManager } from './workspace-lock-manager'
import { ConversationContextStore, type ConversationMessage } from './domain/conversation-context'
import { SharedPiSessionAdapter } from '../pi/shared-session-adapter'
import { ConversationRecoveryError } from './conversation-recovery-error'

const SIDE_EFFECT_TOOLS = new Set(['bash', 'write', 'edit'])

export interface EmployeeRuntimeConfig {
  subscriptionId: string
  modelId: string
  gatewayUrl: string
  additionalSkillPaths?: string[]
}

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

type ControlIntent = 'none' | 'pause' | 'cancel' | 'interrupt'

interface ActiveRun {
  taskId: string
  runId: string
  subscriptionId: string
  releaseWorkspace: () => void
  worker: TaskWorkerPort
  control: ControlIntent
  completion: Promise<void>
}

interface QueuedRun {
  taskId: string
  runId: string
  subscriptionId: string
  prompt: string
  conversation: boolean
  resumeSessionFile?: string
  workerPrompt?: string
  degradedRecovery?: { originalSessionFile: string; mode: SessionRecoveryMode }
}

export type SessionRecoveryMode = 'strict' | 'confirm_rebuild' | 'auto_rebuild_from_task_history'

interface TaskWorkerPort {
  run(prompt: string): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void>
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
  private readonly approvalBroker: ApprovalBroker
  private readonly queue: QueuedRun[] = []
  private pumping = false
  private pumpRequested = false
  private readonly activeByTask = new Map<string, ActiveRun>()
  private readonly createWorker: (options: PiTaskWorkerOptions) => TaskWorkerPort
  private readonly eventChains = new Map<string, Promise<void>>()
  private readonly conversationStores = new Map<string, ConversationContextStore>()
  private readonly conversationAdapters = new Map<string, SharedPiSessionAdapter>()
  private readonly responseBuffers = new Map<string, string>()
  private readonly inFlightSideEffects = new Map<string, Map<string, { toolName: string; startedAt: number }>>()

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
    this.approvalBroker = new ApprovalBroker({
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
    if (!await this.authorizeEmployee(subscriptionId)) throw new Error('The selected employee is no longer available.')

    if (task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED) {
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    }

    const runId = randomUUID()
    await this.taskManager.admitTask(taskId, runId)
    const admittedTask = await this.taskManager.getTask(taskId)
    if (!admittedTask || admittedTask.activeRunId !== runId) return
    this.queue.push({ taskId, runId, subscriptionId, prompt: task.prompt, conversation: options.conversation === true })
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
    if (!employeeId || !await this.authorizeEmployee(employeeId)) throw new Error('The selected employee is no longer available.')
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
    this.queue.push({ taskId, runId, subscriptionId: employeeId, prompt: prompt.trim(), conversation: true, resumeSessionFile, workerPrompt, degradedRecovery })
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
    const active = this.activeByTask.get(taskId)
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
    this.approvalBroker.denyRun(active.runId)
    await active.worker.abort()
    await active.completion
  }

  async cancelTask(taskId: string): Promise<void> {
    const active = this.activeByTask.get(taskId)
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
    this.approvalBroker.denyRun(active.runId)
    await active.worker.abort()
    await active.completion
  }

  async stopAll(): Promise<void> {
    this.approvalBroker.denyAll()
    await Promise.all(Array.from(this.activeByTask.values()).map(async active => {
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

  respondToApproval(response: { requestId?: string; approved: boolean; reason?: string }): boolean {
    return this.approvalBroker.respond(response)
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
        for (let index = 0; index < this.queue.length;) {
          const queued = this.queue[index]
          const task = await this.taskManager.getTask(queued.taskId)
          if (!task || task.activeRunId !== queued.runId) {
            this.queue.splice(index, 1)
            continue
          }
          const employee = await this.authorizeEmployee(queued.subscriptionId)
          if (!employee) {
            this.queue.splice(index, 1)
            await this.taskManager.updateTaskStatus(queued.taskId, TaskStatus.FAILED, 'Selected employee is unavailable.')
            await this.taskManager.clearTaskRun(queued.taskId, queued.runId)
            continue
          }
          const releaseWorkspace = this.locks.acquire(queued.runId, task.workDir)
          if (!releaseWorkspace) {
            index++
            continue
          }
          this.queue.splice(index, 1)
          void this.startRun(queued, task, employee, releaseWorkspace)
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
    employee: EmployeeRuntimeConfig,
    releaseWorkspace: () => void,
  ): Promise<void> {
    const taskId = queued.taskId
    const runId = queued.runId
    const subscriptionId = queued.subscriptionId
    const scope = this.taskManager.getCurrentUserScope()
    const runPaths = scope && this.taskRunStore
      ? this.taskRunStore.getPaths(scope, taskId, runId)
      : null
    const conversationPaths = queued.conversation && scope && this.taskRunStore
      ? this.taskRunStore.getConversationSessionPaths(scope, taskId)
      : null
    const worker = this.createWorker({
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
      onApprovalRequest: request => this.approvalBroker.request(request),
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
    let resolveCompletion!: () => void
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve })
    const active: ActiveRun = { taskId, runId, subscriptionId, releaseWorkspace, worker, control: 'none', completion }
    let runCreated = false

    this.activeByTask.set(taskId, active)
    try {
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
      await (this.eventChains.get(taskId) ?? Promise.resolve())
      if (this.activeByTask.get(taskId) !== active) return
      await this.finalizeRun(active, queued, employee, scope, runCreated)
      return
    } catch (error) {
      console.error('[TaskExecutionCoordinator] run failed', {
        taskId,
        runId,
        subscriptionId,
        modelId: employee.modelId,
        control: active.control,
        error: error instanceof Error ? `${(error as Error).name}: ${(error as Error).message}` : String(error as unknown),
      })
      await this.finalizeRun(active, queued, employee, scope, runCreated, error)
    } finally {
      this.responseBuffers.delete(runId)
      this.inFlightSideEffects.delete(runId)
      await worker.dispose().catch(() => undefined)
      releaseWorkspace()
      if (this.activeByTask.get(taskId) === active) this.activeByTask.delete(taskId)
      const currentTask = await this.taskManager.getTask(taskId).catch(() => null)
      if (currentTask?.activeRunId === runId) await this.taskManager.clearTaskRun(taskId, runId).catch(() => undefined)
      resolveCompletion()
      void this.pump()
    }
  }

  private enqueueEvent(event: TaskExecutionEvent): Promise<void> {
    const prior = this.eventChains.get(event.taskId) ?? Promise.resolve()
    const operation = prior.catch(() => undefined).then(() => this.handleWorkerEvent(event))
    const chain = operation.then(() => undefined)
    this.eventChains.set(event.taskId, chain)
    void chain.finally(() => {
      if (this.eventChains.get(event.taskId) === chain) this.eventChains.delete(event.taskId)
    })
    return operation
  }

  private async finalizeRun(
    active: ActiveRun,
    queued: QueuedRun,
    employee: EmployeeRuntimeConfig,
    scope: { memberId: string; enterpriseId: string } | null,
    runCreated: boolean,
    failure?: unknown,
  ): Promise<void> {
    const outcome = active.control === 'cancel'
      ? 'cancelled'
      : active.control === 'interrupt'
        ? 'interrupted'
        : active.control === 'pause'
          ? 'stopped'
          : failure ? 'failed' : 'completed'
    const error = failure instanceof Error ? failure.message : failure ? String(failure) : undefined
    if (active.control !== 'none' || failure) {
      const pending = this.inFlightSideEffects.get(active.runId)
      for (const [toolId, tool] of pending ?? []) {
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
    const response = this.responseBuffers.get(active.runId)
    if (response && scope && queued.conversation) {
      await this.conversationStore(scope, active.taskId).appendMessage({
        id: `${active.runId}-assistant`, taskId: active.taskId, turnId: active.runId, runId: active.runId,
        subscriptionId: active.subscriptionId, modelId: employee.modelId, role: 'assistant', content: response, createdAt: Date.now(),
      })
      this.responseBuffers.delete(active.runId)
    }
    if (runCreated && scope && this.taskRunStore) {
      await this.taskRunStore.finish(scope, active.taskId, active.runId, outcome, error)
    }
    if (this.activeByTask.get(active.taskId) === active) {
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
    const active = this.activeByTask.get(event.taskId)
    if (!active || active.runId !== event.runId) return

    const scope = this.taskManager.getCurrentUserScope()
    const persistedEvent = scope && this.taskRunStore
      ? await this.taskRunStore.appendEvent(scope, event)
      : event

    if (persistedEvent.type === 'text_delta') {
      const data = persistedEvent.data as { text?: unknown }
      if (typeof data.text === 'string') {
        this.responseBuffers.set(persistedEvent.runId, `${this.responseBuffers.get(persistedEvent.runId) ?? ''}${data.text}`)
      }
    }

    if (event.type === 'approval_requested') {
      await this.taskManager.updateTaskStatus(event.taskId, TaskStatus.WAITING_APPROVAL)
    } else if (event.type === 'approval_resolved') {
      await this.taskManager.updateTaskStatus(event.taskId, TaskStatus.RUNNING)
    } else if (event.type === 'tool_execution_start') {
      const data = event.data as { toolId?: unknown; toolName?: unknown }
      if (typeof data.toolId === 'string' && typeof data.toolName === 'string' && SIDE_EFFECT_TOOLS.has(data.toolName)) {
        let pending = this.inFlightSideEffects.get(event.runId)
        if (!pending) {
          pending = new Map()
          this.inFlightSideEffects.set(event.runId, pending)
        }
        pending.set(data.toolId, { toolName: data.toolName, startedAt: event.occurredAt })
      }
      await this.taskManager.addTaskLog(event.taskId, `鎵ц宸ュ叿: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'tool_execution_end') {
      const data = event.data as { toolId?: unknown; toolName?: unknown }
      if (typeof data.toolId === 'string') this.inFlightSideEffects.get(event.runId)?.delete(data.toolId)
      await this.taskManager.addTaskLog(event.taskId, `宸ュ叿鎵ц瀹屾垚: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'auto_retry_start') {
      await this.taskManager.addTaskLog(event.taskId, 'Automatic retry started.', 'warning')
    }
    this.onEvent(persistedEvent)
  }

  private conversationStore(scope: { memberId: string; enterpriseId: string }, taskId: string): ConversationContextStore {
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    let store = this.conversationStores.get(key)
    if (!store && this.taskRunStore) {
      store = new ConversationContextStore(this.taskRunStore.getPaths(scope, taskId, 'store').taskDir)
      this.conversationStores.set(key, store)
    }
    if (!store) throw new Error('Conversation storage is unavailable.')
    return store
  }

  private userMessage(taskId: string, runId: string, subscriptionId: string, modelId: string, content: string): ConversationMessage {
    return { id: `${runId}-user`, taskId, turnId: runId, runId, subscriptionId, modelId, role: 'user', content, createdAt: Date.now() }
  }

  private removeQueuedTask(taskId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index].taskId === taskId) this.queue.splice(index, 1)
    }
  }

  private conversationAdapter(scope: { memberId: string; enterpriseId: string }, taskId: string): SharedPiSessionAdapter {
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    let adapter = this.conversationAdapters.get(key)
    if (!adapter) {
      adapter = createDefaultSharedPiSessionAdapter()
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
