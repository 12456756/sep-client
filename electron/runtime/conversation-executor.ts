/**
 * 对话式任务的运行适配器。
 *
 * 一个 task 对应一份对话消息和一个可复用的 Pi session；每轮仍创建独立 run，
 * 通过 sessionAdapter 复用 task 级会话，因此切换员工不会把上下文拆成员工私有会话。
 * 入队、工作目录锁和 IPC 推送由 TaskRuntime 负责，本类只处理会话恢复、worker 生命周期
 * 以及对话消息落盘。
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TaskStatus } from '../../src/shared/types'
import { ConversationContextStore, type ConversationMessage } from '../domain/conversation-context'
import type { TaskRunStorePort } from '../data/task-run-store'
import type { TaskManager } from './task-manager'
import type { SharedPiSession } from '../pi/sdk/pi-shared-session'
import { createDefaultSharedPiSession, type PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import { ConversationRecoveryError } from './conversation-recovery-error'
import type { ActiveRun, EmployeeRuntimeConfig, QueuedRun, SessionRecoveryMode, TaskWorkerPort } from './run-types'
import { createRunCompletion, type WorkerRegistry } from './run-workers'
import type { EventPipeline } from './run-events'
import type { ToolApprovals } from './run-approvals'
import { logger } from '../common/logger'

const log = logger.child('conversation-executor')

export interface ConversationExecutorOptions {
  taskManager: TaskManager
  taskRunStore: TaskRunStorePort | null
  createWorker: (options: PiTaskWorkerOptions) => TaskWorkerPort
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  authorizeEmployee: (subscriptionId: string) => Promise<EmployeeRuntimeConfig | null>
  workspaceRoot: () => string
  approvals: Pick<ToolApprovals, 'request'>
  events: Pick<EventPipeline, 'drain' | 'enqueue' | 'forgetRun' | 'pendingSideEffects' | 'takeResponse'>
  workers: Pick<WorkerRegistry, 'forget' | 'isCurrent' | 'register'>
  enqueue: (queued: QueuedRun) => void
  requestPump: () => void
}

export class ConversationExecutor {
  private readonly conversationStores = new Map<string, ConversationContextStore>()
  private readonly conversationAdapters = new Map<string, SharedPiSession>()

  constructor(private readonly options: ConversationExecutorOptions) {}

  async continue(
    taskId: string,
    prompt: string,
    recovery: { mode?: SessionRecoveryMode; confirmed?: boolean } = {},
  ): Promise<void> {
    await this.continueAs(taskId, prompt, undefined, recovery)
  }

  async switchEmployee(taskId: string, subscriptionId: string): Promise<void> {
    const task = await this.options.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (!await this.options.authorizeEmployee(subscriptionId)) {
      throw new Error('The selected employee is no longer available.')
    }
    await this.options.taskManager.setTaskEmployee(taskId, subscriptionId)
    const scope = this.options.taskManager.getCurrentUserScope()
    if (scope) await this.conversationAdapter(scope, taskId).reset()
  }

  async execute(
    queued: QueuedRun,
    task: NonNullable<Awaited<ReturnType<TaskManager['getTask']>>>,
    releaseWorkspace: () => void,
  ): Promise<void> {
    const taskId = queued.taskId
    const runId = queued.runId
    const scope = this.options.taskManager.getCurrentUserScope()
    const employee = queued.employee
    const completion = createRunCompletion()
    let worker: TaskWorkerPort | null = null
    let active: ActiveRun | null = null
    let runCreated = false

    try {
      const runPaths = scope && this.options.taskRunStore
        ? this.options.taskRunStore.getPaths(scope, taskId, runId)
        : null
      const conversationPaths = queued.conversation && scope && this.options.taskRunStore
        ? this.options.taskRunStore.getConversationSessionPaths(scope, taskId)
        : null
      worker = this.options.createWorker({
        context: {
          taskId,
          runId,
          subscriptionId: queued.subscriptionId,
          modelId: employee.modelId,
          gatewayUrl: employee.gatewayUrl,
          workspaceDir: task.workDir ?? this.options.workspaceRoot(),
          agentDir: conversationPaths?.agentDir ?? runPaths?.agentDir ?? `${this.options.workspaceRoot()}/.pi-runs/${runId}`,
          sessionDir: conversationPaths?.sessionDir ?? runPaths?.sessionDir ?? `${this.options.workspaceRoot()}/.pi-sessions/${runId}`,
          resumeSessionFile: queued.resumeSessionFile,
          additionalSkillPaths: employee.additionalSkillPaths,
        },
        getRefreshToken: this.options.getRefreshToken,
        onAuthenticationRequired: this.options.onAuthenticationRequired,
        onApprovalRequest: request => this.options.approvals.request(request),
        onEvent: event => this.options.events.enqueue(event),
        onSessionCreated: async session => {
          if (!scope || !this.options.taskRunStore) return
          await this.options.taskRunStore.setSession(scope, taskId, runId, session)
          if (queued.conversation) {
            await this.conversationStore(scope, taskId).setSharedSession({
              sessionId: session.sessionId,
              sessionFile: session.sessionFile,
              lastRunId: runId,
              updatedAt: Date.now(),
            })
          }
        },
        sessionAdapter: queued.conversation && scope ? this.conversationAdapter(scope, taskId) : undefined,
      })
      active = {
        taskId,
        runId,
        subscriptionId: queued.subscriptionId,
        releaseWorkspace,
        worker,
        control: 'none',
        completion: completion.promise,
      }
      this.options.workers.register(active)

      if (scope && this.options.taskRunStore) {
        await this.options.taskRunStore.create(scope, {
          taskId,
          runId,
          subscriptionId: queued.subscriptionId,
          modelId: employee.modelId,
          runtimeKey: `${queued.subscriptionId}:${employee.modelId}`,
          workspaceDir: task.workDir ?? this.options.workspaceRoot(),
          prompt: queued.prompt,
        })
        runCreated = true
        if (queued.conversation) {
          await this.conversationStore(scope, taskId).appendMessage(
            this.userMessage(taskId, runId, queued.subscriptionId, employee.modelId, queued.prompt),
          )
        }
        if (queued.degradedRecovery) {
          await this.options.events.enqueue({
            taskId,
            runId,
            subscriptionId: queued.subscriptionId,
            sequence: 0,
            type: 'recovery_started',
            occurredAt: Date.now(),
            data: { ...queued.degradedRecovery, degradedRecovery: true, replayedTools: false },
          })
        }
      }

      await this.options.taskManager.updateTaskStatus(taskId, TaskStatus.RUNNING)
      await worker.run(queued.workerPrompt ?? queued.prompt)
      await this.options.events.drain(taskId)
      if (!this.options.workers.isCurrent(active)) return
      await this.finalize(active, queued, scope, runCreated)
    } catch (error) {
      log.error('conversation run failed', {
        taskId,
        runId,
        subscriptionId: queued.subscriptionId,
        modelId: employee.modelId,
        control: active?.control ?? 'none',
        stage: active ? 'run' : 'setup',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      if (active) {
        await this.finalize(active, queued, scope, runCreated, error)
      } else {
        await this.options.taskManager
          .settleTaskRun(taskId, runId, TaskStatus.FAILED, 'The conversation could not be started.')
          .catch(() => undefined)
      }
    } finally {
      this.options.events.forgetRun(runId)
      await worker?.dispose().catch(() => undefined)
      releaseWorkspace()
      if (active) this.options.workers.forget(active)
      const currentTask = await this.options.taskManager.getTask(taskId).catch(() => null)
      if (currentTask?.activeRunId === runId) {
        await this.options.taskManager.clearTaskRun(taskId, runId).catch(() => undefined)
      }
      completion.settle()
      this.options.requestPump()
    }
  }

  async disposeSessions(): Promise<void> {
    await Promise.all([...this.conversationAdapters.values()].map(adapter => adapter.dispose()))
    this.conversationAdapters.clear()
  }

  private async continueAs(
    taskId: string,
    prompt: string,
    employeeOverride: string | undefined,
    recovery: { mode?: SessionRecoveryMode; confirmed?: boolean },
  ): Promise<void> {
    const task = await this.options.taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (!prompt.trim()) throw new Error('A message is required.')
    const employeeId = employeeOverride ?? task.subscriptionId
    if (!employeeId) throw new Error('The selected employee is no longer available.')
    const employee = await this.options.authorizeEmployee(employeeId)
    if (!employee) throw new Error('The selected employee is no longer available.')
    const scope = this.options.taskManager.getCurrentUserScope()
    if (!scope || !this.options.taskRunStore) throw new Error('Conversation storage is unavailable.')

    const contextStore = this.conversationStore(scope, taskId)
    const sharedSession = await contextStore.getSharedSession()
    if (!sharedSession?.sessionFile) throw new Error('No resumable Pi session is available for this conversation.')

    let resumeSessionFile: string | undefined = sharedSession.sessionFile
    let degradedRecovery: QueuedRun['degradedRecovery']
    let workerPrompt: string | undefined
    if (!await this.isReadableSessionFile(sharedSession.sessionFile)) {
      const mode = recovery.mode ?? 'confirm_rebuild'
      if (mode === 'strict') {
        throw new ConversationRecoveryError('SESSION_UNRECOVERABLE', 'The Pi session file cannot be read.')
      }
      if (mode === 'confirm_rebuild' && recovery.confirmed !== true) {
        throw new ConversationRecoveryError('RECOVERY_CONFIRMATION_REQUIRED', 'Confirm rebuilding the damaged Pi session from task history.')
      }
      degradedRecovery = { originalSessionFile: sharedSession.sessionFile, mode }
      workerPrompt = this.buildRecoveryPrompt(await contextStore.listMessages(), prompt.trim())
      resumeSessionFile = undefined
      await this.replaceConversationAdapter(scope, taskId)
    }

    if (task.status !== TaskStatus.PENDING) await this.options.taskManager.updateTaskStatus(taskId, TaskStatus.PENDING)
    if (employeeId !== task.subscriptionId) {
      await this.options.taskManager.setTaskEmployee(taskId, employeeId)
      await this.conversationAdapter(scope, taskId).reset()
    }
    const runId = randomUUID()
    await this.options.taskManager.admitTask(taskId, runId)
    const admittedTask = await this.options.taskManager.getTask(taskId)
    if (!admittedTask || admittedTask.activeRunId !== runId) return
    const queued: QueuedRun = {
      taskId,
      runId,
      subscriptionId: employeeId,
      employee,
      prompt: prompt.trim(),
      conversation: true,
      resumeSessionFile,
      workerPrompt,
      degradedRecovery,
    }
    this.options.enqueue(queued)
    this.options.requestPump()
  }

  private async finalize(
    active: ActiveRun,
    queued: QueuedRun,
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
      for (const [toolId, tool] of this.options.events.pendingSideEffects(active.runId)) {
        await this.options.events.enqueue({
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
        await this.options.events.enqueue({
          taskId: active.taskId,
          runId: active.runId,
          subscriptionId: active.subscriptionId,
          sequence: 0,
          type: outcome === 'completed' ? 'recovery_finished' : 'recovery_failed',
          occurredAt: Date.now(),
          data: { degradedRecovery: true, replayedTools: false, error },
        })
      }
      await this.options.events.enqueue({
        taskId: active.taskId,
        runId: active.runId,
        subscriptionId: active.subscriptionId,
        sequence: 0,
        type: `run_${outcome}`,
        occurredAt: Date.now(),
        data: error ? { error } : null,
      })
    }
    const response = this.options.events.takeResponse(active.runId)
    if (response && scope && queued.conversation) {
      await this.conversationStore(scope, active.taskId).appendMessage({
        id: `${active.runId}-assistant`,
        taskId: active.taskId,
        turnId: active.runId,
        runId: active.runId,
        subscriptionId: active.subscriptionId,
        modelId: queued.employee.modelId,
        role: 'assistant',
        content: response,
        createdAt: Date.now(),
      })
    }
    if (runCreated && scope && this.options.taskRunStore) {
      await this.options.taskRunStore.finish(scope, active.taskId, active.runId, outcome, error)
    }
    if (this.options.workers.isCurrent(active)) {
      const nextStatus = active.control === 'interrupt'
        ? TaskStatus.INTERRUPTED
        : active.control === 'pause'
          ? TaskStatus.PAUSED
          : failure && active.control !== 'cancel'
            ? TaskStatus.FAILED
            : queued.conversation ? TaskStatus.PENDING : TaskStatus.COMPLETED
      await this.options.taskManager.settleTaskRun(active.taskId, active.runId, nextStatus, error)
    }
  }

  private conversationStore(scope: { memberId: string; enterpriseId: string }, taskId: string): ConversationContextStore {
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    let store = this.conversationStores.get(key)
    if (!store && this.options.taskRunStore) {
      store = new ConversationContextStore(this.options.taskRunStore.getTaskDir(scope, taskId))
      this.conversationStores.set(key, store)
    }
    if (!store) throw new Error('Conversation storage is unavailable.')
    return store
  }

  private userMessage(taskId: string, runId: string, subscriptionId: string, modelId: string, content: string): ConversationMessage {
    return { id: `${runId}-user`, taskId, turnId: runId, runId, subscriptionId, modelId, role: 'user', content, createdAt: Date.now() }
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

  private async replaceConversationAdapter(scope: { memberId: string; enterpriseId: string }, taskId: string): Promise<void> {
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    const adapter = this.conversationAdapters.get(key)
    if (adapter) await adapter.dispose()
    this.conversationAdapters.delete(key)
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
      'The previous Pi session file is unavailable. Continue from the persisted conversation transcript below.',
      'The transcript contains messages only. Do not infer, repeat, or replay tool operations from it.',
      transcript,
      `NEW USER MESSAGE:\n${prompt}`,
    ].filter(Boolean).join('\n\n')
  }
}


