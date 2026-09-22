import type { EnterpriseOrganization } from './platform-supplement-contracts'
import type { SaveSkillInput, SaveSkillResult, SkillLibraryItem } from './skill-library'
import type {
  ClientTask,
  ClientTaskStats,
  CreateTaskRequest,
  Subscription,
  EmployeeStatus,
  EmployeeSkillsResponse,
  SkillPreviewResponse,
  ForgetAccountResult,
  LoginRequest,
  LoginResult,
  LogoutResult,
  RuntimeInfo,
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
  ArrangementDraftDocument,
  ArrangementDraftListResult,
  ArrangementDraftPreflightResult,
  ArrangementPlanSnapshot,
  ArrangementDraftResult,
  ArrangementPlanningProgress,
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

export interface EmployeeStatusResult extends IpcCommandResult {
  data?: EmployeeStatus[]
}

export interface OrganizationResult extends IpcCommandResult {
  data?: EnterpriseOrganization
}

export interface EmployeeSkillsResult extends IpcCommandResult {
  data?: EmployeeSkillsResponse
}

export interface SkillPreviewResult extends IpcCommandResult {
  data?: SkillPreviewResponse
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

export interface PlanArrangementDraftInput {
  draftId: string
  expectedRevision: number
}

export interface CancelArrangementPlanningInput {
  draftId: string
  planningId: string
}

export interface ArrangementPlanningStartResult extends IpcCommandResult {
  draftId?: string
  planningId?: string
  status?: 'planning'
}

export interface ArrangementPlanningCancelResult extends IpcCommandResult {
  cancelled?: boolean
}

export interface ToolApprovalResponse {
  /** Approval responses are matched by requestId only. */
  requestId: string
  approved: boolean
  reason?: string
}

export interface ElectronAPI {
  listSkillLibrary: () => Promise<IpcCommandResult & { data?: SkillLibraryItem[] }>
  previewLibrarySkill: (input: { capabilityId: string; versionId: string }) => Promise<IpcCommandResult & { data?: string }>
  selectSkillVersion: (input: { capabilityId: string; versionId: string }) => Promise<IpcCommandResult>
  savePersonalSkill: (input: SaveSkillInput) => Promise<IpcCommandResult & { data?: SaveSkillResult }>
  retryPersonalSkillUpload: (input: { capabilityId: string; idempotencyKey: string }) => Promise<IpcCommandResult & { data?: SaveSkillResult }>
  login: (credentials: LoginRequest) => Promise<LoginResult>
  listRememberedAccounts: () => Promise<RememberedAccountsResult>
  getRememberedPassword: (email: string) => Promise<PasswordAvailabilityResult>
  /** Only invoked by an explicit password reveal gesture; never cache this response. */
  revealRememberedPassword: (email: string) => Promise<{ password: string | null }>
  forgetAccount: (email: string) => Promise<ForgetAccountResult>
  logout: () => Promise<LogoutResult>
  getRuntimeInfo: () => Promise<IpcCommandResult & { data?: RuntimeInfo }>
  getSubscriptions: () => Promise<InstanceListResult>
  getEmployeeStatus: () => Promise<EmployeeStatusResult>
  getEnterpriseOrganization: () => Promise<OrganizationResult>
  getEmployeeSkills: (employeeId: string) => Promise<EmployeeSkillsResult>
  previewSkill: (versionId: string) => Promise<SkillPreviewResult>
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
  cancelTask: (taskId: string, reason?: string) => Promise<IpcCommandResult>
  getArrangementContext: () => Promise<unknown>
  getArrangementPlan: (taskId: string) => Promise<ArrangementPlanResult>
  listArrangementDrafts: () => Promise<ArrangementDraftListResult>
  createArrangementDraft: (input: ArrangementDraftDocument) => Promise<ArrangementDraftResult>
  getArrangementDraft: (draftId: string) => Promise<ArrangementDraftResult>
  updateArrangementDraft: (input: { draftId: string; expectedRevision: number; document: ArrangementDraftDocument }) => Promise<ArrangementDraftResult>
  deleteArrangementDraft: (draftId: string) => Promise<unknown>
  validateArrangementDraft: (draftId: string) => Promise<unknown>
  preflightArrangementDraft: (input: { draftId: string; expectedRevision: number }) => Promise<ArrangementDraftPreflightResult>
  confirmArrangementDraft: (input: { draftId: string; expectedRevision: number; idempotencyKey: string }) => Promise<unknown>
  confirmAndStartArrangement: (input: { draftId: string; expectedRevision: number; idempotencyKey: string }) => Promise<{ success: boolean; plan?: ArrangementPlanSnapshot; execution?: { id: string; status: 'queued' | 'running' }; error?: TaskError }>
  planArrangementDraft: (input: PlanArrangementDraftInput) => Promise<ArrangementPlanningStartResult>
  cancelArrangementPlanning: (input: CancelArrangementPlanningInput) => Promise<ArrangementPlanningCancelResult>
  deleteTask: (taskId: string) => Promise<IpcCommandResult>
  getTaskStats: () => Promise<TaskStatsResult>
  selectDirectory: () => Promise<SelectDirectoryResult>
  onPiEvent: (callback: (event: TaskExecutionEvent) => void) => () => void
  onToolApprovalRequest: (callback: (request: ToolAuthorizationRequest) => void) => () => void
  onTaskUpdated: (callback: (task: ClientTask) => void) => () => void
  onTaskListUpdated: (callback: (tasks: ClientTask[]) => void) => () => void
  onAuthenticationRequired: (callback: () => void) => () => void
  onArrangementPlanningEvent: (callback: (event: ArrangementPlanningProgress) => void) => () => void
  sendToolApprovalResponse: (response: ToolApprovalResponse) => void
  // 性能监控和错误日志方法
  logError: (error: { message: string; stack?: string; componentStack?: string; timestamp?: number }) => Promise<void>
  logPerformance: (metrics: Record<string, number | string | undefined>) => Promise<void>
}
