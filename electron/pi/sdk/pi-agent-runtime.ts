import type { ModelRequestKind, ModelRequestProgress } from '../../domain/model-request-progress'

/** Maximum consecutive automatic retries; a successful SDK round resets the budget. */
export const MAX_RUN_AUTO_RETRIES = 5

export interface PiAgentEvent {
  type: string
  data: unknown
  failure?: string
}

export interface PiAgentSession {
  getContextUsage?(): import('../../../src/shared/context-usage').ContextUsage | null
  setDiagnostics?(config: Pick<PiAgentSessionConfig, 'runId' | 'taskTitle' | 'tracePhase' | 'nodeTitle' | 'modelTrace'>): void
  setRequestPurpose?(purpose: string): void
  readonly sessionId: string
  readonly sessionFile: string | null
  /** Complete host-only reply for delivery validation; never forward it as an event or log field. */
  getSettledResponse?(): { text: string; stopReason?: string }
  getContextCheckpoint?(): string | null
  restoreContextCheckpoint?(checkpoint: string | null): Promise<void>
  prompt(text: string, options?: { images?: readonly { type: 'image'; data: string; mimeType: string }[] }): Promise<void>
  abort(): Promise<void>
  subscribe(listener: (event: PiAgentEvent) => void): () => void
  dispose(): Promise<void>
}

/** Trusted host configuration only; never supplied by the model or renderer. */
export interface McpServerConfig {
  name: string
  transport:
    | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { type: 'streamable-http'; url: string; headers?: Record<string, string> }
  /** Original MCP names. Empty or omitted means no tools are enabled. */
  enabledTools?: readonly string[]
  /** Explicit opt-in; server annotations never grant permission. */
  autoApproveTools?: readonly string[]
  timeoutMs?: number
}

export interface PiAgentSessionConfig {
  /** Host-owned, conversation-scoped browser; never supplied through IPC. */
  browserOwner?: import('./pi-browser-owner').SharedBrowserOwner
  connectorBinding?: import('../../domain/connectors').ConnectorBinding
  modelTrace?: import('../../domain/model-trace').ModelTraceRecorder
  taskTitle?: string
  tracePhase?: string
  nodeTitle?: string
  runId: string
  modelId: string
  vision?: boolean | null
  gatewayUrl: string
  workspaceDir: string
  agentDir: string
  sessionDir: string
  resumeSessionFile?: string
  additionalSkillPaths?: string[]
  systemPrompt?: string
  /** Keep the SDK base and employee-scoped Skills, without the old employee prompt override/appendix. */
  useNativeSystemPrompt?: boolean
  disableSkills?: boolean
  /** Host-only transform of the SDK-assembled prompt; preserves SDK resource loading. */
  transformSystemPrompt?: (systemPrompt: string) => string
  /** Enable trusted built-in common capabilities while keeping employee skills disabled. */
  enableCommonTools?: boolean
  mediaTools?: import('../../domain/media-tools').MediaHostTools
  videoTools?: import('../../domain/video-tools').VideoHostTools
  conversationAttachments?: import('../../domain/attachment-input').ConversationAttachmentReader
  conversationSchedule?: import('./pi-conversation-schedule').ConversationScheduleTool
  localMedia?: import('../../domain/local-media-tools').LocalMediaTool
  /** Host-only conversation ID, bound after validating the conversation result directory. */
  browserArtifactTaskId?: string
  browserTaskStateDir?: string
  employeeProfile?: import('../../domain/employee-profile').EmployeeProfile
  /** Host-owned instructions retained outside compacted conversation history. */
  fixedSystemPrompt?: string
  arrangementNodeId?: string
  /** Must durably record the attempt before resolving; failures must prevent provider I/O. */
  onModelRequest?: (kind: ModelRequestKind) => Promise<ModelRequestProgress>
  /** Controls prompt text only; request counting, persistence and logs remain enabled. */
  modelRequestAwareness?: boolean
  mcpServers?: readonly McpServerConfig[]
  getAccessToken: () => Promise<string>
  authorizeTool: (request: Pick<import('../../../src/shared/types').ToolAuthorizationRequest, 'toolName' | 'input' | 'registeredTool' | 'summary'>) => Promise<boolean>
  reportPolicyEvent?: (type: string, data: unknown) => Promise<void> | void
  /** 任务级策略；缺省表示兼容旧的普通任务审批行为。 */
  toolPolicy?: import('../../../pi-extension/guard').ToolPolicy
  /** Planner-only escape hatch: do not advertise any Pi tools. */
  disableTools?: boolean
}

export interface PiAgentRuntime {
  createSession(config: PiAgentSessionConfig): Promise<PiAgentSession>
}
