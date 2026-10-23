import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import type {
  ClientTask,
  ClientTaskLogLevel,
  ClientTaskStats,
  ClientTaskStatus,
} from '../../src/shared/types'
import { TaskStatus } from '../../src/shared/types'
import { TaskPersistenceError, TaskStore, type TaskStorePort } from '../data/task-store'
import { ScopePath, TaskScopeError, type TaskOwnerScope, type WorkspaceDirectoryNames } from '../data/scope-path'
import { WorkspaceDirectoryStore } from '../data/workspace-directory-store'
import { TaskRunStore, type TaskRunStorePort } from '../data/task-run-store'
import { ArrangementCheckpointStore, type ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import { MediaStore } from '../data/media-store'
import { interruptArrangement } from '../domain/arrangement-execution'
import { classifyTaskLifecycle, type TaskLifecycleFinding, type TaskLifecycleRuntimeEvidence } from '../domain/task-lifecycle'
import {
  assertTaskTransition,
  canTransitionTask,
  TaskAdmissionError,
  isTaskExecutionStatus,
  isTaskTerminal,
} from '../domain/task-state-machine'
import { describeError } from '../common/redact'
import { logger } from '../common/logger'
import { silentTaskNotifier, type TaskNotifier } from './task-notifier'

const log = logger.child('task-manager')

export { TaskStatus } from '../../src/shared/types'
export { TaskPersistenceError } from '../data/task-store'
export { TaskScopeError } from '../data/scope-path'
export { TaskAdmissionError, InvalidTaskTransitionError } from '../domain/task-state-machine'
export type { ClientTask as Task, ClientTaskLog as TaskLog } from '../../src/shared/types'

export interface TaskLifecycleAuditFinding {
  taskId: string
  taskStatus: ClientTaskStatus
  activeRunId: string | null
  finding: TaskLifecycleFinding
  reconciled: boolean
}

export interface TaskLifecycleAuditResult {
  scanned: number
  limit: number
  findings: TaskLifecycleAuditFinding[]
  reconciled: number
}

type Task = ClientTask

function cloneTask(task: Task): Task {
  return { ...task, files: [...task.files], logs: task.logs.map(log => ({ ...log })) }
}

function cloneTasks(tasks: Map<string, Task>): Map<string, Task> {
  return new Map(Array.from(tasks.entries(), ([id, task]) => [id, cloneTask(task)]))
}

export class TaskManager {
  private readonly paths: ScopePath
  private readonly workspaceDirectories: WorkspaceDirectoryStore
  private currentWorkspaceNames: WorkspaceDirectoryNames | undefined
  private tasks = new Map<string, Task>()
  /** Cached from the existing durable archive markers, scoped to the current owner. */
  private readonly hiddenTaskIds = new Set<string>()
  private readonly notifier: TaskNotifier
  private currentUser: TaskOwnerScope | null = null
  private initialized = false
  private initializing: Promise<void> | null = null
  private persistenceDegraded = false
  private readonly store: TaskStorePort
  private readonly runStore: TaskRunStorePort
  private mutationChain: Promise<void> = Promise.resolve()
  /**
   * scope 世代号。每次切换或清空当前用户都 +1，在途的 commit 靠它判断自己是否已经
   * 属于上一个 scope（C8）。clearCurrentUser 是同步的，所以世代号也必须同步递增。
   */
  private generation = 0
  private lifecycleAuditCursor = 0
  private readonly lifecycleMissingSince = new Map<string, { runId: string | null; since: number }>()

  constructor(
    userDataDir: string,
    notifier: TaskNotifier | null = null,
    store: TaskStorePort = new TaskStore(userDataDir),
    runStore: TaskRunStorePort = new TaskRunStore(userDataDir),
    private readonly checkpoints: ArrangementCheckpointStorePort = new ArrangementCheckpointStore(userDataDir),
    private readonly mediaArchive: Pick<MediaStore, 'isArchived'> = new MediaStore(userDataDir),
  ) {
    this.paths = new ScopePath(userDataDir)
    this.workspaceDirectories = new WorkspaceDirectoryStore(userDataDir)
    this.notifier = notifier ?? silentTaskNotifier
    this.store = store
    this.runStore = runStore
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.initializing) {
      this.initializing = this.store.initialize().then(() => {
        this.initialized = true
      })
    }
    await this.initializing
  }

  async setCurrentUser(memberId: string, enterpriseId: string, workspaceNames?: WorkspaceDirectoryNames): Promise<void> {
    await this.ensureInitialized()
    const scope = { memberId, enterpriseId }
    this.validateScope(scope)

    // C8：scope 切换必须与 commit 共用同一条串行链。原来它直接改 currentUser 与 tasks，
    // 在途的 commit 恢复执行后会拿新 scope 的 tasks 去覆盖旧 scope 的文件
    // ——旧 scope 的数据被写成新 scope 的内容，新 scope 的内存状态又被回滚。
    await this.serialize(async () => {
      this.generation += 1
      const generation = this.generation
      this.currentUser = null
      this.currentWorkspaceNames = undefined
      this.tasks.clear()
      this.hiddenTaskIds.clear()
      this.lifecycleMissingSince.clear()
      this.notifyTaskListUpdate()

      const loadedTasks = (await this.store.load(scope)).map(cloneTask)
      const archived = await Promise.all(loadedTasks.map(async task => {
        try {
          return await this.mediaArchive.isArchived(scope, task.id) ? task.id : null
        } catch (error) {
          // An unreadable deletion marker must not republish a possibly deleted record.
          log.warn('task archive visibility unavailable', { taskId: task.id, cause: describeError(error) })
          return task.id
        }
      }))
      if (this.generation !== generation) throw new TaskScopeError('Task scope changed while loading record visibility.')
      for (const id of archived) if (id !== null) this.hiddenTaskIds.add(id)
      const interruptedRuns = new Map<string, string>()
      let recovered = false
      for (const task of loadedTasks) {
        const pausedWithActiveRun = task.status === TaskStatus.PAUSED && task.activeRunId !== null
        if (
          task.status !== TaskStatus.RUNNING &&
          task.status !== TaskStatus.WAITING_APPROVAL &&
          !(task.status === TaskStatus.PENDING && task.activeRunId) &&
          !pausedWithActiveRun
        ) continue
        if (!pausedWithActiveRun) assertTaskTransition(task.status, TaskStatus.INTERRUPTED)
        if (task.activeRunId) interruptedRuns.set(task.id, task.activeRunId)
        task.lastRunId = task.activeRunId
        task.lastRunStartedAt = task.currentRunStartedAt ??
          (task.status === TaskStatus.RUNNING || task.status === TaskStatus.WAITING_APPROVAL ? task.startedAt : null)
        task.lastRunEndedAt = Date.now()
        task.currentRunStartedAt = null
        task.queuedAt = null
        if (!pausedWithActiveRun) task.status = TaskStatus.INTERRUPTED
        task.stateRevision = (task.stateRevision ?? 0) + 1
        task.activeRunId = null
        const recoveryMessage = pausedWithActiveRun
          ? 'Previous session ended; paused task run was detached.'
          : 'Previous session ended; task interrupted.'
        if (!task.logs.some(log => log.message === recoveryMessage)) {
          task.logs.push({ timestamp: Date.now(), message: recoveryMessage, level: 'warning' })
        }
        recovered = true
      }

      this.currentUser = scope
      this.currentWorkspaceNames = workspaceNames ? { ...workspaceNames } : undefined
      this.tasks = new Map(loadedTasks.map(task => [task.id, task]))
      this.persistenceDegraded = false

      for (const task of loadedTasks) {
        if (task.status !== TaskStatus.INTERRUPTED && !interruptedRuns.has(task.id)) continue
        try {
          const checkpoint = await this.checkpoints.get(scope, task.id)
          if (!checkpoint) continue
          const terminal = checkpoint.state.status === 'completed' || checkpoint.state.status === 'stopped'
          if (!checkpoint.activeRunId && !terminal) continue
          const previousRunId = interruptedRuns.get(task.id)
          if (previousRunId && checkpoint.activeRunId && checkpoint.activeRunId !== previousRunId) {
            throw new TaskPersistenceError('Arrangement checkpoint belongs to a different run.')
          }
          // Also repair tasks already saved as interrupted by an earlier startup.
          if (!previousRunId && checkpoint.activeRunId) {
            const run = await this.runStore.get(scope, task.id, checkpoint.activeRunId)
            if (!run || !['running', 'interrupted', ...(terminal ? ['completed', 'stopped', 'cancelled'] : [])].includes(run.outcome)) {
              throw new TaskPersistenceError('Arrangement run interruption cannot be verified.')
            }
          }
          if (terminal) {
            const runId = previousRunId ?? checkpoint.activeRunId
            if (runId) await this.runStore.finish(scope, task.id, runId, checkpoint.state.status === 'completed' ? 'completed' : 'stopped')
          }
          await this.checkpoints.save(scope, {
            ...checkpoint,
            activeRunId: null,
            state: interruptArrangement(checkpoint.state, 'client-crash'),
            updatedAt: Date.now(),
          })
          if (terminal) {
            task.status = checkpoint.state.status === 'completed' ? TaskStatus.COMPLETED : TaskStatus.PAUSED
            task.completedAt = task.status === TaskStatus.COMPLETED ? checkpoint.updatedAt : null
            task.error = null
            recovered = true
          }
        } catch (error) {
          this.persistenceDegraded = true
          log.warn('failed to recover arrangement checkpoint', { taskId: task.id, cause: describeError(error) })
        }
      }

      try {
        await this.runStore.markActiveRunsInterrupted(scope)
      } catch (error) {
        this.persistenceDegraded = true
        log.warn('failed to recover persisted task runs', { cause: describeError(error) })
      }

      if (recovered) {
        try {
          await this.store.save(scope, loadedTasks)
        } catch (error) {
          this.persistenceDegraded = true
          log.warn('failed to persist recovered tasks', { cause: describeError(error) })
        }
      }
    })
    this.notifyTaskListUpdate()
  }

  clearCurrentUser(): void {
    this.generation += 1
    this.currentUser = null
    this.currentWorkspaceNames = undefined
    this.tasks.clear()
    this.hiddenTaskIds.clear()
    this.lifecycleMissingSince.clear()
    this.persistenceDegraded = false
    this.notifyTaskListUpdate()
  }

  hasCurrentUser(): boolean {
    return this.currentUser !== null
  }

  getCurrentUserScope(): TaskOwnerScope | null {
    return this.currentUser ? { ...this.currentUser } : null
  }

  /** Bounded, scope-local inspection of current admissions and execution snapshots. */
  async auditTaskLifecycles(options: {
    runtime?: (taskId: string) => TaskLifecycleRuntimeEvidence | null
    limit?: number
    now?: number
    missingGraceMs?: number
    reconcile?: boolean
    budgetMs?: number
  } = {}): Promise<TaskLifecycleAuditResult> {
    const scope = await this.requireCurrentUser()
    const generation = this.generation
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.floor(options.limit!))) : 50
    const started = performance.now()
    const budgetMs = Number.isFinite(options.budgetMs) ? Math.max(1, Math.min(2_000, options.budgetMs!)) : 2_000
    const now = options.now ?? Date.now()
    const missingGraceMs = Math.max(0, options.missingGraceMs ?? 60_000)
    const candidates = Array.from(this.tasks.values()).filter(task =>
      task.activeRunId !== null || isTaskExecutionStatus(task.status) || task.status === TaskStatus.PENDING)
    const count = Math.min(limit, candidates.length)
    const selected = Array.from({ length: count }, (_, index) => candidates[(this.lifecycleAuditCursor + index) % candidates.length]!)
    const findings: TaskLifecycleAuditFinding[] = []
    let reconciled = 0

    for (const snapshot of selected) {
      if (this.generation !== generation || this.currentUser !== scope || performance.now() - started >= budgetMs) break
      this.lifecycleAuditCursor = (this.lifecycleAuditCursor + 1) % candidates.length
      const task = cloneTask(snapshot)
      const activeRunId = task.activeRunId
      const [run, checkpoint] = await Promise.all([
        activeRunId ? this.runStore.get(scope, task.id, activeRunId) : Promise.resolve(null),
        this.checkpoints.get(scope, task.id, { readOnly: true }),
      ])
      if (this.generation !== generation || this.currentUser !== scope) break
      const runtime = options.runtime?.(task.id) ?? null
      const ownsCurrentRun = runtime !== null && runtime.runId === activeRunId
      if (ownsCurrentRun || !activeRunId && !isTaskExecutionStatus(task.status)) this.lifecycleMissingSince.delete(task.id)
      let missingForMs: number | null = null
      if (options.runtime !== undefined && !ownsCurrentRun && (activeRunId !== null || isTaskExecutionStatus(task.status))) {
        const previous = this.lifecycleMissingSince.get(task.id)
        if (!previous || previous.runId !== activeRunId || now < previous.since) {
          this.lifecycleMissingSince.set(task.id, { runId: activeRunId, since: now })
          missingForMs = 0
        } else {
          missingForMs = Math.max(0, now - previous.since)
        }
      }
      const classified = classifyTaskLifecycle({
        task, runtime,
        run,
        checkpoint: checkpoint ? { activeRunId: checkpoint.activeRunId, lastRunId: checkpoint.lastRunId ?? null,
          status: checkpoint.state.status, updatedAt: checkpoint.updatedAt } : null,
        missingForMs,
        missingGraceMs,
      })
      let didReconcile = false
      if (options.reconcile && options.runtime && run && classified.kind === 'terminal-evidence') {
        didReconcile = await this.reconcileTaskLifecycle({
          scope, generation, taskId: task.id, expectedRunId: task.activeRunId, expectedRevision: task.stateRevision ?? 0,
          expectedStatus: task.status, targetStatus: classified.targetStatus, endedAt: classified.endedAt,
          startedAt: classified.startedAt, runtime: options.runtime,
          error: classified.targetStatus === TaskStatus.FAILED ? describeError(run.error ?? 'The task run failed.') : undefined,
        })
        if (didReconcile) reconciled++
      }
      findings.push({ taskId: task.id, taskStatus: task.status, activeRunId, finding: classified, reconciled: didReconcile })
    }
    return { scanned: findings.length, limit, findings, reconciled }
  }

  isPersistenceDegraded(): boolean {
    return this.persistenceDegraded
  }

  async recoverPersistence(): Promise<void> {
    const scope = await this.requireCurrentUser()
    await this.setCurrentUser(scope.memberId, scope.enterpriseId, this.currentWorkspaceNames)
    if (this.persistenceDegraded) throw new TaskPersistenceError('Task history recovery did not complete.')
  }

  async prepareDirectorySelection(currentPath?: string): Promise<string> {
    const scope = await this.requireCurrentUser()
    const generation = this.generation
    this.assertCurrentScope(scope, generation)
    const chosen = currentPath?.trim()
    if (chosen && await stat(chosen).then(info => info.isDirectory(), () => false)) {
      this.assertCurrentScope(scope, generation)
      return chosen
    }
    this.assertCurrentScope(scope, generation)
    const names = await this.workspaceDirectories.resolve(scope, this.currentWorkspaceNames)
    this.assertCurrentScope(scope, generation)
    const defaultPath = this.paths.defaultWorkspaceRoot(scope, names)
    await mkdir(defaultPath, { recursive: true })
    this.assertCurrentScope(scope, generation)
    return defaultPath
  }

  async createTask(
    title: string,
    prompt: string,
    workDir?: string,
    subscriptionId: string | null = null,
  ): Promise<Task> {
    const user = await this.requireCurrentUser()
    const generation = this.generation
    this.assertCurrentScope(user, generation)
    const id = randomUUID()
    const names = workDir?.trim() ? undefined : await this.workspaceDirectories.resolve(user, this.currentWorkspaceNames)
    this.assertCurrentScope(user, generation)
    const resolvedWorkDir = workDir?.trim() || this.paths.defaultWorkspaceDir(user, id, names)
    await mkdir(resolvedWorkDir, { recursive: true })
    const task: Task = {
      id, title, prompt, status: TaskStatus.PENDING, workDir: resolvedWorkDir,
      createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [],
      ownerId: user.memberId, ownerEnterpriseId: user.enterpriseId,
      subscriptionId, activeRunId: null,
    }
    try {
      await this.commit(nextTasks => nextTasks.set(task.id, task), generation)
    } catch (error) {
      if (!workDir?.trim()) await rm(resolvedWorkDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    this.notifyTaskUpdate(task.id)
    return cloneTask(task)
  }

  async admitTask(taskId: string, runId: string): Promise<void> {
    await this.requireTask(taskId)
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) throw new TaskScopeError('Task not found.')
      if (nextTask.activeRunId) throw new TaskAdmissionError()
      if (nextTask.status !== TaskStatus.PENDING) {
        throw new TaskAdmissionError(`Task cannot be admitted while it is ${nextTask.status}.`)
      }
      nextTask.executionHealth = undefined
      nextTask.startFailureAt = null
      nextTask.error = null
      nextTask.activeRunId = runId
      nextTask.queuedAt = Date.now()
      nextTask.currentRunStartedAt = null
    })
    this.notifyTaskUpdate(taskId)
  }

  /** Records a failure before admission without pretending that a run executed. */
  async recordStartFailure(taskId: string, error: string): Promise<boolean> {
    await this.requireTask(taskId)
    const safeError = describeError(error)
    let changed = false
    await this.commit(nextTasks => {
      const task = nextTasks.get(taskId)
      if (!task || task.status !== TaskStatus.PENDING || task.activeRunId !== null) return
      task.executionHealth = 'start-failed'
      task.startFailureAt = Date.now()
      task.error = safeError
      task.logs.push({ timestamp: task.startFailureAt, message: `启动失败：${safeError}`, level: 'error' })
      changed = true
    })
    if (changed) this.notifyTaskUpdate(taskId)
    return changed
  }

  async setTaskEmployee(taskId: string, subscriptionId: string): Promise<Task> {
    await this.requireTask(taskId)
    await this.commit(nextTasks => {
      const task = nextTasks.get(taskId)
      if (!task) throw new TaskScopeError('Task not found.')
      if (task.activeRunId || isTaskExecutionStatus(task.status)) {
        throw new TaskAdmissionError('A running task cannot switch employee.')
      }
      task.subscriptionId = subscriptionId
    })
    this.notifyTaskUpdate(taskId)
    return (await this.getTask(taskId)) as Task
  }

  async clearTaskRun(taskId: string, expectedRunId?: string): Promise<void> {
    // C9：唯一检查点在 mutate 闭包内。放在外面就是 check-then-commit：
    // 两者之间 activeRunId 可能已经换成另一个 run，那就会清掉不该清的准入。
    let changed = false
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask || (expectedRunId && nextTask.activeRunId !== expectedRunId)) return
      const runId = nextTask.activeRunId
      if (runId) {
        nextTask.lastRunId = runId
        nextTask.lastRunStartedAt = nextTask.currentRunStartedAt
        nextTask.lastRunEndedAt = Date.now()
        nextTask.currentRunStartedAt = null
        nextTask.queuedAt = null
      }
      nextTask.activeRunId = null
      changed = true
    })
    if (changed) this.notifyTaskUpdate(taskId)
  }

  async settleTaskRun(
    taskId: string,
    runId: string,
    status: ClientTaskStatus,
    error?: string,
  ): Promise<boolean> {
    await this.requireTask(taskId)
    let changed = false
    await this.commit(nextTasks => {
      const task = nextTasks.get(taskId)
      if (!task || task.activeRunId !== runId) return
      assertTaskTransition(task.status, status)
      task.status = status
      task.activeRunId = null
      task.error = error ?? null
      task.lastRunId = runId
      task.lastRunStartedAt = task.currentRunStartedAt
      task.lastRunEndedAt = Date.now()
      task.currentRunStartedAt = null
      task.queuedAt = null
      task.completedAt = status === TaskStatus.COMPLETED || status === TaskStatus.FAILED ? Date.now() : null
      if (status === TaskStatus.PENDING) task.startedAt = null
      changed = true
    })
    if (changed) this.notifyTaskUpdate(taskId)
    return changed
  }

  async getTasksBySubscription(subscriptionId: string): Promise<Task[]> {
    return (await this.getAllTasks()).filter(task => task.subscriptionId === subscriptionId)
  }

  async getTask(taskId: string): Promise<Task | null> {
    await this.requireCurrentUser()
    const task = this.tasks.get(taskId)
    return task ? cloneTask(task) : null
  }

  async getAllTasks(): Promise<Task[]> {
    await this.requireCurrentUser()
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt).map(cloneTask)
  }

  async updateTaskStatus(taskId: string, status: ClientTaskStatus, error?: string): Promise<void> {
    await this.requireTask(taskId)
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) return
      assertTaskTransition(nextTask.status, status)
      if (status === TaskStatus.RUNNING) {
        const now = Date.now()
        if (!nextTask.startedAt) nextTask.startedAt = now
        if (nextTask.currentRunStartedAt == null) nextTask.currentRunStartedAt = now
        nextTask.queuedAt = null
      }
      if (status === TaskStatus.COMPLETED || status === TaskStatus.FAILED) nextTask.completedAt = Date.now()
      if (status === TaskStatus.RUNNING) {
        nextTask.executionHealth = undefined
        nextTask.startFailureAt = null
        nextTask.error = null
        nextTask.completedAt = null
      }
      if (status === TaskStatus.PENDING) {
        nextTask.error = null
        nextTask.completedAt = null
        nextTask.startedAt = null
        nextTask.executionHealth = undefined
        nextTask.startFailureAt = null
        nextTask.queuedAt = null
        nextTask.currentRunStartedAt = null
      }
      nextTask.status = status
      if (error) nextTask.error = error
    })
    this.notifyTaskUpdate(taskId)
  }

  async addTaskLog(taskId: string, message: string, level: ClientTaskLogLevel = 'info'): Promise<void> {
    await this.requireTask(taskId)
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (nextTask) nextTask.logs.push({ timestamp: Date.now(), message, level })
    })
    this.notifyTaskUpdate(taskId)
  }

  async addTaskFile(taskId: string, filePath: string): Promise<void> {
    let changed = false
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      // C9：去重判断必须与写入同处一个闭包，否则并发两次同名文件都会被追加。
      if (!nextTask || nextTask.files.includes(filePath)) return
      nextTask.files.push(filePath)
      nextTask.logs.push({ timestamp: Date.now(), message: `生成文件: ${filePath}`, level: 'info' })
      changed = true
    })
    if (changed) this.notifyTaskUpdate(taskId)
  }

  async updateTaskProgress(taskId: string, progress: number): Promise<void> {
    await this.requireTask(taskId)
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (nextTask) nextTask.progress = Math.max(0, Math.min(100, progress))
    })
    this.notifyTaskUpdate(taskId)
  }

  async pauseTask(taskId: string): Promise<void> {
    let changed = false
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) return
      // C9：原来这里有两处判断——闭包外一个"不可暂停就静默返回"，闭包内一个
      // assertTaskTransition 会抛。两者之间状态一变，用户看到的就是 INTERNAL_ERROR
      // 而不是 INVALID_STATE。现在只有这一个检查点，语义取原来对外的那个：静默忽略。
      const pausable = nextTask.status === TaskStatus.RUNNING ||
        nextTask.status === TaskStatus.WAITING_APPROVAL ||
        (nextTask.status === TaskStatus.PENDING && nextTask.activeRunId !== null)
      if (!pausable || !canTransitionTask(nextTask.status, TaskStatus.PAUSED)) return
      nextTask.status = TaskStatus.PAUSED
      nextTask.logs.push({ timestamp: Date.now(), message: 'Task paused.', level: 'warning' })
      changed = true
    })
    if (changed) this.notifyTaskUpdate(taskId)
  }

  async deleteTask(taskId: string): Promise<boolean> {
    let deleted = false
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      // C9：准入可能在检查与删除之间发生，闭包外判断会删掉正在跑的任务。
      if (!nextTask || nextTask.activeRunId) return
      const deletable = isTaskTerminal(nextTask.status)
        || nextTask.status === TaskStatus.PAUSED || nextTask.status === TaskStatus.INTERRUPTED
      if (!deletable) return
      nextTasks.delete(taskId)
      deleted = true
    })
    if (deleted) this.notifyTaskListUpdate()
    return deleted
  }

  /** Called only after the service has durably archived the record. History stays readable internally. */
  hideTaskRecord(taskId: string, scope: TaskOwnerScope): void {
    if (!this.currentUser || this.currentUser.memberId !== scope.memberId || this.currentUser.enterpriseId !== scope.enterpriseId) {
      throw new TaskScopeError()
    }
    if (!this.tasks.has(taskId)) throw new TaskScopeError('Task not found.')
    this.hiddenTaskIds.add(taskId)
    this.notifyTaskListUpdate()
  }

  async clearCompletedTasks(): Promise<number> {
    let removed = 0
    await this.commit(nextTasks => {
      for (const [id, task] of nextTasks) {
        if (task.status !== TaskStatus.COMPLETED || task.activeRunId) continue
        nextTasks.delete(id)
        removed += 1
      }
    })
    if (removed > 0) this.notifyTaskListUpdate()
    return removed
  }

  private async reconcileTaskLifecycle(input: {
    scope: TaskOwnerScope
    generation: number
    taskId: string
    expectedRunId: string | null
    expectedRevision: number
    expectedStatus: ClientTaskStatus
    targetStatus: ClientTaskStatus
    endedAt: number
    startedAt: number
    error?: string
    runtime: (taskId: string) => TaskLifecycleRuntimeEvidence | null
  }): Promise<boolean> {
    let changed = false
    await this.serialize(async () => {
      const matches = (): boolean => {
        const task = this.tasks.get(input.taskId)
        return this.currentUser === input.scope && this.generation === input.generation &&
          !this.hiddenTaskIds.has(input.taskId) && !!task && task.activeRunId === input.expectedRunId &&
          task.status === input.expectedStatus && (task.stateRevision ?? 0) === input.expectedRevision &&
          input.runtime(input.taskId) === null
      }
      if (!matches() || !input.expectedRunId) return
      if (this.persistenceDegraded) throw new TaskPersistenceError('Task history needs recovery before it can be changed.')
      const [run, checkpoint] = await Promise.all([
        this.runStore.get(input.scope, input.taskId, input.expectedRunId),
        this.checkpoints.get(input.scope, input.taskId, { readOnly: true }),
      ])
      if (!matches()) return
      const current = this.tasks.get(input.taskId)!
      const evidence = classifyTaskLifecycle({ task: current, run, runtime: null,
        checkpoint: checkpoint ? { activeRunId: checkpoint.activeRunId, lastRunId: checkpoint.lastRunId ?? null,
          status: checkpoint.state.status, updatedAt: checkpoint.updatedAt } : null,
        missingForMs: null, missingGraceMs: 60_000 })
      if (evidence.kind !== 'terminal-evidence' || evidence.targetStatus !== input.targetStatus ||
          evidence.endedAt !== input.endedAt || evidence.startedAt !== input.startedAt) return
      const nextTasks = cloneTasks(this.tasks)
      const task = nextTasks.get(input.taskId)!
      if (task.activeRunId !== input.expectedRunId || task.status !== input.expectedStatus ||
          (task.stateRevision ?? 0) !== input.expectedRevision ||
          task.status === TaskStatus.PAUSED || task.status === TaskStatus.INTERRUPTED ||
          isTaskTerminal(task.status)) return
      // Durable terminal evidence can repair a snapshot that missed intermediate transitions.
      task.status = input.targetStatus
      task.activeRunId = null
      task.error = input.error ?? null
      task.lastRunId = input.expectedRunId
      task.lastRunStartedAt = input.startedAt
      task.lastRunEndedAt = input.endedAt
      task.currentRunStartedAt = null
      task.queuedAt = null
      task.completedAt = input.targetStatus === TaskStatus.COMPLETED || input.targetStatus === TaskStatus.FAILED
        ? input.endedAt : null
      task.logs.push({ timestamp: Date.now(), message: `Task lifecycle reconciled as ${input.targetStatus}.`, level: 'warning' })
      task.stateRevision = (task.stateRevision ?? 0) + 1
      await this.store.save(input.scope, Array.from(nextTasks.values()))
      if (this.currentUser !== input.scope || this.generation !== input.generation) return
      this.tasks = nextTasks
      this.lifecycleMissingSince.delete(input.taskId)
      changed = true
    })
    if (changed) this.notifyTaskUpdate(input.taskId)
    return changed
  }

  async getTasksByStatus(status: ClientTaskStatus): Promise<Task[]> {
    return (await this.getAllTasks()).filter(task => task.status === status)
  }

  async getTaskStats(): Promise<ClientTaskStats> {
    const tasks = await this.getAllTasks()
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === TaskStatus.PENDING).length,
      running: tasks.filter(t => t.status === TaskStatus.RUNNING).length,
      waitingApproval: tasks.filter(t => t.status === TaskStatus.WAITING_APPROVAL).length,
      paused: tasks.filter(t => t.status === TaskStatus.PAUSED).length,
      interrupted: tasks.filter(t => t.status === TaskStatus.INTERRUPTED).length,
      completed: tasks.filter(t => t.status === TaskStatus.COMPLETED).length,
      failed: tasks.filter(t => t.status === TaskStatus.FAILED).length,
    }
  }

  private async commit(mutate: (nextTasks: Map<string, Task>) => void, expectedGeneration?: number): Promise<void> {
    const scope = await this.requireCurrentUser()
    const generation = this.generation
    if (expectedGeneration !== undefined) this.assertCurrentScope(scope, expectedGeneration)
    await this.serialize(async () => {
      if (expectedGeneration !== undefined) this.assertCurrentScope(scope, expectedGeneration)
      // C8：排队期间 scope 可能已经切走。世代号变了就放弃这次写入——否则会把新 scope
      // 的内存快照写进旧 scope 的文件，并把新 scope 的内存状态覆盖回去。
      if (this.generation !== generation) {
        log.warn('discarded an in-flight commit from a previous scope', {
          committedGeneration: generation,
          currentGeneration: this.generation,
        })
        return
      }
      if (this.persistenceDegraded) throw new TaskPersistenceError('Task history needs recovery before it can be changed.')
      const nextTasks = cloneTasks(this.tasks)
      mutate(nextTasks)
      for (const [id, task] of nextTasks) {
        const previous = this.tasks.get(id)
        if (!previous) {
          task.stateRevision = Math.max(0, task.stateRevision ?? 0)
          continue
        }
        const lifecycleChanged = previous.status !== task.status || previous.activeRunId !== task.activeRunId ||
          previous.queuedAt !== task.queuedAt || previous.currentRunStartedAt !== task.currentRunStartedAt ||
          previous.completedAt !== task.completedAt || previous.executionHealth !== task.executionHealth
        task.stateRevision = lifecycleChanged ? (previous.stateRevision ?? 0) + 1 : previous.stateRevision ?? 0
      }
      await this.store.save(scope, Array.from(nextTasks.values()))
      this.tasks = nextTasks
    })
  }

  /** commit 与 scope 切换共用的串行链。前一个失败不影响后一个排队（C8）。 */
  private async serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.mutationChain.catch(() => undefined).then(operation)
    this.mutationChain = next.then(() => undefined, () => undefined)
    await next
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.getTask(taskId)
    if (!task) throw new TaskScopeError('Task not found.')
    return task
  }

  private async requireCurrentUser(): Promise<TaskOwnerScope> {
    await this.ensureInitialized()
    if (!this.currentUser) throw new TaskScopeError()
    return this.currentUser
  }

  private assertCurrentScope(scope: TaskOwnerScope, generation: number): void {
    if (this.currentUser !== scope || this.generation !== generation) {
      throw new TaskScopeError('Task scope changed during directory preparation.')
    }
  }

  private validateScope(scope: TaskOwnerScope): void {
    if (!scope.memberId || !scope.enterpriseId) throw new TaskScopeError()
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
    if (!this.initialized) throw new TaskPersistenceError('Task manager is not initialized.')
  }

  private notifyTaskUpdate(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (task && !this.hiddenTaskIds.has(taskId)) this.notifier.taskUpdated(cloneTask(task))
  }

  private notifyTaskListUpdate(): void {
    const tasks = this.currentUser
      ? Array.from(this.tasks.values()).filter(task => !this.hiddenTaskIds.has(task.id))
        .sort((a, b) => b.createdAt - a.createdAt).map(cloneTask)
      : []
    this.notifier.taskListUpdated(tasks)
  }
}


