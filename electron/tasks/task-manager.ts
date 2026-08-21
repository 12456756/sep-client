import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
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
} from './task-store'
import { TaskRunStore, type TaskRunStorePort } from './task-run-store'

export { TaskStatus } from '../../src/shared/types'
export { TaskPersistenceError, TaskScopeError } from './task-store'
export type { ClientTask as Task, ClientTaskLog as TaskLog } from '../../src/shared/types'

type Task = ClientTask

function cloneTask(task: Task): Task {
  return { ...task, files: [...task.files], logs: task.logs.map(log => ({ ...log })) }
}

function cloneTasks(tasks: Map<string, Task>): Map<string, Task> {
  return new Map(Array.from(tasks.entries(), ([id, task]) => [id, cloneTask(task)]))
}

export class TaskManager {
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
      if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.WAITING_APPROVAL) continue
      task.status = TaskStatus.INTERRUPTED
      task.activeRunId = null
      if (!task.logs.some(log => log.message === '上次会话已结束，任务已中断')) {
        task.logs.push({ timestamp: Date.now(), message: '上次会话已结束，任务已中断', level: 'warning' })
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

  async createTask(
    title: string,
    prompt: string,
    workDir?: string,
    employeeInstanceId: string | null = null,
  ): Promise<Task> {
    const user = await this.requireCurrentUser()
    const task: Task = {
      id: randomUUID(), title, prompt, status: TaskStatus.PENDING, workDir: workDir || null,
      createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [],
      ownerId: user.memberId, ownerEnterpriseId: user.enterpriseId,
      employeeInstanceId, activeRunId: null,
    }
    await this.commit(nextTasks => nextTasks.set(task.id, task))
    this.notifyTaskUpdate(task.id)
    return cloneTask(task)
  }

  async bindTaskInstance(taskId: string, employeeInstanceId: string): Promise<Task> {
    if (!employeeInstanceId) throw new TaskScopeError('A valid employee instance is required.')
    const task = await this.requireTask(taskId)
    if (task.employeeInstanceId && task.employeeInstanceId !== employeeInstanceId) {
      throw new TaskScopeError('Task is already bound to a different employee instance.')
    }
    if (task.employeeInstanceId === employeeInstanceId) return cloneTask(task)
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) throw new TaskScopeError('Task not found.')
      nextTask.employeeInstanceId = employeeInstanceId
    })
    this.notifyTaskUpdate(taskId)
    return (await this.getTask(taskId))!
  }

  async setTaskRun(taskId: string, runId: string): Promise<void> {
    await this.requireTask(taskId)
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) throw new TaskScopeError('Task not found.')
      nextTask.activeRunId = runId
    })
    this.notifyTaskUpdate(taskId)
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

  async getTasksByInstance(employeeInstanceId: string): Promise<Task[]> {
    return (await this.getAllTasks()).filter(task => task.employeeInstanceId === employeeInstanceId)
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
    if (!task || task.status !== TaskStatus.RUNNING) return
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) return
      nextTask.status = TaskStatus.PAUSED
      nextTask.logs.push({ timestamp: Date.now(), message: '任务已暂停', level: 'warning' })
    })
    this.notifyTaskUpdate(taskId)
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId)
    if (!task) return
    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.WAITING_APPROVAL) {
      return
    }
    await this.commit(nextTasks => {
      const nextTask = nextTasks.get(taskId)
      if (!nextTask) return
      nextTask.status = TaskStatus.FAILED
      nextTask.completedAt = Date.now()
      nextTask.error = '用户取消'
      nextTask.logs.push({ timestamp: Date.now(), message: '任务已取消', level: 'warning' })
    })
    this.notifyTaskUpdate(taskId)
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId)
    if (!task || (task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED)) return false
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
