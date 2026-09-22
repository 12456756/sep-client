/** One retry budget per user turn, including retries separated by successful tool calls. */
export const MAX_RUN_AUTO_RETRIES = 3

export interface PiAgentEvent {
  type: string
  data: unknown
  failure?: string
}

export interface PiAgentSession {
  readonly sessionId: string
  readonly sessionFile: string | null
  prompt(text: string): Promise<void>
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
  runId: string
  modelId: string
  gatewayUrl: string
  workspaceDir: string
  agentDir: string
  sessionDir: string
  resumeSessionFile?: string
  additionalSkillPaths?: string[]
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


