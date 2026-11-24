import type { PiAgentEvent, PiAgentRuntime, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'
import { SharedBrowserOwner } from './pi-browser-owner'

/**
 * 为一个任务维护一个持久化 Pi 会话。
 * 切换员工时使用同一个会话文件重建 AgentSession，确保持久化历史始终
 * 是唯一的对话上下文来源。
 */
export class SharedPiSession {
  private browserPolicyKey?: string
  private session: PiAgentSession | null = null
  private sessionFile: string | null = null
  private vision: boolean | null = null
  private modelId: string | undefined
  private managedFileTools = false
  private connectorRevision: string | undefined
  private localMediaBinding?: { host: NonNullable<PiAgentSessionConfig['localMedia']> }
  private scheduleBinding?: { submit: NonNullable<PiAgentSessionConfig['conversationSchedule']> }
  private approvalBinding?: { authorize: PiAgentSessionConfig['authorizeTool'] }
  private browserArtifactTaskId?: string
  private browserTaskStateDir?: string
  private unsubscribeSession: (() => void) | null = null
  private listener: ((event: PiAgentEvent) => void) | null = null
  private disposed = false
  private operation: Promise<void> = Promise.resolve()
  private readonly browserOwner = new SharedBrowserOwner()

  constructor(private readonly runtime: PiAgentRuntime) {}

  get currentSession(): PiAgentSession | null {
    return this.session
  }

  get currentSessionFile(): string | null {
    return this.sessionFile
  }

  async open(config: PiAgentSessionConfig): Promise<PiAgentSession> {
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Shared Pi session adapter has been disposed.')
      this.browserOwner.resume()
      if (this.session && this.browserPolicyKey !== this.browserPolicy(config)) await this.disposeCurrent()
      // Tools close over the current run's file grants and created-file identities.
      if (this.session && !this.managedFileTools && !config.toolPolicy?.fileAccess && this.modelId === config.modelId && this.vision === (config.vision ?? null) && this.connectorRevision === config.connectorBinding?.revision && !!this.localMediaBinding === !!config.localMedia && !!this.scheduleBinding === !!config.conversationSchedule && this.browserArtifactTaskId === config.browserArtifactTaskId && this.browserTaskStateDir === config.browserTaskStateDir) {
        if (this.localMediaBinding && config.localMedia) this.localMediaBinding.host = config.localMedia
        if (this.scheduleBinding && config.conversationSchedule) this.scheduleBinding.submit = config.conversationSchedule
        if (this.approvalBinding) this.approvalBinding.authorize = config.authorizeTool
        return this.session
      }
      if (this.session) await this.disposeCurrent()
      const session = await this.runtime.createSession({
        ...this.bindTurn(config),
        browserOwner: this.browserOwner,
        resumeSessionFile: this.sessionFile ?? config.resumeSessionFile,
      })
      this.session = session
      this.modelId = config.modelId
      this.vision = config.vision ?? null
      this.connectorRevision = config.connectorBinding?.revision
      this.sessionFile = session.sessionFile ?? this.sessionFile ?? config.resumeSessionFile ?? null
      this.bindSessionEvents(session)
      return session
    })
  }

  async switchEmployee(config: PiAgentSessionConfig): Promise<PiAgentSession> {
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Shared Pi session adapter has been disposed.')
      this.browserOwner.resume()
      const resumeSessionFile = this.sessionFile ?? config.resumeSessionFile
      await this.disposeCurrent()
      const session = await this.runtime.createSession({ ...this.bindTurn(config), browserOwner: this.browserOwner, resumeSessionFile: resumeSessionFile ?? undefined })
      this.session = session
      this.modelId = config.modelId
      this.vision = config.vision ?? null
      this.connectorRevision = config.connectorBinding?.revision
      this.sessionFile = session.sessionFile ?? resumeSessionFile ?? null
      this.bindSessionEvents(session)
      return session
    })
  }

/** 释放当前 AgentSession，但保留持久化的 sessionFile。 */
  async reset(): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) return
      await this.disposeCurrent()
    })
  }

  subscribe(listener: (event: PiAgentEvent) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  async dispose(): Promise<void> {
    const closingBrowser = this.browserOwner.dispose()
    await this.enqueue(async () => {
      if (this.disposed) return
      this.disposed = true
      try { await this.disposeCurrent() } finally { await closingBrowser }
      this.listener = null
    })
  }

  closeBrowser(): Promise<void> { return this.browserOwner.revoke() }

  private bindSessionEvents(session: PiAgentSession): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = session.subscribe(event => this.listener?.(event))
  }

  private bindTurn(config: PiAgentSessionConfig): PiAgentSessionConfig {
    this.browserPolicyKey = this.browserPolicy(config)
    this.managedFileTools = Boolean(config.toolPolicy?.fileAccess)
    this.browserArtifactTaskId = config.browserArtifactTaskId
    this.browserTaskStateDir = config.browserTaskStateDir
    const binding = { authorize: config.authorizeTool }
    this.approvalBinding = binding
    return this.bindLocalMedia(this.bindConversationSchedule({ ...config, authorizeTool: request =>
      this.approvalBinding === binding ? binding.authorize(request) : Promise.resolve(false) }))
  }

  private browserPolicy(config: PiAgentSessionConfig): string | undefined {
    if (!config.browserArtifactTaskId) return undefined
    const policy = config.toolPolicy
    return JSON.stringify([config.workspaceDir, config.disableTools, policy?.preset, policy?.approvalMode,
      policy?.allowedTools, policy?.allowedPaths, policy?.deniedPaths])
  }

  private bindConversationSchedule(config: PiAgentSessionConfig): PiAgentSessionConfig {
    if (!config.conversationSchedule) return config
    const binding = { submit: config.conversationSchedule }
    this.scheduleBinding = binding
    return { ...config, conversationSchedule: async signal => {
      if (this.scheduleBinding !== binding) throw new Error('Scheduled creation is not available in this turn.')
      return binding.submit(signal)
    } }
  }

  private bindLocalMedia(config: PiAgentSessionConfig): PiAgentSessionConfig {
    if (!config.localMedia) return config
    const binding = { host: config.localMedia }
    this.localMediaBinding = binding
    return { ...config, localMedia: { execute: async (input, signal) => {
      if (this.localMediaBinding !== binding) throw new Error('本轮无法使用本地音视频处理。')
      return binding.host.execute(input, signal)
    } } }
  }

  private async disposeCurrent(): Promise<void> {
    const session = this.session
    this.session = null
    this.localMediaBinding = undefined
    this.scheduleBinding = undefined
    this.approvalBinding = undefined
    this.browserArtifactTaskId = undefined
    this.browserTaskStateDir = undefined
    this.browserPolicyKey = undefined
    this.unsubscribeSession?.()
    this.unsubscribeSession = null
    if (!session) return
    try {
      await session.abort()
    } catch {
  // 即使已结束的会话拒绝 abort，释放流程也必须继续。
    }
    await session.dispose()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operation.catch(() => undefined).then(operation)
    this.operation = run.then(() => undefined, () => undefined)
    return run
  }
}
