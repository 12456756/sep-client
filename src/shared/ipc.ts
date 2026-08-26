import type {
  ClientTask,
  ClientTaskStats,
  CreateTaskRequest,
  EmployeeInstanceSnapshot,
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
  data?: EmployeeInstanceSnapshot[]
}

export interface TaskStatsResult extends IpcCommandResult {
  stats?: ClientTaskStats
}

export interface SelectDirectoryResult extends IpcCommandResult {
  path?: string | null
}

export interface CreateTaskInput extends CreateTaskRequest {
  employeeInstanceId: string
}

export interface ExecuteTaskInput {
  taskId: string
}

export interface ContinueTaskInput {
  taskId: string
  prompt: string
}

export interface WorkflowCreateResult extends TaskResult {
  graph?: unknown
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
  getInstances: () => Promise<InstanceListResult>
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
  createWorkflow: (data: unknown) => Promise<WorkflowCreateResult>
  validateWorkflow: (data: unknown) => Promise<WorkflowCreateResult>
  getWorkflow: (taskId: string) => Promise<WorkflowCreateResult>
  startWorkflow: (taskId: string) => Promise<IpcCommandResult>
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
