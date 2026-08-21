import type { TaskExecutionEvent, ToolAuthorizationRequest } from '../../src/shared/types'
import { InstanceTokenManager } from '../auth/instance-token-manager'
import type { PiAgentRuntime, PiAgentSession } from './pi-agent-runtime'
import { PiCodingAgentAdapter } from './sdk'

export interface PiTaskWorkerContext {
  taskId: string
  runId: string
  employeeInstanceId: string
  modelId: string
  gatewayUrl: string
  workspaceDir: string
  agentDir: string
  sessionDir: string
  resumeSessionFile?: string
}

interface TokenManagerPort {
  initialize(instanceId: string): Promise<void>
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
  createTokenManager?: () => TokenManagerPort
}

export class PiTaskWorker {
  private readonly context: PiTaskWorkerContext
  private readonly tokenManager: TokenManagerPort
  private readonly runtime: PiAgentRuntime
  private readonly onApprovalRequest: PiTaskWorkerOptions['onApprovalRequest']
  private readonly onEvent: PiTaskWorkerOptions['onEvent']
  private readonly onSessionCreated: PiTaskWorkerOptions['onSessionCreated']
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
      employeeInstanceId: this.context.employeeInstanceId,
      modelId: this.context.modelId,
    }
    console.info('[PiTaskWorker] run started', logContext)
    let session: PiAgentSession
    try {
      await this.tokenManager.initialize(this.context.employeeInstanceId)
      stage = 'session-create'
      console.error('[PiTaskWorker] creating runtime session', {
        runtime: this.runtime.constructor?.name ?? 'unknown',
      })
      session = await this.runtime.createSession({
      runId: this.context.runId,
      modelId: this.context.modelId,
      gatewayUrl: this.context.gatewayUrl,
      workspaceDir: this.context.workspaceDir,
      agentDir: this.context.agentDir,
      sessionDir: this.context.sessionDir,
      resumeSessionFile: this.context.resumeSessionFile,
      getAccessToken: () => this.tokenManager.getValidToken(),
      authorizeTool: async request => {
        await this.emit('approval_requested', { toolName: request.toolName })
        const approved = await this.onApprovalRequest({
          taskId: this.context.taskId,
          runId: this.context.runId,
          employeeInstanceId: this.context.employeeInstanceId,
          toolName: request.toolName,
          input: request.input,
        })
        await this.emit('approval_resolved', { approved, toolName: request.toolName })
        return approved
      },
      })
    } catch (error) {
      console.error('[PiTaskWorker] run setup failed', {
        ...logContext,
        stage,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      this.active = false
      this.tokenManager.stop()
      throw error
    }
    if (!this.active) {
      await session.dispose()
      return
    }

    this.session = session
    this.unsubscribe = session.subscribe(event => {
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
      console.info('[PiTaskWorker] run completed', logContext)
    } catch (error) {
      console.error('[PiTaskWorker] run failed', {
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
      if (session) await session.abort()
    } finally {
      await session?.dispose()
      this.tokenManager.stop()
      await this.eventChain.catch(() => undefined)
    }
  }

  private emit(type: string, data: unknown): Promise<void> {
    if (!this.active) return Promise.resolve()
    const event: TaskExecutionEvent = {
      taskId: this.context.taskId,
      runId: this.context.runId,
      employeeInstanceId: this.context.employeeInstanceId,
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
