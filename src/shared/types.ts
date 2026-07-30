/**
 * 主进程与渲染进程共享的类型定义
 * IPC 通道两侧均引用此文件
 */

// ──────────────────────────── Auth ─────────────────────────────

export interface LoginCredentials {
  email: string
  password: string
}

export interface AuthSession {
  accessToken: string
  memberId: string
  enterpriseId: string
  displayName: string
  enterpriseName: string
}

// ──────────────────────────── Instances ────────────────────────

export type InstanceStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED'

export interface PackageRef {
  type: 'npm' | 'git' | 'zip'
  spec: string          // e.g. "@sep/employee-video@1.2.0" or git URL
}

export interface EmployeeInstance {
  instanceId: string
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

// ──────────────────────────── Pi Events ────────────────────────

/** pi 事件类型（见文档 §4.3） */
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

/** 高危工具调用，等待用户批准（文档 §6.2 措施 ④） */
export interface PermissionRequest {
  requestId: string     // UUID，用于响应时匹配
  instanceId: string
  instanceDisplayName: string
  toolName: string
  description: string   // 人读说明，如"写入文件 ~/Documents/..."
  inputSummary: Record<string, unknown>
}

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny'

// ──────────────────────────── Client State ─────────────────────

export type SessionState = 'idle' | 'running' | 'awaiting-permission' | 'error' | 'locked'

export interface ClientState {
  auth: AuthSession | null
  activeInstanceId: string | null
  sessionState: SessionState
  lockReason?: string
}
