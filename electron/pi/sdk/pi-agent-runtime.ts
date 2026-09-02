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
  additionalSkillPaths?: string[]
  getAccessToken: () => Promise<string>
  authorizeTool: (request: { toolName: string; input: unknown }) => Promise<boolean>
  reportPolicyEvent?: (type: string, data: unknown) => Promise<void> | void
}

export interface PiAgentRuntime {
  createSession(config: PiAgentSessionConfig): Promise<PiAgentSession>
}
