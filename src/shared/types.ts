/**
 * 涓昏繘绋嬩笌娓叉煋杩涚▼鍏变韩鐨勭被鍨嬪畾涔?
 * IPC 閫氶亾涓や晶鍧囧紩鐢ㄦ鏂囦欢
 */

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ Auth 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ Tasks 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ Instances 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export type InstanceStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED'

export interface EmployeeInstanceSnapshot {
  id: string
  name: string
  status: InstanceStatus
  templateVersion: string
  template: {
    id: string
    name: string
    avatar: string | null
  }
  department: {
    id: string
    name: string
  } | null
  allowedModels: string[]
}

export interface PackageRef {
  type: 'npm' | 'git' | 'zip'
  spec: string          // e.g. "@sep/employee-video@1.2.0" or git URL
}

export interface EmployeeInstance {
  subscriptionId: string
  displayName: string
  description?: string
  templateId: string
  lockedVersion: string
  packageRef: PackageRef | null
  config: Record<string, unknown>
  allowedTools: string[]
  allowedModels: string[]
  status: InstanceStatus
}

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ Pi Events 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** Pi 事件类型（参见接口文档第 4.3 节）。 */
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

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ Permission 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

/** 楂樺嵄宸ュ叿璋冪敤锛岀瓑寰呯敤鎴锋壒鍑嗭紙鏂囨。 搂6.2 鎺柦 鈶ｏ級 */
export interface PermissionRequest {
  requestId: string     // UUID，用于响应时匹配请求。
  subscriptionId: string
  subscriptionDisplayName: string
  toolName: string
  description: string   // 浜鸿璇存槑锛屽"鍐欏叆鏂囦欢 ~/Documents/..."
  inputSummary: Record<string, unknown>
}

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny'

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ Client State 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export type SessionState = 'idle' | 'running' | 'awaiting-permission' | 'error' | 'locked'

export interface ClientState {
  auth: AuthSession | null
  sessionState: SessionState
  lockReason?: string
}
