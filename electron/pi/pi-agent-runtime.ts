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

export interface PiAgentSessionConfig {
  runId: string
  modelId: string
  gatewayUrl: string
  workspaceDir: string
  agentDir: string
  sessionDir: string
  resumeSessionFile?: string
  getAccessToken: () => Promise<string>
  /** Force one employment-token refresh after a gateway 401. */
  refreshAccessToken?: () => Promise<string>
  /** Invalidate cached subscription state after a gateway authorization rejection. */
  onGatewayAuthorizationRejected?: (status: 403 | 404) => void
  authorizeTool: (request: { toolName: string; input: unknown }) => Promise<boolean>
  /** Subscription-isolated skills/context; never read from global ~/.pi. */
  skillPaths?: string[]
  agentsFiles?: Array<{ path: string; content: string }>
  systemPrompt?: string
}

export interface PiAgentRuntime {
  createSession(config: PiAgentSessionConfig): Promise<PiAgentSession>
}
