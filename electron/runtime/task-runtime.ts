/**
 * 任务运行时的统一入口。
 *
 * 本类只负责入队、工作目录锁、运行状态和事件路由；对话上下文由
 * ConversationExecutor 维护，编排节点由 ArrangementExecutor 执行。
 * 这样任务生命周期的公共约束集中在这里，具体执行方式不会反向污染调度逻辑。
 */
import { randomUUID } from 'node:crypto'
import { TaskStatus, type TaskExecutionEvent, type ToolAuthorizationRequest } from '../../src/shared/types'
import type { InputSnapshotRef } from '../../src/shared/attachment-contracts'
import { ToolApprovals } from './run-approvals'
import { PiTaskWorker, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import { TaskRunStore, type TaskRunStorePort } from '../data/task-run-store'
import type { TaskManager } from './task-manager'
import { WorkspaceLockManager } from './workspace-lock-manager'
import { ConversationExecutor } from './conversation-executor'
import { RunQueue } from './run-queue'
import { EventPipeline } from './run-events'
import { createRunCompletion, WorkerRegistry } from './run-workers'
import { cleanupRun } from './run-cleanup'
import type {
  EmployeeRuntimeConfig,
  QueuedRun,
  SessionRecoveryMode,
  TaskWorkerPort,
  ControlIntent,
} from './run-types'
import { redactText } from '../common/redact'
import { logger } from '../common/logger'
import { AppError } from '../errors/app-error'
import { runtimeFeedback, runtimeFailureEvent, sanitizeRuntimeErrorEvent } from '../errors/runtime-feedback'
import { runtimeFailureNoticeSchema } from '../../src/shared/runtime-feedback'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import { ArrangementExecutor } from './arrangement-executor'
import { createArrangementExecutionState, confirmArrangementNode, interruptArrangement, resumeArrangement, retryArrangementNode, stopArrangement, type ArrangementExecutionState } from '../domain/arrangement-execution'
import { arrangementInputReplySchema, type ArrangementInputReply } from '../../src/shared/arrangement-input'
import { shouldPushTaskEvent } from './task-event-visibility'
import { silentTaskMonitor, type MonitorTaskStartedInput, type MonitorTaskFinishedInput, type MonitorTaskContentInput, type MonitorTaskQueuedInput, type TaskMonitorPort } from '../domain/task-monitor'
import { monitorParticipationSchema, type MonitorParticipation } from '../common/platform/client-monitor-contract'
import type { MediaRunPort } from '../domain/media-tools'
import type { VideoRunPort } from '../domain/video-tools'
import type { ArrangementMediaPort } from '../domain/arrangement-media-runtime'
import type { KnowledgeSearchPort } from '../common/knowledge-context'
import type { AttachmentInputPort } from '../domain/attachment-input'
import type { TaskLifecycleRuntimeEvidence } from '../domain/task-lifecycle'
import type { ModelTraceFactory } from '../domain/model-trace'

const log = logger.child('task-runtime')

type FileToolName = 'write' | 'edit'

interface ToolExecutionData {
  toolId?: unknown
  toolName?: unknown
  input?: unknown
  success?: unknown
}

interface PendingFileToolState {
  taskId: string
  parentRunId: string
  files: Map<string, string>
}

function isFileToolName(value: unknown): value is FileToolName {
  return value === 'write' || value === 'edit'
}

function filePathFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const path = (input as { path?: unknown }).path
  return typeof path === 'string' && path.trim() ? path : null
}

export interface TaskRuntimeOptions {
  createModelTrace?: ModelTraceFactory
  taskManager: TaskManager
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  onEvent: (event: TaskExecutionEvent) => void
  onApprovalRequest: (request: ToolAuthorizationRequest) => void
  resolveEmployee: (subscriptionId: string) => EmployeeRuntimeConfig | null
  authorizeEmployee?: (subscriptionId: string, modelId?: string) => Promise<EmployeeRuntimeConfig | null>
  authorizeModel?: (modelId: string, preferredSubscriptionId?: string) => Promise<EmployeeRuntimeConfig | null>
  createWorker?: (options: PiTaskWorkerOptions) => TaskWorkerPort
  taskRunStore?: TaskRunStorePort
  userDataDir?: string
  getTaskWorkspaceRoot?: () => string
  workPlanStore?: WorkPlanStorePort
  arrangementCheckpointStore?: ArrangementCheckpointStorePort
  monitor?: TaskMonitorPort
  media?: MediaRunPort
  video?: VideoRunPort
  arrangementMedia?: ArrangementMediaPort
  knowledgeSearch?: KnowledgeSearchPort
  attachmentInputs?: AttachmentInputPort
}

export class TaskRuntime {
  private readonly taskManager: TaskManager
  private readonly getRefreshToken: () => string
  private readonly onAuthenticationRequired: () => void
  private readonly onEvent: (event: TaskExecutionEvent) => void
  private readonly resolveEmployee: (subscriptionId: string) => EmployeeRuntimeConfig | null
  private readonly authorizeEmployee: (subscriptionId: string, modelId?: string) => Promise<EmployeeRuntimeConfig | null>
  private readonly authorizeModel: TaskRuntimeOptions['authorizeModel']
  private readonly taskRunStore: TaskRunStorePort | null
  private readonly getTaskWorkspaceRoot: () => string
  private readonly workPlanStore: WorkPlanStorePort | null
  private readonly arrangementCheckpointStore: ArrangementCheckpointStorePort | null
  private readonly monitor: TaskMonitorPort
  private readonly media: MediaRunPort | undefined
  private readonly video: VideoRunPort | undefined
  private readonly arrangementMedia: ArrangementMediaPort | undefined
  private readonly knowledgeSearch: KnowledgeSearchPort | undefined
  private readonly attachmentInputs: AttachmentInputPort | undefined
  private readonly activeArrangements = new Map<string, { taskId: string; runId: string; subscriptionId: string; executor: ArrangementExecutor; completion: Promise<void>; releaseWorkspace: () => void; control: ControlIntent; controlReason?: string }>()
  private readonly locks: WorkspaceLockManager
  private readonly approvals: ToolApprovals

  private readonly admission = new RunQueue()
  private pumping = false
  private pumpRequested = false

