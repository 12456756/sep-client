import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ClientTask,
  ClientTaskLogLevel,
  ClientTaskStats,
  ClientTaskStatus,
} from '../../src/shared/types'
import { TaskStatus } from '../../src/shared/types'
import {
  TaskPersistenceError,
  TaskScopeError,
  TaskStore,
  type TaskOwnerScope,
  type TaskStorePort,
  encodeTaskScopeSegment,
} from './task-store'
import { TaskRunStore, type TaskRunStorePort } from './task-run-store'
import {
  assertTaskTransition,
  TaskAdmissionError,
  isTaskExecutionStatus,
  isTaskTerminal,
} from './domain/task-state-machine'

export { TaskStatus } from '../../src/shared/types'
export { TaskPersistenceError, TaskScopeError } from './task-store'
export { TaskAdmissionError } from './domain/task-state-machine'
export type { ClientTask as Task, ClientTaskLog as TaskLog } from '../../src/shared/types'

type Task = ClientTask

function cloneTask(task: Task): Task {
  return { ...task, files: [...task.files], logs: task.logs.map(log => ({ ...log })) }
}

function cloneTasks(tasks: Map<string, Task>): Map<string, Task> {
  return new Map(Array.from(tasks.entries(), ([id, task]) => [id, cloneTask(task)]))
}

export class TaskManager {
  private readonly userDataDir: string
  private tasks = new Map<string, Task>()
  private mainWindow: BrowserWindow | null = null
  private currentUser: TaskOwnerScope | null = null
  private initialized = false
  private initializing: Promise<void> | null = null
  private persistenceDegraded = false
  private readonly store: TaskStorePort
  private readonly runStore: TaskRunStorePort
  private mutationChain: Promise<void> = Promise.resolve()

  constructor(
    userDataDir: string,
    mainWindow: BrowserWindow | null = null,
    store: TaskStorePort = new TaskStore(userDataDir),
    runStore: TaskRunStorePort = new TaskRunStore(userDataDir),
  ) {
    this.userDataDir = userDataDir
    this.mainWindow = mainWindow
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

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  async setCurrentUser(memberId: string, enterpriseId: string): Promise<void> {
    await this.ensureInitialized()
    const scope = { memberId, enterpriseId }
    this.validateScope(scope)

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
      console.warn('[TaskManager] Failed to recover persisted task runs:', error instanceof Error ? error.name : 'unknown')
    }

    if (recovered) {
      try {
        await this.store.save(scope, loadedTasks)
      } catch (error) {
        this.persistenceDegraded = true
        console.warn('[TaskManager] Failed to persist recovered tasks:', error instanceof Error ? error.name : 'unknown')
      }
    }
    this.notifyTaskListUpdate()
  }

  clearCurrentUser(): void {
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
    const resolvedWorkDir = workDir?.trim() || join(
      this.userDataDir,
      'task-workspaces', 'v1', encodeTaskScopeSegment(user.enterpriseId, 'enterpriseId'),
      encodeTaskScopeSegment(user.memberId, 'memberId'), id,
    )
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
    const task = await this.getTask(taskId)
    if (!task || (expectedRunId && task.activeRunId !== expectedRunId)) return
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (nextTask) nextTask.activeRunId = null
    })
    this.notifyTaskUpdate(taskId)
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
    const task = await this.getTask(taskId)
    if (!task || task.files.includes(filePath)) return
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) return
      nextTask.files.push(filePath)
      nextTask.logs.push({ timestamp: Date.now(), message: `生成文件: ${filePath}`, level: 'info' })
    })
    this.notifyTaskUpdate(taskId)
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
    const task = await this.getTask(taskId)
    if (!task || (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.WAITING_APPROVAL && !(task.status === TaskStatus.PENDING && task.activeRunId))) return
    if (task.status === TaskStatus.WAITING_APPROVAL) assertTaskTransition(task.status, TaskStatus.PAUSED)
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) return
      assertTaskTransition(nextTask.status, TaskStatus.PAUSED)
      nextTask.status = TaskStatus.PAUSED
      nextTask.logs.push({ timestamp: Date.now(), message: 'Task paused.', level: 'warning' })
    })
    this.notifyTaskUpdate(taskId)
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId)
    if (!task) return
    if (!isTaskExecutionStatus(task.status) && !(task.status === TaskStatus.PENDING && task.activeRunId)) {
      return
    }
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) return
      assertTaskTransition(nextTask.status, TaskStatus.FAILED)
      nextTask.status = TaskStatus.FAILED
      nextTask.completedAt = Date.now()
      nextTask.error = '用户取消'
      nextTask.error = 'Task cancelled.'
      nextTask.logs.push({ timestamp: Date.now(), message: 'Task cancelled.', level: 'warning' })
    })
    this.notifyTaskUpdate(taskId)
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId)
    if (!task || task.activeRunId || !isTaskTerminal(task.status)) return false
    await this.commit(nextTasks => nextTasks.delete(taskId))
    this.notifyTaskListUpdate()
    return true
  }

  async clearCompletedTasks(): Promise<number> {
    await this.requireCurrentUser()
    const completed = Array.from(this.tasks.values()).filter(task => task.status === TaskStatus.COMPLETED)
    if (completed.length === 0) return 0
    await this.commit(nextTasks => completed.forEach(task => nextTasks.delete(task.id)))
    this.notifyTaskListUpdate()
    return completed.length
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
    const submit = async () => {
      if (this.persistenceDegraded) throw new TaskPersistenceError('Task history needs recovery before it can be changed.')
      const nextTasks = cloneTasks(this.tasks)
      mutate(nextTasks)
      await this.store.save(scope, Array.from(nextTasks.values()))
      this.tasks = nextTasks
    }
    const next = this.mutationChain.catch(() => undefined).then(submit)
    this.mutationChain = next
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
    if (task) this.mainWindow?.webContents.send('task:updated', cloneTask(task))
  }

  private notifyTaskListUpdate(): void {
    if (!this.mainWindow) return
    const tasks = this.currentUser
      ? Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt).map(cloneTask)
      : []
    this.mainWindow.webContents.send('task:list-updated', tasks)
  }
}
