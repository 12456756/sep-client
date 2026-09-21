/**
 * 主进程与渲染进程共享的类型定义
 * IPC 通道两侧均引用此文件
 */

// ──────────────────────────── Auth ─────────────────────────────

export interface LoginRequest {
  email: string
  password?: string
  rememberPassword: boolean
  useSavedPassword: boolean
}

export interface RememberedAccount {
  email: string
  displayName: string
  enterpriseName: string
  lastLoginAt: string
  hasSavedPassword: boolean
}

export interface RememberedAccountsResult {
  accounts: RememberedAccount[]
  encryptionAvailable: boolean
}

export type AuthErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'INTERNAL_ERROR'

export interface AuthError {
  code: AuthErrorCode
  message: string
  statusCode: number
  retryable?: boolean
}

export interface AuthResult<T> {
  success: boolean
  data?: T
  error?: AuthError
}

export interface LoginData {
  user: { id: string; email: string; name: string }
  enterprise: { id: string; name: string } | null
}

export type LoginResult = AuthResult<LoginData>
export type PasswordAvailabilityResult = { passwordAvailable: boolean }
export type ForgetAccountResult = AuthResult<null>
export type LogoutResult = AuthResult<null>

export interface RuntimeInfo {
  version: string
  channel: 'beta' | 'stable'
  environment: string
  apiBaseUrl: string
  gatewayUrl: string
  buildTime: string
}

// ──────────────────────────── Tasks ────────────────────────────

export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  PAUSED: 'paused',
  INTERRUPTED: 'interrupted',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type ClientTaskStatus = typeof TaskStatus[keyof typeof TaskStatus]
export type ClientTaskLogLevel = 'info' | 'warning' | 'error'

export interface ClientTaskLog {
  timestamp: number
  message: string
  level?: ClientTaskLogLevel
}

/** Serialized task shape returned by Electron main. */
export interface ClientTask {
  id: string
  title: string
  prompt: string
  status: ClientTaskStatus
  workDir: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  error: string | null
  files: string[]
  logs: ClientTaskLog[]
  progress?: number
  ownerId: string
  ownerEnterpriseId: string
  subscriptionId?: string | null
  activeRunId: string | null
}

export type ClientTaskRunOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped' | 'interrupted'

/** Renderer-safe summary of one persisted execution attempt. */
export interface ClientTaskRun {
  id: string
  taskId: string
  subscriptionId: string
  modelId: string
  runtimeKey: string
  outcome: ClientTaskRunOutcome
  startedAt: number
  endedAt: number | null
  sessionId: string | null
  error: string | null
}

export interface ClientTaskMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  runId: string
}

export interface ClientTaskStats {
  total: number
  pending: number
  running: number
  waitingApproval: number
  paused: number
  interrupted: number
  completed: number
  failed: number
}

export type TaskErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'PERSISTENCE_ERROR'
  | 'INTERNAL_ERROR'

export interface TaskError {
  code: TaskErrorCode
  message: string
}

export interface TaskListResult {
  success: boolean
  tasks?: ClientTask[]
  error?: TaskError
}

export interface TaskResult {
  success: boolean
  task?: ClientTask
  error?: TaskError
}

export interface TaskRunListResult {
  success: boolean
  runs?: ClientTaskRun[]
  error?: TaskError
}

export interface TaskRunResult {
  success: boolean
  run?: ClientTaskRun
  error?: TaskError
}

export interface TaskTimelineResult {
  success: boolean
  events?: TaskExecutionEvent[]
  error?: TaskError
}

export type ArrangementMode = 'conversation' | 'auto' | 'manual'
export type ArrangementPermissionPreset = 'read-only' | 'workspace-edit' | 'full-local'
export type ArrangementCommandPolicy = 'disabled' | 'restricted' | 'confirm-each'
export type ArrangementApprovalMode = 'confirm-each' | 'auto-approve'

export interface ArrangementParticipantSnapshot {
  subscriptionId: string
  modelId: string
}

export interface ArrangementNodeSnapshot {
  id: string
  subscriptionId: string
  modelId: string
  title: string
  instruction: string
  expectedOutput: string
  dependsOn: string[]
  skillIds: string[]
  requiresUserConfirmation: boolean
}

export interface ArrangementPermissionSnapshot {
  preset: ArrangementPermissionPreset
  allowedTools: string[]
  allowedPaths: string[]
  deniedPaths: string[]
  requireApprovalFor: string[]
  commandPolicy: ArrangementCommandPolicy
  approvalMode: ArrangementApprovalMode
}

export interface ArrangementPlanSnapshot {
  id: string
  schemaVersion: 1
  sourceDraftId: string
  sourceDraftRevision: number
  owner: { memberId: string; enterpriseId: string }
  mode: ArrangementMode
  title: string
  goal: string
  conversation: {
    participants: ArrangementParticipantSnapshot[]
    activeSubscriptionId: string | null
  } | null
  nodes: ArrangementNodeSnapshot[]
  workspace: { mode: 'shared'; path: string | null }
  permissions: ArrangementPermissionSnapshot
  confirmedInputs: string[]
  planHash: string
  createdAt: number
}

export type ArrangementDraftStatus = 'editing' | 'planning' | 'planning-failed' | 'ready' | 'preflight-failed' | 'confirmed'

export interface ArrangementDraftNode {
  id: string
  subscriptionId: string
  modelId: string
  title: string
  instruction: string
  expectedOutput: string
  dependsOn: string[]
  skillIds: string[]
  requiresUserConfirmation: boolean
}

