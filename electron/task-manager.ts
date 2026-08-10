/**
 * electron/task-manager.ts — 任务管理器
 *
 * 职责:
 *   - 管理任务的 CRUD（创建、读取、更新、删除）
 *   - 维护任务状态机
 *   - 记录任务日志
 *   - 通知 renderer 任务变化
 */

import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export enum TaskStatus {
  PENDING = 'pending',                 // 待执行
  RUNNING = 'running',                 // 执行中
  WAITING_APPROVAL = 'waiting_approval', // 等待审批
  PAUSED = 'paused',                   // 已暂停
  COMPLETED = 'completed',             // 已完成
  FAILED = 'failed',                   // 失败
}

export interface TaskLog {
  timestamp: number;
  message: string;
  level?: 'info' | 'error' | 'warning';
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  workDir: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  files: string[];
  logs: TaskLog[];
  progress?: number;  // 0-100，可选
}

// ─────────────────────────────────────────────────────────────────
// TaskManager Class
// ─────────────────────────────────────────────────────────────────

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private currentTaskId: string | null = null;
  private mainWindow: BrowserWindow | null = null;

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow;
  }

  /**
   * 设置主窗口（用于发送 IPC 事件）
   */
  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  /**
   * 创建任务
   */
  createTask(title: string, prompt: string, workDir?: string): Task {
    const task: Task = {
      id: randomUUID(),
      title,
      prompt,
      status: TaskStatus.PENDING,
      workDir: workDir || null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      error: null,
      files: [],
      logs: [],
    };

    this.tasks.set(task.id, task);
    this.notifyTaskUpdate(task.id);

    console.log('[TaskManager] Task created:', task.id, task.title);
    return task;
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): Task | null {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取当前正在执行的任务
   */
  getCurrentTask(): Task | null {
    if (!this.currentTaskId) return null;
    return this.getTask(this.currentTaskId);
  }

  /**
   * 设置当前任务
   */
  setCurrentTask(taskId: string) {
    this.currentTaskId = taskId;
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(taskId: string, status: TaskStatus, error?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn('[TaskManager] Task not found:', taskId);
      return;
    }

    const oldStatus = task.status;
    task.status = status;

    // 更新时间戳
    if (status === TaskStatus.RUNNING && !task.startedAt) {
      task.startedAt = Date.now();
    }
    if (status === TaskStatus.COMPLETED || status === TaskStatus.FAILED) {
      task.completedAt = Date.now();
    }

    // 设置错误信息
    if (error) {
      task.error = error;
    }

    console.log(`[TaskManager] Task ${taskId} status: ${oldStatus} → ${status}`);
    this.notifyTaskUpdate(taskId);
  }

  /**
   * 添加任务日志
   */
  addTaskLog(taskId: string, message: string, level: 'info' | 'error' | 'warning' = 'info'): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const log: TaskLog = {
      timestamp: Date.now(),
      message,
      level,
    };

    task.logs.push(log);
    console.log(`[TaskManager] Task ${taskId} log [${level}]:`, message);

    this.notifyTaskUpdate(taskId);
  }

  /**
   * 添加生成的文件
   */
  addTaskFile(taskId: string, filePath: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (!task.files.includes(filePath)) {
      task.files.push(filePath);
      this.addTaskLog(taskId, `生成文件: ${filePath}`);
      this.notifyTaskUpdate(taskId);
    }
  }

  /**
   * 更新任务进度
   */
  updateTaskProgress(taskId: string, progress: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.progress = Math.max(0, Math.min(100, progress));
    this.notifyTaskUpdate(taskId);
  }

  /**
   * 暂停任务
   */
  pauseTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (task.status === TaskStatus.RUNNING) {
      this.updateTaskStatus(taskId, TaskStatus.PAUSED);
      this.addTaskLog(taskId, '任务已暂停', 'warning');
    }
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.WAITING_APPROVAL) {
      this.updateTaskStatus(taskId, TaskStatus.FAILED, '用户取消');
      this.addTaskLog(taskId, '任务已取消', 'warning');
    }

    // 如果是当前任务，清空
    if (this.currentTaskId === taskId) {
      this.currentTaskId = null;
    }
  }

  /**
   * 删除任务
   */
  deleteTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // 只能删除已完成或失败的任务
    if (task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) {
      console.warn('[TaskManager] Cannot delete active task:', taskId);
      return false;
    }

    this.tasks.delete(taskId);
    console.log('[TaskManager] Task deleted:', taskId);

    // 通知 UI 任务列表变化
    this.notifyTaskListUpdate();
    return true;
  }

  /**
   * 清空已完成的任务
   */
  clearCompletedTasks(): number {
    let count = 0;
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status === TaskStatus.COMPLETED) {
        this.tasks.delete(taskId);
        count++;
      }
    }

    if (count > 0) {
      console.log(`[TaskManager] Cleared ${count} completed tasks`);
      this.notifyTaskListUpdate();
    }

    return count;
  }

  /**
   * 通知 renderer 任务更新
   */
  private notifyTaskUpdate(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task) return;

    this.mainWindow?.webContents.send('task:updated', task);
  }

  /**
   * 通知 renderer 任务列表变化
   */
  private notifyTaskListUpdate(): void {
    const tasks = this.getAllTasks();
    this.mainWindow?.webContents.send('task:list-updated', tasks);
  }

  /**
   * 获取按状态分组的任务
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    return this.getAllTasks().filter(task => task.status === status);
  }

  /**
   * 获取任务统计
   */
  getTaskStats() {
    const tasks = this.getAllTasks();
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === TaskStatus.PENDING).length,
      running: tasks.filter(t => t.status === TaskStatus.RUNNING).length,
      waitingApproval: tasks.filter(t => t.status === TaskStatus.WAITING_APPROVAL).length,
      paused: tasks.filter(t => t.status === TaskStatus.PAUSED).length,
      completed: tasks.filter(t => t.status === TaskStatus.COMPLETED).length,
      failed: tasks.filter(t => t.status === TaskStatus.FAILED).length,
    };
  }
}
