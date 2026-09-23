import type { TaskExecutionEvent } from '../../src/shared/types'

import type { MonitorStatus } from '../common/platform/client-monitor-contract'
export type { MonitorStatus } from '../common/platform/client-monitor-contract'

export interface MonitorTaskQueuedInput {
  prompt: string
  taskId: string
  runId: string
  subscriptionId: string
  title: string
  modelId: string
  taskType: 'conversation' | 'arrangement'
}

export interface MonitorTaskStartedInput {
  taskId: string
  runId: string
  startedAt: number
}

export interface MonitorTaskContentInput {
  taskId: string
  runId: string
  content: string
}

export interface MonitorTaskFinishedInput {
  taskId: string
  runId: string
  status: MonitorStatus
  error?: string | null
  completedAt: number
}

export interface TaskMonitorPort {
  taskQueued(input: MonitorTaskQueuedInput): Promise<void>
  taskStarted(input: MonitorTaskStartedInput): Promise<void>
  taskEvent(event: TaskExecutionEvent): Promise<void>
  taskInput(input: MonitorTaskContentInput): Promise<void>
  taskOutput(input: MonitorTaskContentInput): Promise<void>
  taskFinished(input: MonitorTaskFinishedInput): Promise<void>
  resumePending(): Promise<void>
  stop(): Promise<void>
}

export const silentTaskMonitor: TaskMonitorPort = {
  async taskQueued() {},
  async taskStarted() {},
  async taskEvent() {},
  async taskInput() {},
  async taskOutput() {},
  async taskFinished() {},
  async resumePending() {},
  async stop() {},
}