export interface ArrangementDraftDocument {
  schemaVersion: 1
  mode: ArrangementMode
  title: string
  goal: string
  confirmedInputs: string[]
  sharedSkillIds: string[]
  conversation: {
    participants: ArrangementParticipantSnapshot[]
    activeSubscriptionId: string | null
  } | null
  nodes: ArrangementDraftNode[]
  workspace: { mode: 'shared'; path: string | null }
  permissions: {
    preset: ArrangementPermissionPreset
    allowedPaths?: string[]
    deniedPaths?: string[]
    commandPolicy?: ArrangementCommandPolicy
    allowWithoutApproval?: boolean
    approvalMode?: ArrangementApprovalMode
  }
  lastPlanning: {
    planningId: string
    status: 'planning' | 'ready' | 'failed' | 'cancelled'
    message: string | null
  } | null
}

export interface ArrangementDraft extends ArrangementDraftDocument {
  id: string
  revision: number
  status: ArrangementDraftStatus
  owner: { memberId: string; enterpriseId: string }
  createdAt: number
  updatedAt: number
  confirmedWorkPlanId?: string | null
}

export interface ArrangementDraftResult {
  success: boolean
  draft?: ArrangementDraft
  error?: TaskError
}

export interface ArrangementDraftListResult {
  success: boolean
  drafts?: ArrangementDraft[]
  error?: TaskError
}

export interface ArrangementDraftPreflightResult {
  success: boolean
  preflight?: {
    preflightId: string
    draftId: string
    draftRevision: number
    valid: boolean
    canStart: boolean
    blockingIssues: string[]
  }
  error?: TaskError
}

export interface ArrangementPlanResult {
  success: boolean
  plan?: ArrangementPlanSnapshot | null
  error?: TaskError
}

export interface CreateTaskRequest {
  title: string
  prompt: string
  workDir?: string
}

export interface AuthSession {
  memberId: string
  enterpriseId: string
  displayName: string
  enterpriseName: string
}

// ──────────────────────────── Instances ────────────────────────

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED'

export interface Subscription {
  id: string
  subscriptionId: string
  employeeId: string
  name: string
  description?: string
  position?: string
  functionalCategory?: string
  status: SubscriptionStatus
  templateVersion: string
  template: {
    id: string
    name: string
    avatar: string | null
  }
  department: unknown
  allowedModels: string[]
  upgradeAvailable: boolean
}

// ──────────────────────────── Pi Events ────────────────────────

/** Pi 事件类型（参见接口文档第 4.3 节）。 */
export interface EmployeeStatus {
  employeeId: string
  status: string
}

export interface PlatformSkillCapability {
  id: string
  name: string
  description: string
  type: string
}

export interface PlatformSkillVersion {
  id: string
  capabilityId: string
  scope: string
  enterpriseId: string | null
  version: string
  changeSummary: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface PlatformEmployeeSkill {
  capability: PlatformSkillCapability
  currentVersion: PlatformSkillVersion
  versions: unknown[]
  upgradeAvailable: boolean
}

export interface EmployeeSkillsResponse {
  subscriptionId: string
  canManage: boolean
  skills: PlatformEmployeeSkill[]
}

export interface SkillPreviewResponse {
  content: string
  [key: string]: unknown
}

export type PiEventType =
  | 'text_delta'
  | 'tool_execution_start'
  | 'tool_execution_end'
  | 'agent_end'
  | 'tool_call_blocked'
  | 'session_error'

export interface PiTextDeltaEvent {
  type: 'text_delta'
  text: string
}

export interface PiToolStartEvent {
  type: 'tool_execution_start'
  toolId: string       // unique per invocation
  toolName: string
  input: Record<string, unknown>
}

export interface PiToolEndEvent {
  type: 'tool_execution_end'
  toolId: string
  success: boolean
  error?: string
}

export interface PiAgentEndEvent {
  type: 'agent_end'
  usage?: { inputTokens: number; outputTokens: number; cost?: number }
}

export interface PiToolBlockedEvent {
  type: 'tool_call_blocked'
  toolName: string
  reason: string
}

export interface PiSessionErrorEvent {
  type: 'session_error'
  message: string
}

export type PiClientEvent =
  | PiTextDeltaEvent
  | PiToolStartEvent
  | PiToolEndEvent
  | PiAgentEndEvent
  | PiToolBlockedEvent
  | PiSessionErrorEvent

// ──────────────────────────── Permission ───────────────────────

export interface TaskExecutionEvent {
  taskId: string
  runId: string
  subscriptionId: string
  sequence: number
  type: string
  occurredAt: number
  data: unknown
}

export interface ToolAuthorizationRequest {
  requestId: string
  taskId: string
  runId: string
  subscriptionId: string
  toolName: string
  input: unknown
  timestamp: number
}

/** 高危工具调用，等待用户批准（文档 §6.2 措施 ④） */
export interface PermissionRequest {
  requestId: string     // UUID，用于响应时匹配请求。
  subscriptionId: string
  subscriptionDisplayName: string
  toolName: string
  description: string   // 人读说明，如"写入文件 ~/Documents/..."
  inputSummary: Record<string, unknown>
}

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny'

// ──────────────────────────── Client State ─────────────────────

export type SessionState = 'idle' | 'running' | 'awaiting-permission' | 'error' | 'locked'

export interface ClientState {
  auth: AuthSession | null
  sessionState: SessionState
  lockReason?: string
}



export type ArrangementPlanningProgressType =
  | 'arrangement_planning_started'
  | 'arrangement_employee_considering'
  | 'arrangement_employee_selected'
  | 'arrangement_planning_completed'
  | 'arrangement_planning_failed'
  | 'arrangement_planning_cancelled'

export interface ArrangementPlanningProgress {
  planningId: string
  draftId: string
  draftRevision: number
  type: ArrangementPlanningProgressType
  occurredAt: number
  data: {
    subscriptionId?: string
    employeeId?: string
    stage?: string
    rationale?: string
    nodeId?: string
    title?: string
    message?: string
  }
}
