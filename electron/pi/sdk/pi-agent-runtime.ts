import type { ModelRequestKind, ModelRequestProgress } from '../../domain/model-request-progress'

/** Maximum consecutive automatic retries; a successful SDK round resets the budget. */
export const MAX_RUN_AUTO_RETRIES = 3

export interface PiAgentEvent {
  type: string
  data: unknown
  failure?: string
}

export interface PiAgentSession {
  setDiagnostics?(config: Pick<PiAgentSessionConfig, 'runId' | 'taskTitle' | 'tracePhase' | 'nodeTitle' | 'modelTrace'>): void
  setRequestPurpose?(purpose: string): void
  readonly sessionId: string
  readonly sessionFile: string | null
  /** Complete host-only reply for delivery validation; never forward it as an event or log field. */
  getSettledResponse?(): { text: string; stopReason?: string }
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
  modelTrace?: import('../../domain/model-trace').ModelTraceRecorder
  taskTitle?: string
  tracePhase?: string
  nodeTitle?: string
  runId: string
  modelId: string
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
  mediaTools?: import('../../domain/media-tools').MediaHostTools
  videoTools?: import('../../domain/video-tools').VideoHostTools
  employeeProfile?: import('../../domain/employee-profile').EmployeeProfile
  /** Host-owned instructions retained outside compacted conversation history. */
  fixedSystemPrompt?: string
  /** Must durably record the attempt before resolving; failures must prevent provider I/O. */
  onModelRequest?: (kind: ModelRequestKind) => Promise<ModelRequestProgress>
  /** Controls prompt text only; request counting, persistence and logs remain enabled. */
  modelRequestAwareness?: boolean
  mcpServers?: readonly McpServerConfig[]
  getAccessToken: () => Promise<string>
  authorizeTool: (request: { toolName: string; input: unknown }) => Promise<boolean>
  reportPolicyEvent?: (type: string, data: unknown) => Promise<void> | void
  /** 任务级策略；缺省表示兼容旧的普通任务审批行为。 */
  toolPolicy?: import('../../../pi-extension/guard').ToolPolicy
  /** Planner-only escape hatch: do not advertise any Pi tools. */
  disableTools?: boolean
}

export interface PiAgentRuntime {
  createSession(config: PiAgentSessionConfig): Promise<PiAgentSession>
}


