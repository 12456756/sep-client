
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
  ControlIntent,
} from './run-types'
import { logger } from '../common/logger'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { WorkflowCheckpointStorePort } from '../data/workflow-checkpoint-store'
import { WorkflowExecutionCoordinator } from './workflow-execution-coordinator'
import { createWorkflowRunnerState, resumeInterrupted, retryFailedNode, stopWorkflow as stopWorkflowState, type WorkflowRunnerState } from './workflow-runner'
import { shouldPushTaskEvent } from './task-event-visibility'

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
  workPlanStore?: WorkPlanStorePort
  workflowCheckpointStore?: WorkflowCheckpointStorePort
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
  private readonly workPlanStore: WorkPlanStorePort | null
  private readonly workflowCheckpointStore: WorkflowCheckpointStorePort | null
  private readonly activeWorkflows = new Map<string, { taskId: string; runId: string; subscriptionId: string; coordinator: WorkflowExecutionCoordinator; completion: Promise<void>; releaseWorkspace: () => void; control: ControlIntent }>()
  private readonly locks: WorkspaceLockManager
  private readonly approvals: ToolApprovals

  private readonly admission = new RunQueue()
  private pumping = false
  private pumpRequested = false

  private readonly workers = new WorkerRegistry()

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
    this.workPlanStore = options.workPlanStore ?? null
    this.workflowCheckpointStore = options.workflowCheckpointStore ?? null
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
    const scope = this.taskManager.getCurrentUserScope()
    const workflow = scope && this.workPlanStore ? await this.workPlanStore.get(scope, taskId) : null
    if (workflow && workflow.mode !== 'conversation') {
      const checkpoint = scope && this.workflowCheckpointStore
        ? await this.workflowCheckpointStore.get(scope, taskId)
        : null
      if (checkpoint?.state.status === 'waiting-user') {
        throw new Error('Workflow is waiting for a failed node retry or stop.')
      }
      if (checkpoint?.state.status === 'interrupted') {
        throw new Error('Workflow is interrupted. Resume it explicitly before execution.')
      }
      if (checkpoint?.state.status === 'stopped') {
        throw new Error('Stopped workflows cannot be executed again.')
      }
      const primarySubscriptionId = workflow.nodes[0]?.subscriptionId ?? task.subscriptionId
      if (!primarySubscriptionId) throw new Error('Select a silicon employee before executing the task.')
      const employee = await this.authorizeEmployee(primarySubscriptionId)
      if (!employee) throw new Error('The selected employee is no longer available.')
      if (task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
      const runId = randomUUID()
      await this.taskManager.admitTask(taskId, runId)
      const admittedTask = await this.taskManager.getTask(taskId)
      if (!admittedTask || admittedTask.activeRunId !== runId) return
      this.admission.push({ taskId, runId, subscriptionId: primarySubscriptionId, employee, prompt: workflow.goal, conversation: false, workflow })
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

  async retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string } = {}): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    const scope = this.taskManager.getCurrentUserScope()
    const workflow = scope && this.workPlanStore ? await this.workPlanStore.get(scope, taskId) : null
    if (workflow && workflow.mode !== 'conversation') {
      await this.retryWorkflow(task, workflow, options.nodeId)
      return
    }
    if (task.status !== TaskStatus.FAILED && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.INTERRUPTED) {
      throw new Error('Only terminal or interrupted tasks can be retried.')
    }
    await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    await this.executeTask(taskId, options)
  }

  async stopWorkflow(taskId: string, reason?: string): Promise<void> {
    const activeWorkflow = this.activeWorkflows.get(taskId)
    if (activeWorkflow) {
      activeWorkflow.control = 'stop'
      await this.enqueueEvent({
        taskId, runId: activeWorkflow.runId, subscriptionId: activeWorkflow.subscriptionId, sequence: 0,
        type: 'stop_requested', occurredAt: Date.now(), data: reason ? { reason } : null,
      })
      this.approvals.denyRun(activeWorkflow.runId)
      await activeWorkflow.coordinator.stop()
      await activeWorkflow.completion
      return
    }
    const scope = this.taskManager.getCurrentUserScope()
    if (!scope || !this.workPlanStore || !this.workflowCheckpointStore) throw new Error('Workflow storage is unavailable.')
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    const plan = await this.workPlanStore.get(scope, taskId)
    if (!plan || plan.mode === 'conversation') throw new Error('The task is not an orchestration workflow.')
    this.removeQueuedTask(taskId)
    const checkpoint = await this.workflowCheckpointStore.get(scope, taskId)
    const state = checkpoint?.state ?? createWorkflowRunnerState(plan.nodes)
    const stopped = stopWorkflowState(state)
    await this.saveWorkflowCheckpoint(scope, taskId, plan.planHash, null, stopped)
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

  private async retryWorkflow(
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    plan: NonNullable<Awaited<ReturnType<WorkPlanStorePort['get']>>>,
    nodeId?: string,
  ): Promise<void> {
    const scope = this.taskManager.getCurrentUserScope()
    if (!scope || !this.workflowCheckpointStore) throw new Error('Workflow checkpoint storage is unavailable.')
    const checkpoint = await this.workflowCheckpointStore.get(scope, task.id)
    if (!checkpoint) throw new Error('Workflow has no recoverable checkpoint.')
    if (checkpoint.state.status === 'stopped' || checkpoint.state.status === 'completed') throw new Error('This workflow cannot be retried.')
    let nextState: WorkflowRunnerState
    if (nodeId) {
      nextState = retryFailedNode(checkpoint.state, plan.nodes, nodeId)
      if (nextState === checkpoint.state) throw new Error('The selected node is not waiting for a retry.')
    } else {
      if (checkpoint.state.status !== 'interrupted') throw new Error('A failed workflow node must be selected for retry.')
      nextState = resumeInterrupted(checkpoint.state)
    }
    await this.saveWorkflowCheckpoint(scope, task.id, checkpoint.planHash, null, nextState)
    if (task.status !== TaskStatus.PENDING) await this.taskManager.updateTaskStatus(task.id, TaskStatus.PENDING)
    await this.executeTask(task.id, { conversation: false })
  }

  private async saveWorkflowCheckpoint(
    scope: NonNullable<ReturnType<TaskManager['getCurrentUserScope']>>,
    taskId: string,
    planHash: string,
    activeRunId: string | null,
    state: WorkflowRunnerState,
  ): Promise<void> {
    if (!this.workflowCheckpointStore) throw new Error('Workflow checkpoint storage is unavailable.')
    await this.workflowCheckpointStore.save(scope, {
      version: 1, taskId, owner: { ...scope }, planHash, activeRunId,
      state: structuredClone(state), updatedAt: Date.now(),
    })
  }

  async pauseTask(taskId: string): Promise<void> {
    const activeWorkflow = this.activeWorkflows.get(taskId)
    if (activeWorkflow) {
      activeWorkflow.control = 'pause'
      this.approvals.denyRun(activeWorkflow.runId)
      await activeWorkflow.coordinator.abort()
      await activeWorkflow.completion
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
    const activeWorkflow = this.activeWorkflows.get(taskId)
    if (activeWorkflow) {
      activeWorkflow.control = 'cancel'
      await this.enqueueEvent({
        taskId,
        runId: activeWorkflow.runId,
        subscriptionId: activeWorkflow.subscriptionId,
        sequence: 0,
        type: 'cancel_requested',
        occurredAt: Date.now(),
        data: null,
      })
      this.approvals.denyRun(activeWorkflow.runId)
      await activeWorkflow.coordinator.abort()
      await activeWorkflow.completion
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
    const workflowStops = Array.from(this.activeWorkflows.values()).map(async activeWorkflow => {
      activeWorkflow.control = 'interrupt'
      await this.enqueueEvent({
        taskId: activeWorkflow.taskId,
        runId: activeWorkflow.runId,
        subscriptionId: activeWorkflow.subscriptionId,
        sequence: 0,
        type: 'shutdown_requested',
        occurredAt: Date.now(),
        data: null,
      })
      await activeWorkflow.coordinator.abort()
      await activeWorkflow.completion
    })
    await Promise.all([Promise.all(workflowStops), Promise.all(this.workers.list().map(async active => {
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
    if (queued.workflow) {
      await this.startWorkflowRun(queued, task, releaseWorkspace)
      return
    }
    const taskId = queued.taskId
    const runId = queued.runId
    const subscriptionId = queued.subscriptionId
    const employee = queued.employee
    const scope = this.taskManager.getCurrentUserScope()
    let worker: TaskWorkerPort | null = null
    let active: ActiveRun | null = null
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

  private async startWorkflowRun(
    queued: QueuedRun,
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    releaseWorkspace: () => void,
  ): Promise<void> {
    const plan = queued.workflow
    if (!plan) {
      releaseWorkspace()
      return
    }
    const taskId = queued.taskId
    const runId = queued.runId
    const scope = this.taskManager.getCurrentUserScope()
    const completion = createRunCompletion()
    let parentCreated = false
    let workflow: WorkflowExecutionCoordinator | null = null
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
      workflow = new WorkflowExecutionCoordinator({
        scope,
        taskManager: this.taskManager,
        taskRunStore: this.taskRunStore,
        checkpointStore: this.workflowCheckpointStore,
        createWorker: this.createWorker,
        getRefreshToken: this.getRefreshToken,
        onAuthenticationRequired: this.onAuthenticationRequired,
        onApprovalRequest: request => this.approvals.request(request),
        onEvent: event => this.enqueueEvent(event),
        authorizeEmployee: this.authorizeEmployee,
        workspaceRoot: task.workDir ?? this.getTaskWorkspaceRoot(),
        workflowSubscriptionId: queued.subscriptionId,
      })
      this.activeWorkflows.set(taskId, {
        taskId,
        runId,
        subscriptionId: queued.subscriptionId,
        coordinator: workflow,
        completion: completion.promise,
        releaseWorkspace,
        control: 'none',
      })
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.RUNNING)
      const result = await workflow.execute(plan, taskId, runId)
      await this.events.drain(taskId)
      const activeWorkflow = this.activeWorkflows.get(taskId)
      const control = activeWorkflow?.runId === runId ? activeWorkflow.control : 'none'
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
      if (activeWorkflow?.runId === runId) {
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
      if (this.activeWorkflows.get(taskId)?.runId === runId) this.activeWorkflows.delete(taskId)
      releaseWorkspace()
      await this.taskManager.clearTaskRun(taskId, runId).catch(() => undefined)
      completion.settle()
      void this.pump()
    }
  }

  private async handleWorkerEvent(event: TaskExecutionEvent): Promise<void> {
    const active = this.workers.active(event.taskId)
    const workflow = this.activeWorkflows.get(event.taskId)
    if (active && active.runId !== event.runId) return
    if (!active && !workflow) return

    const scope = this.taskManager.getCurrentUserScope()
    if (!active && workflow && event.runId !== workflow.runId) {
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
