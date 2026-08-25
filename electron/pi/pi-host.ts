import type { TaskExecutionEvent, ToolAuthorizationRequest } from '../../src/shared/types'
import type { TaskManager } from '../tasks/task-manager'
import { TaskExecutionCoordinator, type EmployeeRuntimeConfig } from '../tasks/task-execution-coordinator'

export interface PiHostConfig {
  onEvent: (event: TaskExecutionEvent) => void
  onToolApprovalRequest: (request: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => void
  taskManager: TaskManager
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  onSubscriptionAuthorizationRejected: (subscriptionId: string, status: 403 | 404) => void
  resolveEmployee: (subscriptionId: string, modelId?: string | null) => EmployeeRuntimeConfig | null
  userDataDir: string
}

export interface SessionConfig {
  subscriptionId?: string
  /** @deprecated Use subscriptionId. */
  employeeId?: string
}

export class PiHost {
  private readonly coordinator: TaskExecutionCoordinator
  private activeSubscriptionId: string | null = null

  constructor(private readonly config: PiHostConfig) {
    this.coordinator = new TaskExecutionCoordinator({
      taskManager: config.taskManager,
      getRefreshToken: config.getRefreshToken,
      onAuthenticationRequired: config.onAuthenticationRequired,
      onSubscriptionAuthorizationRejected: config.onSubscriptionAuthorizationRejected,
      onEvent: config.onEvent,
      onApprovalRequest: config.onToolApprovalRequest,
      resolveEmployee: config.resolveEmployee,
      userDataDir: config.userDataDir,
    })
  }

  async startSession(sessionConfig: SessionConfig): Promise<void> {
    const subscriptionId = sessionConfig.subscriptionId ?? sessionConfig.employeeId
    if (!subscriptionId || !this.config.resolveEmployee(subscriptionId)) {
      throw new Error('The selected employee is no longer available.')
    }
    this.activeSubscriptionId = subscriptionId
  }

  async executeTask(taskId: string): Promise<void> {
    await this.coordinator.executeTask(taskId, this.activeSubscriptionId)
  }

  async continueTask(taskId: string, prompt: string): Promise<void> {
    await this.coordinator.continueConversation(taskId, prompt, this.activeSubscriptionId)
  }

  async retryTask(taskId: string): Promise<void> {
    await this.coordinator.retryTask(taskId, this.activeSubscriptionId)
  }

  async pauseTask(taskId: string): Promise<void> {
    await this.coordinator.pauseTask(taskId)
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.coordinator.cancelTask(taskId)
  }

  respondToApproval(response: { requestId?: string; approved: boolean; reason?: string }): boolean {
    return this.coordinator.respondToApproval(response)
  }

  async stopSession(subscriptionId = this.activeSubscriptionId): Promise<void> {
    if (!subscriptionId) return
    await this.coordinator.stopSubscription(subscriptionId)
    if (this.activeSubscriptionId === subscriptionId) this.activeSubscriptionId = null
  }

  async stopAllSessions(): Promise<void> {
    await this.coordinator.stopAll()
    this.activeSubscriptionId = null
  }

  async sendPrompt(_text: string): Promise<void> {
    throw new Error('Direct prompts are not supported while task execution is scheduled.')
  }
}
