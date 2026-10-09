import type { NotificationPage, NotificationQuery, NotificationCategoryQuery, NotificationUpdate } from './notification-contracts'
import type { EnterpriseOrganization } from './platform-supplement-contracts'
import type {
  ComputeAllowance,
  PersonalWallet,
  WalletTransactionsPage,
  ComputeUsageRecordsPage,
  ComputeUsageBreakdown,
  ComputePageQuery,
  ComputeUsageQuery,
  ComputeBreakdownDays,
} from './compute-credit-contracts'
import type { SaveSkillInput, SaveSkillResult, SkillLibraryItem } from './skill-library'
import type {
  ClientProfile,
  EnterpriseLogoUploadResponse,
  PersonalRechargeOrder,
  PersonalRechargeRequest,
  PersonalRechargeReconcileResult,
  PersonalRechargeStatusResponse,
  UserAvatarUploadResponse,
} from './profile-wallet-contracts'
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

export type UpdateState =
  | { status: 'idle'; currentVersion: string }
  | { status: 'checking'; currentVersion: string }
  | {
      status: 'available'
      currentVersion: string
      version: string
      releaseDate: string | null
      releaseNotes: string[]
    }
  | {
      status: 'downloading'
      currentVersion: string
      version: string
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    }
  | { status: 'downloaded'; currentVersion: string; version: string }
  | { status: 'not-available'; currentVersion: string; checkedAt: string }
  | {
      status: 'error'
      currentVersion: string
      operation: 'check' | 'download' | 'cancel' | 'install'
      message: string
      retryable: boolean
    }

export interface UpdateStateResult extends IpcCommandResult {
  state?: UpdateState
}

export interface UploadInput {
  bytes: Uint8Array
  filename: string
  contentType: string
}

export interface ClientProfileResult extends IpcCommandResult {
  data?: ClientProfile
}

export interface UserAvatarUploadResult extends IpcCommandResult {
  data?: UserAvatarUploadResponse
}

export interface EnterpriseLogoUploadResult extends IpcCommandResult {
  data?: EnterpriseLogoUploadResponse
}

export interface PersonalRechargeOrderResult extends IpcCommandResult {
  data?: PersonalRechargeOrder
}

export interface PersonalRechargeStatusResult extends IpcCommandResult {
  data?: PersonalRechargeStatusResponse
}

export interface PersonalRechargeReconcileIpcResult extends IpcCommandResult {
  data?: PersonalRechargeReconcileResult
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

export interface ComputeCenterOverview {
  allowance: ComputeAllowance
  wallet: PersonalWallet
  breakdown: ComputeUsageBreakdown
}

export interface ComputeCenterOverviewResult extends IpcCommandResult {
  data?: ComputeCenterOverview
}

export interface WalletTransactionsResult extends IpcCommandResult {
  data?: WalletTransactionsPage
}

export interface ComputeUsageRecordsResult extends IpcCommandResult {
  data?: ComputeUsageRecordsPage
}

export interface ComputeUsageBreakdownResult extends IpcCommandResult {
  data?: ComputeUsageBreakdown
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
  modelId: string
}

export interface CancelArrangementPlanningInput {
  draftId: string
  planningId: string
}

export interface RequestEmployeeAccessInput {
  draftId: string
  expectedRevision: number
  stepId: string
  employeeId: string
}

export interface GetEmployeeAccessRequestInput {
  draftId: string
  requestId: string
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

export type RuntimePlatform = 'darwin' | 'win32' | 'linux' | 'unknown'
export type WindowTheme = 'light' | 'dark'

export interface WindowChromeRuntime {
  height: number
  rightInset: number
}

export interface ElectronAPI {
  getUpdateState: () => Promise<UpdateStateResult>
  checkForUpdate: () => Promise<IpcCommandResult>
  downloadUpdate: () => Promise<IpcCommandResult>
  cancelUpdateDownload: () => Promise<IpcCommandResult>
  installUpdate: () => Promise<IpcCommandResult>
  onUpdateStateChanged: (callback: (state: UpdateState) => void) => () => void
  listNotifications: (query?: NotificationQuery) => Promise<IpcCommandResult & { data?: NotificationPage }>
  getUnreadNotificationCount: (query?: NotificationCategoryQuery) => Promise<IpcCommandResult & { data?: { count: number } }>
  markNotificationRead: (id: string) => Promise<IpcCommandResult>
  markAllNotificationsRead: (query?: NotificationCategoryQuery) => Promise<IpcCommandResult>
  deleteNotification: (id: string) => Promise<IpcCommandResult>
  clearReadNotifications: (query?: NotificationCategoryQuery) => Promise<IpcCommandResult>
  openNotificationAction: (url: string) => Promise<IpcCommandResult>
  onNotificationUpdate: (callback: (event: NotificationUpdate) => void) => () => void
  platform: RuntimePlatform
  windowChrome: WindowChromeRuntime
  setWindowTheme: (theme: WindowTheme) => Promise<IpcCommandResult>
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
  getSubscriptions: () => Promise<InstanceListResult>
  getEmployeeStatus: () => Promise<EmployeeStatusResult>
  getEnterpriseOrganization: () => Promise<OrganizationResult>
  getClientProfile: () => Promise<ClientProfileResult>
  uploadUserAvatar: (input: UploadInput) => Promise<UserAvatarUploadResult>
  uploadEnterpriseLogo: (input: UploadInput) => Promise<EnterpriseLogoUploadResult>
  createPersonalRecharge: (input: PersonalRechargeRequest) => Promise<PersonalRechargeOrderResult>
  getPersonalRecharge: (orderNo: string) => Promise<PersonalRechargeStatusResult>
  reconcilePersonalRecharge: (orderNo: string) => Promise<PersonalRechargeReconcileIpcResult>
  getComputeCenterOverview: () => Promise<ComputeCenterOverviewResult>
  getPersonalWalletTransactions: (query: ComputePageQuery) => Promise<WalletTransactionsResult>
  getComputeUsageRecords: (query: ComputeUsageQuery) => Promise<ComputeUsageRecordsResult>
  getComputeUsageBreakdown: (days: ComputeBreakdownDays) => Promise<ComputeUsageBreakdownResult>
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
  requestEmployeeAccess: (input: RequestEmployeeAccessInput) => Promise<ArrangementDraftResult>
  getEmployeeAccessRequest: (input: GetEmployeeAccessRequestInput) => Promise<ArrangementDraftResult>
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
}
