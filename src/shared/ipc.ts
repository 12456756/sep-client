import type {
  ClientTask,
  ClientTaskStats,
  CreateTaskRequest,
  Subscription,
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
  ArrangementPlanResult,
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
  data?: Subscription[]
}

export interface TaskStatsResult extends IpcCommandResult {
  stats?: ClientTaskStats
}

export interface SelectDirectoryResult extends IpcCommandResult {
  path?: string | null
}

export interface CreateTaskInput extends CreateTaskRequest {
  subscriptionId: string
}

export interface ExecuteTaskInput {
  taskId: string
}

export interface ContinueTaskInput {
  taskId: string
  prompt: string
  recoveryMode?: 'strict' | 'confirm_rebuild' | 'auto_rebuild_from_task_history'
  confirmRecovery?: boolean
}

export interface CreateConversationInput {
  title: string
  prompt: string
  workDir?: string
  subscriptionId: string
}

export interface SwitchConversationEmployeeInput {
  taskId: string
  subscriptionId: string
}

export interface RetryTaskInput {
  taskId: string
  nodeId?: string
}

export interface TaskMessagesResult {
  success: boolean
  messages?: ClientTaskMessage[]
  error?: TaskError
}

export interface ToolApprovalResponse {
  /**
   * 必填。审批结果只按 requestId 匹配，主进程不做任何"只有一个 pending 就当它"的推断
   * ——那样会批准错的工具调用（见后端方案 C5）。
   */
  requestId: string
  approved: boolean
  reason?: string
}

export interface ElectronAPI {
  login: (credentials: LoginRequest) => Promise<LoginResult>
  listRememberedAccounts: () => Promise<RememberedAccountsResult>
  getRememberedPassword: (email: string) => Promise<PasswordAvailabilityResult>
  forgetAccount: (email: string) => Promise<ForgetAccountResult>
  logout: () => Promise<LogoutResult>
  getSubscriptions: () => Promise<InstanceListResult>
  createTask: (data: CreateTaskInput) => Promise<TaskResult>
  createConversation: (data: CreateConversationInput) => Promise<TaskResult>
  executeTask: (task: string | ExecuteTaskInput) => Promise<IpcCommandResult>
  continueTask: (input: ContinueTaskInput) => Promise<IpcCommandResult>
  switchConversationEmployee: (input: SwitchConversationEmployeeInput) => Promise<IpcCommandResult>
  getTaskMessages: (taskId: string) => Promise<TaskMessagesResult>
  retryTask: (input: string | RetryTaskInput) => Promise<IpcCommandResult>
  getTask: (taskId: string) => Promise<TaskResult>
  getAllTasks: () => Promise<TaskListResult>
  listTaskRuns: (taskId: string) => Promise<TaskRunListResult>
  getTaskRun: (taskId: string, runId: string) => Promise<TaskRunResult>
  getTaskTimeline: (taskId: string, runId: string) => Promise<TaskTimelineResult>
  pauseTask: (taskId: string) => Promise<IpcCommandResult>
  cancelTask: (taskId: string) => Promise<IpcCommandResult>
  getArrangementContext: () => Promise<unknown>
  getArrangementPlan: (taskId: string) => Promise<ArrangementPlanResult>
  listArrangementDrafts: () => Promise<unknown>
  createArrangementDraft: (input: unknown) => Promise<unknown>
  getArrangementDraft: (draftId: string) => Promise<unknown>
  updateArrangementDraft: (input: unknown) => Promise<unknown>
  deleteArrangementDraft: (draftId: string) => Promise<unknown>
  validateArrangementDraft: (draftId: string) => Promise<unknown>
  preflightArrangementDraft: (input: unknown) => Promise<unknown>
  confirmArrangementDraft: (input: unknown) => Promise<unknown>
  confirmAndStartArrangement: (input: unknown) => Promise<unknown>
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