  private readonly workers = new WorkerRegistry()

  private readonly events: EventPipeline
  private readonly createWorker: (options: PiTaskWorkerOptions) => TaskWorkerPort
  private readonly createModelTrace: ModelTraceFactory | undefined
  private readonly conversationExecutor: ConversationExecutor
  private readonly pendingFileTools = new Map<string, PendingFileToolState>()
  private readonly nodeParticipations = new Map<string, { taskId: string; parentRunId: string; participation: MonitorParticipation }>()
  private readonly pendingArrangementApprovals = new Map<string, Set<string>>()
  private lifecycleAuditTimer: ReturnType<typeof setInterval> | null = null
  private lifecycleAuditRunning = false
  private readonly startingRuns = new Map<string, string>()

  constructor(options: TaskRuntimeOptions) {
    this.createModelTrace = options.createModelTrace
    this.taskManager = options.taskManager
    this.getRefreshToken = options.getRefreshToken
    this.onAuthenticationRequired = options.onAuthenticationRequired
    this.onEvent = options.onEvent
    this.resolveEmployee = options.resolveEmployee
    this.authorizeModel = options.authorizeModel
    this.authorizeEmployee = options.authorizeEmployee ?? (async (subscriptionId, modelId) => {
      const employee = this.resolveEmployee(subscriptionId)
      return employee && (!modelId || employee.modelId === modelId) ? employee : null
    })
    this.createWorker = workerOptions => {
      const context = workerOptions.context
      const modelTrace = context.modelTrace ?? options.createModelTrace?.({ taskId: context.taskId, runId: context.runId,
        title: context.taskTitle ?? '对话任务', phase: context.tracePhase ?? (context.arrangementNodeId ? `节点：${context.nodeTitle ?? context.arrangementNodeId}` : '对话执行') })
      const tracedOptions = { ...workerOptions, context: { ...context, modelTrace } }
      return options.createWorker?.(tracedOptions) ?? new PiTaskWorker(tracedOptions)
    }
    this.taskRunStore = options.taskRunStore ?? (options.userDataDir ? new TaskRunStore(options.userDataDir) : null)
    this.getTaskWorkspaceRoot = options.getTaskWorkspaceRoot ?? (() => process.cwd())
    this.workPlanStore = options.workPlanStore ?? null
    this.arrangementCheckpointStore = options.arrangementCheckpointStore ?? null
    this.monitor = options.monitor ?? silentTaskMonitor
    this.media = options.media
    this.video = options.video
    this.arrangementMedia = options.arrangementMedia
    this.knowledgeSearch = options.knowledgeSearch
    this.attachmentInputs = options.attachmentInputs
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
      workPlanStore: this.workPlanStore,
      createWorker: this.createWorker,
      getRefreshToken: this.getRefreshToken,
      onAuthenticationRequired: this.onAuthenticationRequired,
      authorizeEmployee: this.authorizeEmployee,
      authorizeModel: this.authorizeModel,
      workspaceRoot: this.getTaskWorkspaceRoot,
      approvals: this.approvals,
      events: this.events,
      workers: this.workers,
      enqueue: queued => this.admission.push(queued),
      requestPump: () => { void this.pump() },
      onQueued: input => {
        this.reportMonitorQueued(input)
        this.reportMonitorInput({ taskId: input.taskId, runId: input.runId, content: this.admission.find(input.runId)?.workerPrompt ?? input.prompt })
      },
      onOutput: input => this.reportMonitorOutput(input),
      onStarted: input => this.reportMonitorStarted(input),
      onFinished: input => this.reportMonitorFinished(input),
      onFailure: event => this.notifyRunFailure(event),
      media: this.media,
      video: this.video,
      knowledgeSearch: this.knowledgeSearch,
      attachmentInputs: this.attachmentInputs,
    })
    this.startLifecycleAudit()
  }

  /** Read-only current-process ownership snapshot for lifecycle auditing. */
  private snapshotLifecycleRuntime(): ReadonlyMap<string, TaskLifecycleRuntimeEvidence> {
    const snapshot = new Map<string, TaskLifecycleRuntimeEvidence>()
    for (const queued of this.admission.snapshot()) snapshot.set(queued.taskId, { runId: queued.runId, phase: 'queued' })
    for (const [taskId, runId] of this.startingRuns) snapshot.set(taskId, { runId, phase: 'starting' })
    for (const active of this.workers.list()) {
      snapshot.set(active.taskId, { runId: active.runId, phase: active.control === 'none' ? 'running' : 'finalizing' })
    }
    for (const arrangement of this.activeArrangements.values()) {
      snapshot.set(arrangement.taskId, { runId: arrangement.runId, phase: arrangement.control === 'none' ? 'running' : 'finalizing' })
    }
    return snapshot
  }

  private startLifecycleAudit(): void {
    if (this.lifecycleAuditTimer) return
    this.lifecycleAuditTimer = setInterval(() => { void this.runLifecycleAudit() }, 30_000)
    this.lifecycleAuditTimer.unref?.()
  }

  private async runLifecycleAudit(): Promise<void> {
    if (!this.taskManager.hasCurrentUser() || this.lifecycleAuditRunning) return
    this.lifecycleAuditRunning = true
    try {
      const report = await this.taskManager.auditTaskLifecycles({
        runtime: taskId => this.snapshotLifecycleRuntime().get(taskId) ?? null, limit: 50, missingGraceMs: 60_000,
        reconcile: process.env['SEP_TASK_LIFECYCLE_RECONCILE'] === '1',
      })
      const findings = report.findings.filter(item => item.finding.kind !== 'live' && item.finding.kind !== 'protected' && item.finding.kind !== 'not-started')
      if (findings.length > 0) {
        log.warn('task lifecycle audit found inconsistent records', {
          scanned: report.scanned, reconciled: report.reconciled,
          findings: findings.map(item => ({ taskId: item.taskId, status: item.taskStatus, kind: item.finding.kind, reason: item.finding.reason, reconciled: item.reconciled })),
        })
      }
    } catch (error) {
      log.warn('task lifecycle audit failed', { cause: redactText(error instanceof Error ? error.message : String(error)) })
    } finally {
      this.lifecycleAuditRunning = false
    }
  }

  async executeTask(taskId: string, options: { conversation?: boolean; knowledge?: import('../../src/shared/knowledge-selection').KnowledgeSelection } = {}): Promise<void> {
    this.startLifecycleAudit()
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      throw new Error('Terminal tasks cannot be executed.')
    }
    const scope = this.taskManager.getCurrentUserScope()
    const arrangement = scope && this.workPlanStore ? await this.workPlanStore.get(scope, taskId) : null
    const taskKnowledge = arrangement?.mode === 'conversation'
      ? options.knowledge ?? arrangement.knowledge
      : arrangement ? arrangement.knowledge : options.knowledge ?? await this.latestKnowledgeSelection(taskId)
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
      this.admission.push({ taskId, runId, subscriptionId: primarySubscriptionId, employee, prompt: arrangement.goal, conversation: false, arrangement, knowledge: taskKnowledge,
        ...(arrangement.inputSnapshot?.attachments?.length ? { attachmentRefs: arrangement.inputSnapshot.attachments } : {}) })
      this.reportMonitorQueued({ taskId, runId, prompt: arrangement.goal, subscriptionId: primarySubscriptionId, title: task.title, modelId: employee.modelId, taskType: 'arrangement' })
      this.reportMonitorInput({ taskId, runId, content: arrangement.goal })
      void this.pump()
      return
    }
    const general = arrangement?.mode === 'conversation' && arrangement.conversation?.kind === 'general'
    const selectedSubscriptionId = task.subscriptionId
    if (!selectedSubscriptionId && !general) throw new Error('Select a silicon employee before executing the task.')
    const modelId = general ? arrangement.conversation!.modelId : arrangement?.conversation?.participants.find(item => item.subscriptionId === selectedSubscriptionId)?.modelId
    const employee = general
      ? modelId ? await this.authorizeModel?.(modelId, selectedSubscriptionId ?? undefined) : null
      : await this.authorizeEmployee(selectedSubscriptionId!, modelId)
    if (!employee) throw new Error('The selected employee is no longer available.')
    const subscriptionId = employee.subscriptionId
    if (general && selectedSubscriptionId !== subscriptionId) await this.taskManager.setTaskEmployee(taskId, subscriptionId)

    if (task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED) {
      await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    }

    const runId = randomUUID()
    await this.taskManager.admitTask(taskId, runId)
    const admittedTask = await this.taskManager.getTask(taskId)
    if (!admittedTask || admittedTask.activeRunId !== runId) return
    const isConversation = arrangement?.mode === 'conversation' || options.conversation === true
    this.admission.push({ taskId, runId, subscriptionId, employee, prompt: task.prompt, conversation: isConversation, arrangement: arrangement ?? undefined,
      knowledge: taskKnowledge,
      ...(arrangement?.inputSnapshot?.attachments?.length ? { attachmentRefs: arrangement.inputSnapshot.attachments } : {}) })
    this.reportMonitorQueued({ taskId, runId, prompt: task.prompt, subscriptionId, title: task.title, modelId: employee.modelId, taskType: isConversation ? 'conversation' : 'arrangement',
      participation: { executionId: runId, subscriptionId, title: task.title, modelId: employee.modelId } })
    this.reportMonitorInput({ taskId, runId, content: task.prompt })
    void this.pump()
  }

  async continueConversation(
    taskId: string,
    prompt: string,
    recovery: { mode?: SessionRecoveryMode; confirmed?: boolean; inputSnapshot?: InputSnapshotRef; knowledge?: import('../../src/shared/knowledge-selection').KnowledgeSelection } = {},
  ): Promise<void> {
    this.startLifecycleAudit()
    const knowledge = recovery.knowledge ?? await this.latestKnowledgeSelection(taskId)
    return this.conversationExecutor.continue(taskId, prompt, {
      ...recovery,
      ...(knowledge ? { knowledge } : {}),
      ...(recovery.inputSnapshot ? { attachmentRefs: recovery.inputSnapshot.attachments } : {}),
    })
  }

  async switchConversationEmployee(taskId: string, subscriptionId: string): Promise<void> {
    return this.conversationExecutor.switchEmployee(taskId, subscriptionId)
  }

  async retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string; inputReply?: ArrangementInputReply } = {}): Promise<void> {
    const task = await this.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    const scope = this.taskManager.getCurrentUserScope()
    const arrangement = scope && this.workPlanStore ? await this.workPlanStore.get(scope, taskId) : null
    if (options.inputReply && (!options.nodeId || !arrangement || arrangement.mode === 'conversation' || !arrangementInputReplySchema.safeParse(options.inputReply).success)) throw new AppError('INVALID_ARGUMENT')
    if (task.status === TaskStatus.PENDING && task.executionHealth === 'start-failed' && !task.activeRunId) {
      await this.executeTask(taskId, { ...options, knowledge: await this.latestKnowledgeSelection(taskId) })
      return
    }
    if (arrangement && arrangement.mode !== 'conversation') {
      await this.retryArrangement(task, arrangement, options.nodeId, options.inputReply)
      return
    }
    if (task.status !== TaskStatus.FAILED && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.INTERRUPTED) {
      throw new Error('Only terminal or interrupted tasks can be retried.')
    }
    await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    await this.executeTask(taskId, { ...options, knowledge: await this.latestKnowledgeSelection(taskId) })
  }

  private async latestKnowledgeSelection(taskId: string): Promise<import('../../src/shared/knowledge-selection').KnowledgeSelection | undefined> {
    const scope = this.taskManager.getCurrentUserScope()
    if (!scope || !this.taskRunStore) return undefined
    const runs = await this.taskRunStore.list(scope, taskId)
    const latest = [...runs].sort((a, b) => b.startedAt - a.startedAt)[0]
    return latest ? latest.knowledge ?? { mode: 'none', knowledgeBaseIds: [] } : undefined
  }

  async confirmArrangementNodes(taskId: string, nodeIds: string[]): Promise<void> {
    if (this.arrangementRetries.has(taskId) || this.activeArrangements.has(taskId)) throw new AppError('INVALID_STATE', { message: '这项编排正在执行，请稍后再确认。' })
    this.arrangementRetries.add(taskId)
    try {
      const scope = this.taskManager.getCurrentUserScope()
      if (!scope || !this.workPlanStore || !this.arrangementCheckpointStore) throw new Error('Arrangement storage is unavailable.')
      const task = await this.taskManager.getTask(taskId)
      const plan = await this.workPlanStore.get(scope, taskId)
      const checkpoint = await this.arrangementCheckpointStore.get(scope, taskId)
      if (!task || task.status !== TaskStatus.PAUSED || task.activeRunId || !plan || plan.mode === 'conversation' || !checkpoint ||
        checkpoint.planHash !== plan.planHash || checkpoint.activeRunId || checkpoint.state.status !== 'waiting-user') {
        throw new AppError('INVALID_STATE', { message: '编排状态已变化，无法确认。' })
      }
      const uniqueIds = [...new Set(nodeIds)]
      if (!uniqueIds.length || uniqueIds.length !== nodeIds.length) throw new AppError('INVALID_ARGUMENT')
      if (uniqueIds.some(id => !plan.nodes.some(node => node.id === id && node.requiresUserConfirmation) ||
        !checkpoint.state.nodes.some(node => node.nodeId === id && node.status === 'completed' && node.pendingConfirmation))) {
        throw new AppError('INVALID_STATE', { message: '存在不可确认的节点。' })
      }
      const primary = plan.nodes[0]
      if (!primary || !await this.authorizeEmployee(primary.subscriptionId)) throw new Error('The selected employee is no longer available.')
      const currentScope = this.taskManager.getCurrentUserScope()
      const currentTask = await this.taskManager.getTask(taskId)
      const currentPlan = await this.workPlanStore.get(scope, taskId)
      const currentCheckpoint = await this.arrangementCheckpointStore.get(scope, taskId)
      if (!currentScope || currentScope.enterpriseId !== scope.enterpriseId || currentScope.memberId !== scope.memberId ||
        currentTask?.status !== TaskStatus.PAUSED || currentTask.activeRunId || currentPlan?.planHash !== plan.planHash ||
        JSON.stringify(currentCheckpoint) !== JSON.stringify(checkpoint)) throw new AppError('INVALID_STATE', { message: '编排状态已变化，请刷新后再确认。' })
      let state = checkpoint.state
      for (const nodeId of uniqueIds) state = confirmArrangementNode(state, plan.nodes, nodeId)
      try {
        await this.saveArrangementCheckpoint(scope, taskId, checkpoint.planHash, null, state)
        if (state.status === 'running' || state.status === 'completed') {
          await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
          await this.executeTask(taskId, { conversation: false })
        }
      } catch (error) {
        const current = await this.taskManager.getTask(taskId)
        if (current && !current.activeRunId) {
          await this.arrangementCheckpointStore.save(scope, checkpoint)
          await this.taskManager.updateTaskStatus(taskId, task.status, task.error ?? undefined)
        }
        throw error
      }
    } finally { this.arrangementRetries.delete(taskId) }
  }

  async stopArrangement(taskId: string, reason?: string): Promise<void> {
    const activeArrangement = this.activeArrangements.get(taskId)
    if (activeArrangement) {
      activeArrangement.control = 'stop'
      await this.enqueueEvent({
        taskId, runId: activeArrangement.runId, subscriptionId: activeArrangement.subscriptionId, sequence: 0,
        type: 'stop_requested', occurredAt: Date.now(), data: reason ? { reason } : null,
      })
      this.denyTaskApprovals(taskId, activeArrangement.runId)
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
    await Promise.all([this.media?.stopTask(taskId), this.video?.stopTask(taskId)])
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
      this.reportMonitorFinished({ taskId, runId: latest.activeRunId, status: 'PAUSED', error: reason, completedAt: Date.now() })
      return
    }
    if (latest.status === TaskStatus.INTERRUPTED) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    const current = await this.taskManager.getTask(taskId)
    if (current?.status === TaskStatus.PENDING) await this.taskManager.updateTaskStatus(taskId, TaskStatus.PAUSED, reason)
  }

  private readonly arrangementRetries = new Set<string>()

  private async retryArrangement(
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    plan: NonNullable<Awaited<ReturnType<WorkPlanStorePort['get']>>>,
    nodeId?: string,
    inputReply?: ArrangementInputReply,
  ): Promise<void> {
    const scope = this.taskManager.getCurrentUserScope()
    if (this.arrangementRetries.has(task.id)) {
      throw new AppError('INVALID_STATE', { message: '这项编排正在执行或提交重试，请等待当前操作完成。' })
    }
    this.arrangementRetries.add(task.id)
    try {
      const active = this.activeArrangements.get(task.id)
      if (active) {
        if (!nodeId || active.control !== 'none') throw new AppError('INVALID_STATE', { message: '当前编排仍在执行，只能重试已失败的指定节点。' })
        if (await active.executor.retryFailedNode(nodeId, inputReply)) return
        const liveCheckpoint = scope && this.arrangementCheckpointStore
          ? await this.arrangementCheckpointStore.get(scope, task.id)
          : null
        const waitingNode = liveCheckpoint?.state.nodes.find(node => node.nodeId === nodeId)
        if (waitingNode?.status !== 'failed' && !waitingNode?.inputRequest) {
          throw new AppError('INVALID_STATE', { message: '只能重试当前失败的节点。' })
        }
        await active.completion
        const latest = await this.taskManager.getTask(task.id)
        if (!latest) throw new Error('Task not found.')
        await this.prepareArrangementRetry(latest, plan, nodeId, inputReply)
        return
      }
      if (task.activeRunId) throw new AppError('INVALID_STATE', { message: '这项编排正在执行或提交重试，请等待当前操作完成。' })
      await this.prepareArrangementRetry(task, plan, nodeId, inputReply)
    }
    finally { this.arrangementRetries.delete(task.id) }
  }

  private async prepareArrangementRetry(
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    plan: NonNullable<Awaited<ReturnType<WorkPlanStorePort['get']>>>,
    nodeId?: string,
    inputReply?: ArrangementInputReply,
  ): Promise<void> {
    const scope = this.taskManager.getCurrentUserScope()
    if (!scope || !this.arrangementCheckpointStore) throw new Error('Arrangement checkpoint storage is unavailable.')
    const checkpoint = await this.arrangementCheckpointStore.get(scope, task.id)
    if (!checkpoint) throw new Error('Arrangement has no recoverable checkpoint.')
    if (checkpoint.planHash !== plan.planHash) throw new AppError('INVALID_STATE', { message: '编排计划与恢复进度不一致，无法重试。' })
    if (checkpoint.state.status === 'stopped' || checkpoint.state.status === 'completed') throw new AppError('INVALID_STATE', { message: '这项编排已终止或完成，不能重试。' })
    let nextState: ArrangementExecutionState
    if (checkpoint.state.status === 'waiting-user' || checkpoint.state.status === 'failed') {
      nextState = retryArrangementNode(checkpoint.state, plan.nodes, nodeId, inputReply)
      if (nextState === checkpoint.state) throw new AppError('INVALID_STATE', { message: inputReply ? '补充回复对应的问题已变化，请刷新后重新回答。' : '没有可重试的失败节点；等待补充规格的节点需要先提交回复。' })
    } else {
      // A failed admission/write can leave an inactive checkpoint with its pre-execution status.
      const stale = !checkpoint.activeRunId &&
        (task.status === TaskStatus.FAILED || task.status === TaskStatus.INTERRUPTED) &&
        (checkpoint.state.status === 'running' || checkpoint.state.status === 'queued')
      const interrupted = stale ? interruptArrangement(checkpoint.state, 'runtime-error') : checkpoint.state
      if (interrupted.status !== 'interrupted' || (nodeId && !interrupted.nodes.some(node =>
        node.nodeId === nodeId && (node.status === 'interrupted' || node.status === 'ready')))) {
        throw new AppError('INVALID_STATE', { message: '当前编排状态不支持重试。' })
      }
      nextState = resumeArrangement(interrupted)
    }
    // Authorization must not consume the failed checkpoint before admission.
    const primary = plan.nodes[0]
    if (!primary || !await this.authorizeEmployee(primary.subscriptionId)) throw new Error('The selected employee is no longer available.')
    try {
      await this.saveArrangementCheckpoint(scope, task.id, checkpoint.planHash, null, nextState)
      if (task.status !== TaskStatus.PENDING) await this.taskManager.updateTaskStatus(task.id, TaskStatus.PENDING)
      await this.executeTask(task.id, { conversation: false })
    } catch (error) {
      const current = await this.taskManager.getTask(task.id)
      if (current && !current.activeRunId) {
        await this.arrangementCheckpointStore.save(scope, checkpoint)
        await this.taskManager.updateTaskStatus(task.id, task.status, task.error ?? undefined)
      }
      throw error
    }
  }

  private async saveArrangementCheckpoint(
    scope: NonNullable<ReturnType<TaskManager['getCurrentUserScope']>>,
    taskId: string,
    planHash: string,
    activeRunId: string | null,
    state: ArrangementExecutionState,
    lastRunId?: string,
  ): Promise<void> {
    if (!this.arrangementCheckpointStore) throw new Error('Arrangement checkpoint storage is unavailable.')
    await this.arrangementCheckpointStore.save(scope, {
      version: 1, taskId, owner: { ...scope }, planHash, activeRunId,
      ...(lastRunId ? { lastRunId } : {}),
      state: structuredClone(state), updatedAt: Date.now(),
    })
  }

  async pauseTask(taskId: string): Promise<void> {
    const activeArrangement = this.activeArrangements.get(taskId)
    if (activeArrangement) {
      activeArrangement.control = 'pause'
      this.denyTaskApprovals(taskId, activeArrangement.runId)
      await activeArrangement.executor.abort()
      await activeArrangement.completion
      return
    }
    const active = this.workers.active(taskId)
    if (!active) {
      this.removeQueuedTask(taskId)
      await Promise.all([this.media?.stopTask(taskId), this.video?.stopTask(taskId)])
      const task = await this.taskManager.getTask(taskId)
      if (task?.status === TaskStatus.PENDING && task.activeRunId) {
        await this.taskManager.pauseTask(taskId)
        await this.taskManager.clearTaskRun(taskId, task.activeRunId)
        this.reportMonitorFinished({ taskId, runId: task.activeRunId, status: 'PAUSED', completedAt: Date.now() })
      }
      return
    }
    active.control = 'pause'
    active.abortController?.abort()
    this.approvals.denyRun(active.runId)
    await Promise.all([active.worker.abort(), this.media?.stopTask(taskId), this.video?.stopTask(taskId)])
    await active.completion
  }

  async cancelTask(taskId: string, reason?: string): Promise<void> {
    const stopReason = redactText(reason?.trim() || '用户终止了这项工作')
    const activeArrangement = this.activeArrangements.get(taskId)
    if (activeArrangement) {
      activeArrangement.control = 'cancel'
      activeArrangement.controlReason = stopReason
      await this.enqueueEvent({
        taskId,
        runId: activeArrangement.runId,
        subscriptionId: activeArrangement.subscriptionId,
        sequence: 0,
        type: 'cancel_requested',
        occurredAt: Date.now(),
        data: null,
      })
      this.denyTaskApprovals(taskId, activeArrangement.runId)
      await activeArrangement.executor.abort()
      await activeArrangement.completion
      return
    }
    const active = this.workers.active(taskId)
    if (!active) {
      this.removeQueuedTask(taskId)
      await Promise.all([this.media?.stopTask(taskId), this.video?.stopTask(taskId)])
      const task = await this.taskManager.getTask(taskId)
      if (task?.activeRunId && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) {
        await this.taskManager.settleTaskRun(taskId, task.activeRunId, TaskStatus.PAUSED, stopReason)
        this.reportMonitorFinished({ taskId, runId: task.activeRunId, status: 'CANCELLED', error: stopReason, completedAt: Date.now() })
        await this.taskManager.addTaskLog(taskId, `工作已终止：${stopReason}`, 'warning')
      } else if (task?.status === TaskStatus.PENDING) {
        await this.taskManager.updateTaskStatus(taskId, TaskStatus.PAUSED, stopReason)
      }
      return
    }
    active.control = 'cancel'
    active.controlReason = stopReason
    active.abortController?.abort()
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
    await Promise.all([active.worker.abort(), this.media?.stopTask(taskId), this.video?.stopTask(taskId)])
    await active.completion
  }

  async stopAll(): Promise<void> {
    if (this.lifecycleAuditTimer) clearInterval(this.lifecycleAuditTimer)
    this.lifecycleAuditTimer = null
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
      active.abortController?.abort()
      await this.enqueueEvent({
        taskId: active.taskId,
        runId: active.runId,
        subscriptionId: active.subscriptionId,
        sequence: 0,
        type: 'shutdown_requested',
        occurredAt: Date.now(),
        data: null,
      })
      await Promise.all([active.worker.abort(), this.media?.stopTask(active.taskId), this.video?.stopTask(active.taskId)])
      await active.completion
    }))])
    await this.conversationExecutor.disposeSessions()
  }

  respondToApproval(response: { requestId: string; approved: boolean; reason?: string }): boolean {
    return this.approvals.respond(response)
  }

  readonly requestMediaApproval = (input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>): Promise<boolean> => {
    return this.approvals.request(input)
  }

  private denyTaskApprovals(taskId: string, runId: string): void {
    this.approvals.denyRun(runId)
    for (const [nodeRunId, node] of this.nodeParticipations) {
      if (node.taskId === taskId && node.parentRunId === runId) this.approvals.denyRun(nodeRunId)
    }
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
            const error = runtimeFeedback(new Error('Selected employee is unavailable.')).message
            await cleanupRun(queued.taskId, queued.runId, [['reject-admission', () =>
              this.taskManager.settleTaskRun(queued.taskId, queued.runId, TaskStatus.FAILED, error)]])
            this.reportMonitorFinished({ taskId: queued.taskId, runId: queued.runId, status: 'FAILED', error, completedAt: Date.now() })
            const owner = this.taskManager.getCurrentUserScope()
            if (owner) this.notifyRunFailure(runtimeFailureEvent({ taskId: queued.taskId, runId: queued.runId, subscriptionId: queued.subscriptionId, owner }, new Error(error)))
            continue
          }
          const releaseWorkspace = this.locks.acquire(queued.runId, task.workDir)
          if (!releaseWorkspace) continue
          if (!this.admission.take(queued.runId)) {
            releaseWorkspace()
            continue
          }
          this.startingRuns.set(queued.taskId, queued.runId)
          void this.startRun(queued, task, releaseWorkspace)
        }
      } while (this.pumpRequested)
    } catch (error) {
      log.warn('task queue pump failed', { cause: redactText(error instanceof Error ? error.message : String(error)) })
    } finally {
      this.pumping = false
    }
  }

  private async startRun(
    queued: QueuedRun,
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    releaseWorkspace: () => void,
  ): Promise<void> {
    try {
      if (queued.arrangement && queued.arrangement.mode !== 'conversation') {
        await this.startArrangementRun(queued, task, releaseWorkspace)
        return
      }
      await this.conversationExecutor.execute(queued, task, releaseWorkspace)
    } catch (error) {
      log.warn('task run escaped its executor', { taskId: queued.taskId, runId: queued.runId,
        cause: redactText(error instanceof Error ? error.message : String(error)) })
    } finally {
      if (this.startingRuns.get(queued.taskId) === queued.runId) this.startingRuns.delete(queued.taskId)
      this.clearPendingFileTools(queued.taskId, queued.runId)
    }
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
          executionKind: 'arrangement',
          ...(queued.knowledge ? { knowledge: queued.knowledge } : {}),
        })
        parentCreated = true
      }
      arrangement = new ArrangementExecutor({
        createModelTrace: this.createModelTrace,
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
        media: this.media,
        video: this.video,
        arrangementMedia: this.arrangementMedia,
        knowledgeSearch: this.knowledgeSearch,
        attachmentInputs: this.attachmentInputs,
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
      this.reportMonitorStarted({ taskId, runId, startedAt: Date.now() })
      const result = await arrangement.execute(plan, taskId, runId)
      await this.events.drain(taskId)
      if (scope && this.arrangementCheckpointStore) await this.saveArrangementCheckpoint(scope, taskId, plan.planHash, null, result.state, runId)
      const arrangementOutput = this.arrangementOutput(plan, result.state)
      if (arrangementOutput) this.reportMonitorOutput({ taskId, runId, content: arrangementOutput, completeness: result.status === 'completed' ? 'complete' : 'partial' })
      const activeArrangement = this.activeArrangements.get(taskId)
      const control = activeArrangement?.runId === runId ? activeArrangement.control : 'none'
      const error = control === 'cancel' ? activeArrangement?.controlReason : result.error
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
          ? TaskStatus.PAUSED
          : control === 'interrupt'
            ? TaskStatus.INTERRUPTED
            : control === 'pause' || control === 'stop'
              ? TaskStatus.PAUSED
              : result.status === 'interrupted'
                ? TaskStatus.INTERRUPTED
                : result.status === 'stopped' || result.status === 'waiting-user'
                  ? TaskStatus.PAUSED
                  : result.status === 'completed'
                    ? TaskStatus.COMPLETED
                    : TaskStatus.FAILED
        await this.taskManager.settleTaskRun(taskId, runId, status, error)
        if (control === 'none' && error && scope && (outcome === 'failed' || result.state.nodes.some(node => node.status === 'failed'))) {
          this.notifyRunFailure(runtimeFailureEvent({ taskId, runId, subscriptionId: queued.subscriptionId, owner: scope }, new Error(error)))
        }
        this.reportMonitorFinished({ taskId, runId, status: outcome === 'cancelled' ? 'CANCELLED' : outcome === 'completed' ? 'COMPLETED' : outcome === 'failed' ? 'FAILED' : outcome === 'interrupted' ? 'INTERRUPTED' : 'PAUSED', error, completedAt: Date.now() })
      }
    } catch (error) {
      log.error('arrangement run failed', { taskId, runId, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
      const message = runtimeFeedback(error).message
      if (scope && this.arrangementCheckpointStore) {
        try {
          const checkpoint = await this.arrangementCheckpointStore.get(scope, taskId)
          if (checkpoint?.planHash === plan.planHash && (!checkpoint.activeRunId || checkpoint.activeRunId === runId)
            && (checkpoint.state.status === 'running' || checkpoint.state.status === 'queued')) {
            await this.saveArrangementCheckpoint(scope, taskId, plan.planHash, null,
              interruptArrangement(checkpoint.state, 'runtime-error'))
          }
        } catch (persistenceError) {
          log.warn('failed to persist arrangement interruption', { taskId, runId,
            cause: redactText(persistenceError instanceof Error ? persistenceError.message : String(persistenceError)) })
        }
      }
      await cleanupRun(taskId, runId, [['settle-failure', async () => {
        let status: typeof TaskStatus[keyof typeof TaskStatus] = TaskStatus.FAILED
        if (parentCreated && scope && this.taskRunStore) {
          await cleanupRun(taskId, runId, [['run-finish', () => this.taskRunStore!.finish(scope, taskId, runId, 'failed', message)]])
          const persisted = await this.taskRunStore.get(scope, taskId, runId).catch(() => null)
          if (persisted && persisted.outcome !== 'running') {
            status = persisted.outcome === 'completed' ? TaskStatus.COMPLETED
              : persisted.outcome === 'interrupted' ? TaskStatus.INTERRUPTED
                : persisted.outcome === 'stopped' || persisted.outcome === 'cancelled' ? TaskStatus.PAUSED : TaskStatus.FAILED
          }
        }
        await this.taskManager.settleTaskRun(taskId, runId, status, status === TaskStatus.FAILED ? message : undefined)
        const active = this.activeArrangements.get(taskId)
        if (status === TaskStatus.FAILED && active?.runId === runId && active.control === 'none' && scope) {
          this.notifyRunFailure(runtimeFailureEvent({ taskId, runId, subscriptionId: queued.subscriptionId, owner: scope }, new Error(message)))
        }
        this.reportMonitorFinished({ taskId, runId, status: status === TaskStatus.COMPLETED ? 'COMPLETED'
          : status === TaskStatus.INTERRUPTED ? 'INTERRUPTED' : status === TaskStatus.PAUSED ? 'PAUSED' : 'FAILED',
        error: status === TaskStatus.FAILED ? message : undefined, completedAt: Date.now() })
      }]])
    } finally {
      await cleanupRun(taskId, runId, [
        ['events', () => this.events.forgetRun(runId)],
        ['approvals', () => this.pendingArrangementApprovals.delete(runId)],
        ['nodes', () => {
          for (const [nodeRunId, node] of this.nodeParticipations) {
            if (node.taskId === taskId && node.parentRunId === runId) this.nodeParticipations.delete(nodeRunId)
          }
        }],
        ['registry', () => { if (this.activeArrangements.get(taskId)?.runId === runId) this.activeArrangements.delete(taskId) }],
        ['workspace', releaseWorkspace],
        ['completion', () => completion.settle()],
        ['queue', () => this.pump()],
      ])
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
      if (!nodeRun && this.nodeParticipations.get(event.runId)?.parentRunId !== arrangement.runId) return
    }
    const safeEvent = sanitizeRuntimeErrorEvent(event)
    if (safeEvent !== event) log.debug('model runtime diagnostic', { taskId: event.taskId, runId: event.runId, type: event.type, data: event.data })
    event = safeEvent
    const persistedEvent = scope && this.taskRunStore
      ? await this.taskRunStore.events.appendEvent(scope, event)
      : event

    if (arrangement && event.runId === arrangement.runId && ['arrangement_node_started', 'arrangement_node_completed', 'arrangement_node_failed'].includes(event.type)) {
      const data = event.data as Record<string, unknown> | null
      if (data) {
        const startedAt = typeof data.startedAt === 'string' && !Number.isNaN(Date.parse(data.startedAt))
        const parsed = startedAt ? monitorParticipationSchema.safeParse({ executionId: data.nodeRunId, subscriptionId: data.subscriptionId,
          nodeId: data.nodeId, title: data.title, modelId: data.modelId, status: data.status,
          startedAt: data.startedAt, completedAt: data.completedAt }) : null
        if (parsed?.success) {
          const participation = { ...parsed.data }
          if (participation.status === 'PAUSED' && (arrangement.control === 'cancel' || arrangement.control === 'stop')) participation.status = 'CANCELLED'
          this.nodeParticipations.set(participation.executionId, { taskId: event.taskId, parentRunId: arrangement.runId, participation })
          this.reportMonitorParticipation(persistedEvent, participation)
          if (event.type === 'arrangement_node_started' && typeof data.prompt === 'string') {
            this.reportMonitorInput({ taskId: event.taskId, runId: arrangement.runId, content: data.prompt, participation, occurredAt: event.occurredAt })
          }
          if (event.type !== 'arrangement_node_started' && typeof data.output === 'string') {
            this.reportMonitorOutput({ taskId: event.taskId, runId: arrangement.runId, content: data.output, participation, occurredAt: event.occurredAt })
          }
        }
      }
    }

    if (persistedEvent.type === 'text_delta') {
      const data = event.data as { text?: unknown }
      if (typeof data.text === 'string') this.events.appendResponse(persistedEvent.runId, data.text)
    }

    if (event.type === 'approval_requested' || event.type === 'approval_resolved') {
      const node = this.nodeParticipations.get(event.runId)
      if (node && node.parentRunId === arrangement?.runId) {
        const data = event.data as { requestId?: unknown } | null
        const requestId = typeof data?.requestId === 'string' && data.requestId.length > 0
          ? data.requestId
          : event.runId
        const pending = this.pendingArrangementApprovals.get(node.parentRunId) ?? new Set<string>()
        const wasWaiting = pending.size > 0
        if (event.type === 'approval_requested') pending.add(requestId)
        else pending.delete(requestId)
        const isWaiting = pending.size > 0
        if (isWaiting) this.pendingArrangementApprovals.set(node.parentRunId, pending)
        else this.pendingArrangementApprovals.delete(node.parentRunId)
        await this.taskManager.updateTaskStatus(event.taskId, isWaiting ? TaskStatus.WAITING_APPROVAL : TaskStatus.RUNNING)
        if (wasWaiting !== isWaiting) {
          this.reportMonitorParticipation({ ...persistedEvent, runId: node.parentRunId })
        }
      } else {
        await this.taskManager.updateTaskStatus(event.taskId,
          event.type === 'approval_requested' ? TaskStatus.WAITING_APPROVAL : TaskStatus.RUNNING)
      }
    } else if (event.type === 'tool_execution_start') {
      this.events.markResponseBoundary(persistedEvent.runId)
      const data = event.data as ToolExecutionData
      if (typeof data.toolId === 'string' && typeof data.toolName === 'string') {
        this.events.sideEffectStarted(event.runId, data.toolId, data.toolName, event.occurredAt)
        const filePath = isFileToolName(data.toolName) ? filePathFromInput(data.input) : null
        if (filePath) {
          const pending = this.pendingFileTools.get(event.runId) ?? {
            taskId: event.taskId,
            parentRunId: this.activeArrangements.get(event.taskId)?.runId ?? event.runId,
            files: new Map<string, string>(),
          }
          pending.files.set(data.toolId, filePath)
          this.pendingFileTools.set(event.runId, pending)
        }
      }
      await this.taskManager.addTaskLog(event.taskId, `Executing tool: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`)
    } else if (event.type === 'tool_execution_end') {
      const data = event.data as ToolExecutionData
      if (typeof data.toolId === 'string') this.events.sideEffectEnded(event.runId, data.toolId)
      const pending = this.pendingFileTools.get(event.runId)
      const filePath = typeof data.toolId === 'string' ? pending?.files.get(data.toolId) : undefined
      if (data.success === true && filePath) await this.taskManager.addTaskFile(event.taskId, filePath)
      if (typeof data.toolId === 'string') pending?.files.delete(data.toolId)
      if (pending?.files.size === 0) this.pendingFileTools.delete(event.runId)
      await this.taskManager.addTaskLog(event.taskId, `${data.success === false ? 'Tool failed' : 'Tool completed'}: ${typeof data.toolName === 'string' ? data.toolName : 'unknown'}`, data.success === false ? 'warning' : 'info')
    } else if (event.type === 'auto_retry_start') {
      const data = event.data as { attempt?: number; maxAttempts?: number; delayMs?: number; error?: string }
      const reason = typeof data.error === 'string' ? redactText(data.error) : '网关未返回错误详情'
      await this.taskManager.addTaskLog(event.taskId, `自动重试 ${data.attempt ?? '?'} / ${data.maxAttempts ?? '?'}，等待 ${data.delayMs ?? 0} ms：${reason}`, 'warning')
    } else if (event.type === 'retry_budget_exhausted') {
      await this.taskManager.addTaskLog(event.taskId, '本轮自动重试达到上限，已停止执行。', 'error')
    }
    if (event.type === 'approval_requested' || event.type === 'approval_resolved') {
      const node = this.nodeParticipations.get(event.runId)
      if (node && node.parentRunId === arrangement?.runId) {
        this.reportMonitorParticipation({ ...persistedEvent, runId: node.parentRunId }, { ...node.participation,
          status: event.type === 'approval_requested' ? 'WAITING_APPROVAL' : 'RUNNING' })
      } else if (!arrangement) this.reportMonitorParticipation(persistedEvent)
    }
    if (shouldPushTaskEvent(persistedEvent)) this.onEvent(persistedEvent)
  }

  private reportMonitorQueued(input: MonitorTaskQueuedInput): void {
    void this.monitor.taskQueued({ ...input, protocolVersion: 2, queuedAt: Date.now(),
      participation: input.participation ?? (input.taskType === 'conversation' ? {
        executionId: input.runId, subscriptionId: input.subscriptionId, title: input.title, modelId: input.modelId,
      } : undefined) }).catch(() => {
      log.warn('client monitor queued report failed', { taskId: input.taskId, runId: input.runId })
    })
  }

  private reportMonitorParticipation(event: TaskExecutionEvent, participation?: MonitorParticipation): void {
    void this.monitor.taskEvent(event, participation).catch(() => {
      log.warn('client monitor participation report failed', { taskId: event.taskId, runId: event.runId })
    })
  }

  private arrangementOutput(plan: { nodes: readonly { id: string }[] }, state: ArrangementExecutionState): string | null {
    const outputs = plan.nodes
      .map(node => state.nodes.find(checkpoint => checkpoint.nodeId === node.id)?.output?.trim() ?? '')
      .filter(Boolean)
    return outputs.length > 0 ? outputs.join('\n\n') : null
  }

  private reportMonitorInput(input: MonitorTaskContentInput): void {
    void this.monitor.taskInput({ ...input, messageId: input.messageId ?? (input.participation?.nodeId
      ? `${input.runId}:${input.participation.executionId}:user_input` : `${input.runId}-user`) }).catch(() => {
      log.warn('client monitor input report failed', { taskId: input.taskId, runId: input.runId })
    })
  }

  private reportMonitorOutput(input: MonitorTaskContentInput): void {
    void this.monitor.taskOutput({ ...input, messageId: input.messageId ?? (input.participation?.nodeId
      ? `${input.runId}:${input.participation.executionId}:model_output` : `${input.runId}-assistant`) }).catch(() => {
      log.warn('client monitor output report failed', { taskId: input.taskId, runId: input.runId })
    })
  }

  private reportMonitorStarted(input: MonitorTaskStartedInput): void {
    void this.monitor.taskStarted(input).catch(() => {
      log.warn('client monitor started report failed', { taskId: input.taskId, runId: input.runId })
    })
  }

  private notifyRunFailure(event: TaskExecutionEvent): void {
    const notice = runtimeFailureNoticeSchema.safeParse(event.data)
    const scope = this.taskManager.getCurrentUserScope()
    if (!notice.success || !scope || notice.data.owner.memberId !== scope.memberId || notice.data.owner.enterpriseId !== scope.enterpriseId) return
    try { this.onEvent(event) } catch {
      log.warn('runtime failure notification could not be delivered', { taskId: event.taskId, runId: event.runId })
    }
  }

  private reportMonitorFinished(input: MonitorTaskFinishedInput): void {
    void this.monitor.taskFinished(input).catch(() => {
      log.warn('client monitor finished report failed', { taskId: input.taskId, runId: input.runId })
    })
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

  private clearPendingFileTools(taskId: string, parentRunId: string): void {
    for (const [runId, pending] of this.pendingFileTools) {
      if (pending.taskId === taskId && pending.parentRunId === parentRunId) this.pendingFileTools.delete(runId)
    }
  }

}
