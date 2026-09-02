import type { TaskExecutionEvent, ToolAuthorizationRequest } from '../../../src/shared/types'
import { InstanceTokenManager } from '../../common/platform/instance-token-manager'
import type { PiAgentRuntime, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import { SharedPiSessionAdapter } from './shared-session-adapter'
import { logger } from '../../common/logger'

const log = logger.child('pi-task-worker')

export function createDefaultSharedPiSessionAdapter(): SharedPiSessionAdapter {
  return new SharedPiSessionAdapter(new PiCodingAgentAdapter())
}

export interface PiTaskWorkerContext {
  taskId: string
  runId: string
  subscriptionId: string
  modelId: string
  gatewayUrl: string
  workspaceDir: string
  agentDir: string
  sessionDir: string
  resumeSessionFile?: string
  additionalSkillPaths?: string[]
}

interface TokenManagerPort {
  initialize(subscriptionId: string): Promise<void>
  getValidToken(): Promise<string>
  stop(): void
}

export interface PiTaskWorkerOptions {
  context: PiTaskWorkerContext
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  onApprovalRequest: (request: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => Promise<boolean>
  onEvent: (event: TaskExecutionEvent) => Promise<void> | void
  onSessionCreated?: (session: { sessionId: string; sessionFile: string | null }) => Promise<void> | void
  runtime?: PiAgentRuntime
  sessionAdapter?: SharedPiSessionAdapter
  createTokenManager?: () => TokenManagerPort
}

export class PiTaskWorker {
  private readonly context: PiTaskWorkerContext
  private readonly tokenManager: TokenManagerPort
  private readonly runtime: PiAgentRuntime
  private readonly onApprovalRequest: PiTaskWorkerOptions['onApprovalRequest']
  private readonly onEvent: PiTaskWorkerOptions['onEvent']
  private readonly onSessionCreated: PiTaskWorkerOptions['onSessionCreated']
  private readonly sessionAdapter: SharedPiSessionAdapter | null
  private session: PiAgentSession | null = null
  private unsubscribe: (() => void) | null = null
  private active = false
  private sequence = 0
  private finalFailure: string | null = null
  private eventChain: Promise<void> = Promise.resolve()

  constructor(options: PiTaskWorkerOptions) {
    this.context = options.context
    this.runtime = options.runtime ?? new PiCodingAgentAdapter()
    this.onApprovalRequest = options.onApprovalRequest
    this.onEvent = options.onEvent
    this.onSessionCreated = options.onSessionCreated
    this.sessionAdapter = options.sessionAdapter ?? null
    this.tokenManager = options.createTokenManager?.() ?? new InstanceTokenManager({
      getRefreshToken: options.getRefreshToken,
      onAuthenticationRequired: options.onAuthenticationRequired,
    })
  }

  async run(prompt: string): Promise<void> {
    if (this.active) throw new Error('Pi task worker is already active.')
    this.active = true
    let stage = 'instance-token'
    const logContext = {
      taskId: this.context.taskId,
      runId: this.context.runId,
      subscriptionId: this.context.subscriptionId,
      modelId: this.context.modelId,
    }
    log.info('run started', logContext)
    let session: PiAgentSession
    try {
      await this.tokenManager.initialize(this.context.subscriptionId)
      stage = 'session-create'
      log.info('creating runtime session', {
        runtime: this.runtime.constructor?.name ?? 'unknown',
      })
      const sessionConfig: PiAgentSessionConfig = {
      runId: this.context.runId,
      modelId: this.context.modelId,
      gatewayUrl: this.context.gatewayUrl,
      workspaceDir: this.context.workspaceDir,
      agentDir: this.context.agentDir,
      sessionDir: this.context.sessionDir,
      resumeSessionFile: this.context.resumeSessionFile,
      additionalSkillPaths: this.context.additionalSkillPaths,
      getAccessToken: () => this.tokenManager.getValidToken(),
      authorizeTool: async request => {
        return this.onApprovalRequest({
          taskId: this.context.taskId,
          runId: this.context.runId,
          subscriptionId: this.context.subscriptionId,
          toolName: request.toolName,
          input: request.input,
        })
      },
      reportPolicyEvent: (type, data) => this.emit(type, data),
      }
      session = this.sessionAdapter
        ? await this.sessionAdapter.open(sessionConfig)
        : await this.runtime.createSession(sessionConfig)
    } catch (error) {
      log.error('run setup failed', {
        ...logContext,
        stage,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      this.active = false
      this.tokenManager.stop()
      throw error
    }
    if (!this.active) {
      if (this.sessionAdapter) await this.sessionAdapter.reset()
      else await session.dispose()
      return
    }

    this.session = session
    const subscribe = this.sessionAdapter
      ? (listener: (event: import('./pi-agent-runtime').PiAgentEvent) => void) => this.sessionAdapter!.subscribe(listener)
      : (listener: (event: import('./pi-agent-runtime').PiAgentEvent) => void) => session.subscribe(listener)
    this.unsubscribe = subscribe(event => {
      if (event.failure) this.finalFailure = event.failure
      void this.emit(event.type, event.data)
    })
    try {
      stage = 'session-persist'
      await this.onSessionCreated?.({ sessionId: session.sessionId, sessionFile: session.sessionFile })
      stage = 'prompt'
      await session.prompt(prompt)
      stage = 'event-flush'
      await this.eventChain
      stage = 'agent-result'
      if (this.finalFailure) throw new Error(this.finalFailure)
      log.info('run completed', logContext)
    } catch (error) {
      log.error('run failed', {
        ...logContext,
        stage,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      throw error
    }
  }

  async abort(): Promise<void> {
    await this.session?.abort()
  }

  async dispose(): Promise<void> {
    if (!this.active && !this.session) return
    this.active = false
    const session = this.session
    this.session = null
    const unsubscribe = this.unsubscribe
    this.unsubscribe = null
    unsubscribe?.()
    try {
      if (session && !this.sessionAdapter) await session.abort()
    } finally {
      if (this.sessionAdapter) await this.sessionAdapter.reset()
      else if (session) await session.dispose()
      this.tokenManager.stop()
      await this.eventChain.catch(() => undefined)
    }
  }

  private emit(type: string, data: unknown): Promise<void> {
    if (!this.active) return Promise.resolve()
    const event: TaskExecutionEvent = {
      taskId: this.context.taskId,
      runId: this.context.runId,
      subscriptionId: this.context.subscriptionId,
      sequence: ++this.sequence,
      type,
      occurredAt: Date.now(),
      data,
    }
    const operation = this.eventChain.then(() => this.onEvent(event))
    this.eventChain = operation.then(() => undefined)
    return operation
  }
}
