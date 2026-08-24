import type {
  ClientTask,
  ClientTaskStats,
  CreateTaskRequest,
  SubscriptionSnapshot,
  ForgetAccountResult,
  LoginRequest,
  LoginResult,
  LogoutResult,
  PasswordAvailabilityResult,
  RememberedAccountsResult,
  TaskError,
  TaskExecutionEvent,
  TaskListResult,
  TaskResult,
  TaskRunListResult,
  TaskRunResult,
  TaskTimelineResult,
  ClientTaskMessage,
  ToolAuthorizationRequest,
} from './types'
import type { EmployeeSkillsResponse, PackageInfo, SkillPreviewResponse } from '../../electron/auth/auth-api'

export interface IpcError {
  message: string
  statusCode?: number
}

export interface IpcCommandResult {
  success: boolean
  error?: IpcError
}

export interface TaskCommandResult {
  success: boolean
  error?: TaskError
}

export interface InstanceListResult extends IpcCommandResult {
  data?: SubscriptionSnapshot[]
}

export interface TaskStatsResult extends IpcCommandResult {
  stats?: ClientTaskStats
}

export interface SelectDirectoryResult extends IpcCommandResult {
  path?: string | null
}

export interface CreateTaskInput extends CreateTaskRequest {
  subscriptionId?: string
  /** @deprecated Use subscriptionId. */
  employeeInstanceId?: string
}

export interface ExecuteTaskInput {
  taskId: string
  subscriptionId?: string
  /** @deprecated Use subscriptionId. */
  employeeInstanceId?: string
}

export interface ContinueTaskInput {
  taskId: string
  prompt: string
  subscriptionId?: string
  /** @deprecated Use subscriptionId. */
  employeeInstanceId?: string
}

export interface TaskMessagesResult {
  success: boolean
  messages?: ClientTaskMessage[]
  error?: TaskError
}

export interface ToolApprovalResponse {
  requestId?: string
  approved: boolean
  reason?: string
}

export interface ElectronAPI {
  login: (credentials: LoginRequest) => Promise<LoginResult>
  listRememberedAccounts: () => Promise<RememberedAccountsResult>
  getRememberedPassword: (email: string) => Promise<PasswordAvailabilityResult>
  forgetAccount: (email: string) => Promise<ForgetAccountResult>
  logout: () => Promise<LogoutResult>
  getCurrentSession: () => Promise<LoginResult>
  getInstances: () => Promise<InstanceListResult>
  getPackageInfo: (subscriptionId: string) => Promise<{ success: boolean; data?: PackageInfo; error?: IpcError }>
  getEmployeeSkills: (employeeId: string) => Promise<{ success: boolean; data?: EmployeeSkillsResponse; error?: IpcError }>
  getSkillPreview: (versionId: string) => Promise<{ success: boolean; data?: SkillPreviewResponse; error?: IpcError }>
  startSession: (config: { subscriptionId: string }) => Promise<IpcCommandResult>
  sendPrompt: (text: string) => Promise<{ ok: boolean }>
  stopSession: () => Promise<{ ok: boolean }>
  createTask: (data: CreateTaskInput) => Promise<TaskResult>
  executeTask: (task: string | ExecuteTaskInput) => Promise<IpcCommandResult>
  continueTask: (input: ContinueTaskInput) => Promise<IpcCommandResult>
  getTaskMessages: (taskId: string) => Promise<TaskMessagesResult>
  retryTask: (taskId: string) => Promise<IpcCommandResult>
  getTask: (taskId: string) => Promise<TaskResult>
  getAllTasks: () => Promise<TaskListResult>
  listTaskRuns: (taskId: string) => Promise<TaskRunListResult>
  getTaskRun: (taskId: string, runId: string) => Promise<TaskRunResult>
  getTaskTimeline: (taskId: string, runId: string) => Promise<TaskTimelineResult>
  pauseTask: (taskId: string) => Promise<IpcCommandResult>
  cancelTask: (taskId: string) => Promise<IpcCommandResult>
  deleteTask: (taskId: string) => Promise<IpcCommandResult>
  getTaskStats: () => Promise<TaskStatsResult>
  selectDirectory: () => Promise<SelectDirectoryResult>
  onPiEvent: (callback: (event: TaskExecutionEvent) => void) => () => void
  onToolApprovalRequest: (callback: (request: ToolAuthorizationRequest) => void) => () => void
  onTaskUpdated: (callback: (task: ClientTask) => void) => () => void
  onTaskListUpdated: (callback: (tasks: ClientTask[]) => void) => () => void
  onAuthenticationRequired: (callback: () => void) => () => void
  sendToolApprovalResponse: (response: ToolApprovalResponse) => void
}
