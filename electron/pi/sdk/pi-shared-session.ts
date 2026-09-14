import type { PiAgentEvent, PiAgentRuntime, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'

/**
 * 为一个任务维护一个持久化 Pi 会话。
 * 切换员工时使用同一个会话文件重建 AgentSession，确保持久化历史始终
 * 是唯一的对话上下文来源。
 */
export class SharedPiSession {
  private session: PiAgentSession | null = null
  private sessionFile: string | null = null
  private unsubscribeSession: (() => void) | null = null
  private listener: ((event: PiAgentEvent) => void) | null = null
  private disposed = false
  private operation: Promise<void> = Promise.resolve()

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
      if (this.session) return this.session
      const session = await this.runtime.createSession({
        ...config,
        resumeSessionFile: this.sessionFile ?? config.resumeSessionFile,
      })
      this.session = session
      this.sessionFile = session.sessionFile ?? this.sessionFile ?? config.resumeSessionFile ?? null
      this.bindSessionEvents(session)
      return session
    })
  }

  async switchEmployee(config: PiAgentSessionConfig): Promise<PiAgentSession> {
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Shared Pi session adapter has been disposed.')
      const resumeSessionFile = this.sessionFile ?? config.resumeSessionFile
      await this.disposeCurrent()
      const session = await this.runtime.createSession({ ...config, resumeSessionFile: resumeSessionFile ?? undefined })
      this.session = session
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
    await this.enqueue(async () => {
      if (this.disposed) return
      this.disposed = true
      await this.disposeCurrent()
      this.listener = null
    })
  }

  private bindSessionEvents(session: PiAgentSession): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = session.subscribe(event => this.listener?.(event))
  }

  private async disposeCurrent(): Promise<void> {
    const session = this.session
    this.session = null
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


