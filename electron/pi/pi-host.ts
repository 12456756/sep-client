import type { TaskExecutionEvent, ToolAuthorizationRequest } from '../../src/shared/types'
import type { TaskManager } from '../tasks/task-manager'
import { TaskExecutionCoordinator, type EmployeeRuntimeConfig } from '../tasks/task-execution-coordinator'

export interface PiHostConfig {
  onEvent: (event: TaskExecutionEvent) => void
  onToolApprovalRequest: (request: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => void
  taskManager: TaskManager
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  resolveEmployee: (employeeInstanceId: string) => EmployeeRuntimeConfig | null
  userDataDir: string
}

export interface SessionConfig {
  employeeId: string
}

export class PiHost {
  private readonly coordinator: TaskExecutionCoordinator
  private activeEmployeeInstanceId: string | null = null

  constructor(private readonly config: PiHostConfig) {
    this.coordinator = new TaskExecutionCoordinator({
      taskManager: config.taskManager,
      getRefreshToken: config.getRefreshToken,
      onAuthenticationRequired: config.onAuthenticationRequired,
      onEvent: config.onEvent,
      onApprovalRequest: config.onToolApprovalRequest,
      resolveEmployee: config.resolveEmployee,
      userDataDir: config.userDataDir,
    })
  }

  async startSession(sessionConfig: SessionConfig): Promise<void> {
    if (!this.config.resolveEmployee(sessionConfig.employeeId)) {
      throw new Error('The selected employee is no longer available.')
    }
    this.activeEmployeeInstanceId = sessionConfig.employeeId
  }

  async executeTask(taskId: string): Promise<void> {
    await this.coordinator.executeTask(taskId, this.activeEmployeeInstanceId)
  }

  async continueTask(taskId: string, prompt: string): Promise<void> {
    await this.coordinator.continueConversation(taskId, prompt, this.activeEmployeeInstanceId)
  }

  async retryTask(taskId: string): Promise<void> {
    await this.coordinator.retryTask(taskId, this.activeEmployeeInstanceId)
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

  async stopSession(employeeInstanceId = this.activeEmployeeInstanceId): Promise<void> {
    if (!employeeInstanceId) return
    await this.coordinator.stopEmployee(employeeInstanceId)
    if (this.activeEmployeeInstanceId === employeeInstanceId) this.activeEmployeeInstanceId = null
  }

  async stopAllSessions(): Promise<void> {
    await this.coordinator.stopAll()
    this.activeEmployeeInstanceId = null
  }

  async sendPrompt(_text: string): Promise<void> {
    throw new Error('Direct prompts are not supported while task execution is scheduled.')
  }
}
