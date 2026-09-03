import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import type {
  ClientTask,
  ClientTaskLogLevel,
  ClientTaskStats,
  ClientTaskStatus,
} from '../../src/shared/types'
import { TaskStatus } from '../../src/shared/types'
import { TaskPersistenceError, TaskStore, type TaskStorePort } from '../data/task-store'
import { ScopePath, TaskScopeError, type TaskOwnerScope } from '../data/scope-path'
import { TaskRunStore, type TaskRunStorePort } from '../data/task-run-store'
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

type Task = ClientTask

function cloneTask(task: Task): Task {
  return { ...task, files: [...task.files], logs: task.logs.map(log => ({ ...log })) }
}

function cloneTasks(tasks: Map<string, Task>): Map<string, Task> {
  return new Map(Array.from(tasks.entries(), ([id, task]) => [id, cloneTask(task)]))
}

export class TaskManager {
  private readonly paths: ScopePath
  private tasks = new Map<string, Task>()
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

  constructor(
    userDataDir: string,
    notifier: TaskNotifier | null = null,
    store: TaskStorePort = new TaskStore(userDataDir),
    runStore: TaskRunStorePort = new TaskRunStore(userDataDir),
  ) {
    this.paths = new ScopePath(userDataDir)
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

  async setCurrentUser(memberId: string, enterpriseId: string): Promise<void> {
    await this.ensureInitialized()
    const scope = { memberId, enterpriseId }
    this.validateScope(scope)

    // C8：scope 切换必须与 commit 共用同一条串行链。原来它直接改 currentUser 与 tasks，
    // 在途的 commit 恢复执行后会拿新 scope 的 tasks 去覆盖旧 scope 的文件
    // ——旧 scope 的数据被写成新 scope 的内容，新 scope 的内存状态又被回滚。
    await this.serialize(async () => {
      this.generation += 1
      this.currentUser = null
      this.tasks.clear()
      this.notifyTaskListUpdate()

      const loadedTasks = (await this.store.load(scope)).map(cloneTask)
      let recovered = false
      for (const task of loadedTasks) {
        if (
          task.status !== TaskStatus.RUNNING &&
          task.status !== TaskStatus.WAITING_APPROVAL &&
          !(task.status === TaskStatus.PENDING && task.activeRunId)
        ) continue
        assertTaskTransition(task.status, TaskStatus.INTERRUPTED)
        task.status = TaskStatus.INTERRUPTED
        task.activeRunId = null
        if (!task.logs.some(log => log.message === 'Previous session ended; task interrupted.')) {
          task.logs.push({ timestamp: Date.now(), message: 'Previous session ended; task interrupted.', level: 'warning' })
        }
        recovered = true
      }

      this.currentUser = scope
      this.tasks = new Map(loadedTasks.map(task => [task.id, task]))
      this.persistenceDegraded = false

      try {
        await this.runStore.markActiveRunsInterrupted(scope)
      } catch (error) {
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
    this.tasks.clear()
    this.persistenceDegraded = false
    this.notifyTaskListUpdate()
  }

  hasCurrentUser(): boolean {
    return this.currentUser !== null
  }

  getCurrentUserScope(): TaskOwnerScope | null {
    return this.currentUser ? { ...this.currentUser } : null
  }

  isPersistenceDegraded(): boolean {
    return this.persistenceDegraded
  }

  async recoverPersistence(): Promise<void> {
    const scope = await this.requireCurrentUser()
    await this.setCurrentUser(scope.memberId, scope.enterpriseId)
    if (this.persistenceDegraded) throw new TaskPersistenceError('Task history recovery did not complete.')
  }

  async createTask(
    title: string,
    prompt: string,
    workDir?: string,
    subscriptionId: string | null = null,
  ): Promise<Task> {
    const user = await this.requireCurrentUser()
    const id = randomUUID()
    const resolvedWorkDir = workDir?.trim() || this.paths.defaultWorkspaceDir(user, id)
    await mkdir(resolvedWorkDir, { recursive: true })
    const task: Task = {
      id, title, prompt, status: TaskStatus.PENDING, workDir: resolvedWorkDir,
      createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [],
      ownerId: user.memberId, ownerEnterpriseId: user.enterpriseId,
      subscriptionId, activeRunId: null,
    }
    try {
      await this.commit(nextTasks => nextTasks.set(task.id, task))
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
      nextTask.activeRunId = runId
    })
    this.notifyTaskUpdate(taskId)
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
      if (status === TaskStatus.RUNNING && !nextTask.startedAt) nextTask.startedAt = Date.now()
      if (status === TaskStatus.COMPLETED || status === TaskStatus.FAILED) nextTask.completedAt = Date.now()
      if (status === TaskStatus.RUNNING) {
        nextTask.error = null
        nextTask.completedAt = null
      }
      if (status === TaskStatus.PENDING) {
        nextTask.error = null
        nextTask.completedAt = null
        nextTask.startedAt = null
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
      if (!nextTask || nextTask.activeRunId || !isTaskTerminal(nextTask.status)) return
      nextTasks.delete(taskId)
      deleted = true
    })
    if (deleted) this.notifyTaskListUpdate()
    return deleted
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

  private async commit(mutate: (nextTasks: Map<string, Task>) => void): Promise<void> {
    const scope = await this.requireCurrentUser()
    const generation = this.generation
    await this.serialize(async () => {
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

  private validateScope(scope: TaskOwnerScope): void {
    if (!scope.memberId || !scope.enterpriseId) throw new TaskScopeError()
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
    if (!this.initialized) throw new TaskPersistenceError('Task manager is not initialized.')
  }

  private notifyTaskUpdate(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (task) this.notifier.taskUpdated(cloneTask(task))
  }

  private notifyTaskListUpdate(): void {
    const tasks = this.currentUser
      ? Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt).map(cloneTask)
      : []
    this.notifier.taskListUpdated(tasks)
  }
}
