import type { TaskExecutionEvent, ToolAuthorizationRequest } from '../../../src/shared/types'
import { EmploymentTokenManager } from '../../common/platform/employment-token-manager'
import { MAX_RUN_AUTO_RETRIES } from './pi-agent-runtime'
import type { PiAgentRuntime, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import { SharedPiSession } from './pi-shared-session'
import { logger } from '../../common/logger'
import type { ModelRequestKind, ModelRequestProgress } from '../../domain/model-request-progress'

const log = logger.child('pi-task-worker')

export function createDefaultSharedPiSession(): SharedPiSession {
  return new SharedPiSession(new PiCodingAgentAdapter())
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
  systemPrompt?: string
  useNativeSystemPrompt?: boolean
  modelRequestAwareness?: boolean
  transformSystemPrompt?: PiAgentSessionConfig['transformSystemPrompt']
  mediaTools?: PiAgentSessionConfig['mediaTools']
  videoTools?: PiAgentSessionConfig['videoTools']
  employeeProfile?: PiAgentSessionConfig['employeeProfile']
  fixedSystemPrompt?: string
  arrangementNodeId?: string
  toolPolicy?: PiAgentSessionConfig['toolPolicy']
  disableTools?: boolean
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
  /** Runs only after a complete agent execution, never after individual tool turns. */
  onResponseSettled?: (response: { text: string; stopReason?: string }) => Promise<{ continueWith: string } | void>
  onModelRequest?: (kind: ModelRequestKind) => Promise<ModelRequestProgress>
  runtime?: PiAgentRuntime
  sessionAdapter?: SharedPiSession
  createTokenManager?: () => TokenManagerPort
}

export class PiTaskWorker {
  private readonly context: PiTaskWorkerContext
  private readonly tokenManager: TokenManagerPort
  private readonly runtime: PiAgentRuntime
  private readonly onApprovalRequest: PiTaskWorkerOptions['onApprovalRequest']
  private readonly onEvent: PiTaskWorkerOptions['onEvent']
  private readonly onSessionCreated: PiTaskWorkerOptions['onSessionCreated']
  private readonly onResponseSettled: PiTaskWorkerOptions['onResponseSettled']
  private readonly onModelRequest: PiTaskWorkerOptions['onModelRequest']
  private readonly sessionAdapter: SharedPiSession | null
  private session: PiAgentSession | null = null
  private unsubscribe: (() => void) | null = null
  private active = false
  private cancelled = false
  private setupCleanup: Promise<void> | null = null
  private resolveCancellation!: () => void
  private readonly cancellation = new Promise<void>(resolve => { this.resolveCancellation = resolve })
  private sequence = 0
  private retryCount = 0
  private finalFailure: string | null = null
  private eventChain: Promise<void> = Promise.resolve()
  private settledResponse: { text: string; stopReason?: string } = { text: '' }

  constructor(options: PiTaskWorkerOptions) {
    this.context = options.context
    this.runtime = options.runtime ?? new PiCodingAgentAdapter()
    this.onApprovalRequest = options.onApprovalRequest
    this.onEvent = options.onEvent
    this.onSessionCreated = options.onSessionCreated
    this.onResponseSettled = options.onResponseSettled
    this.onModelRequest = options.onModelRequest
    this.sessionAdapter = options.sessionAdapter ?? null
    this.tokenManager = options.createTokenManager?.() ?? new EmploymentTokenManager({
      getRefreshToken: options.getRefreshToken,
      onAuthenticationRequired: options.onAuthenticationRequired,
    })
  }

  async run(prompt: string): Promise<void> {
    if (this.active) throw new Error('Pi task worker is already active.')
    this.checkCancellation()
    this.active = true
    this.retryCount = 0
    this.finalFailure = null
    let stage = 'instance-token'
    const logContext = {
      taskId: this.context.taskId,
      runId: this.context.runId,
      subscriptionId: this.context.subscriptionId,
      modelId: this.context.modelId,
      nodeId: this.context.arrangementNodeId,
    }
    log.info('run started', logContext)
    let session: PiAgentSession
    try {
      await this.duringSetup(this.tokenManager.initialize(this.context.subscriptionId).finally(() => {
        if (this.cancelled) this.tokenManager.stop()
      }))
      this.checkCancellation()
      stage = 'session-create'
      log.trace('creating runtime session', {
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
        systemPrompt: this.context.systemPrompt,
        useNativeSystemPrompt: this.context.useNativeSystemPrompt,
        modelRequestAwareness: this.context.modelRequestAwareness,
        transformSystemPrompt: this.context.transformSystemPrompt,
        mediaTools: this.context.mediaTools,
        videoTools: this.context.videoTools,
        employeeProfile: this.context.employeeProfile,
        fixedSystemPrompt: this.context.fixedSystemPrompt,
        onModelRequest: this.onModelRequest ? async kind => {
          this.checkCancellation()
          const progress = await this.onModelRequest!(kind)
          this.checkCancellation()
          log.info('model request prepared', { ...logContext, kind, ...progress })
          return progress
        } : undefined,
        toolPolicy: this.context.toolPolicy,
        disableTools: this.context.disableTools,
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
      const creating = this.sessionAdapter
        ? this.sessionAdapter.open(sessionConfig)
        : this.runtime.createSession(sessionConfig)
      session = await this.duringSetup(creating.then(async created => {
        if (this.cancelled) {
          if (this.sessionAdapter) await (this.setupCleanup ?? this.sessionAdapter.reset())
          else await created.dispose()
          this.checkCancellation()
        }
        this.session = created
        return created
      }))
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
      if (event.type === 'turn_start') this.settledResponse = { text: '' }
      if (event.type === 'turn_end') {
        const data = event.data as { message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } } | null
        if (data?.message?.role === 'assistant') this.settledResponse = {
          text: (data.message.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join(''),
          stopReason: data.message.stopReason,
        }
      }
      if (event.type === 'auto_retry_end' && (event.data as { success?: unknown } | null)?.success === true) this.retryCount = 0
      if (event.failure && !this.finalFailure) this.finalFailure = event.failure
      if (event.type === 'auto_retry_start' && ++this.retryCount > MAX_RUN_AUTO_RETRIES) {
        this.finalFailure = `本轮自动重试已达到 ${MAX_RUN_AUTO_RETRIES} 次上限，请检查网关错误后手动重试。`
        void this.emit('retry_budget_exhausted', { error: this.finalFailure })
        // Let the SDK install its retry AbortController before aborting its backoff wait.
        void Promise.resolve().then(() => this.abort()).catch(error => {
          log.error('retry cancellation failed', { ...logContext, error: String(error) })
        })
        return
      }
      void this.emit(event.type, event.data)
    })
    try {
      stage = 'session-persist'
      await this.duringSetup(Promise.resolve(this.onSessionCreated?.({ sessionId: session.sessionId, sessionFile: session.sessionFile })))
      this.checkCancellation()
      let nextPrompt = prompt
      while (true) {
        this.settledResponse = { text: '' }
        stage = 'prompt'
        await session.prompt(nextPrompt)
        stage = 'event-flush'
        await this.eventChain
        stage = 'agent-result'
        if (this.finalFailure) throw new Error(this.finalFailure)
        this.checkCancellation()
        stage = 'response-settlement'
        // Delivery JSON must use the complete reply, not the redacted, bounded event projection.
        const correction = await this.onResponseSettled?.(session.getSettledResponse?.() ?? this.settledResponse)
        this.checkCancellation()
        if (!correction) break
        nextPrompt = correction.continueWith
      }
      log.info('run completed', logContext)
    } catch (error) {
      const failure = this.finalFailure ? new Error(this.finalFailure) : error
      log.error('run failed', {
        ...logContext,
        stage,
        error: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure),
      })
      throw failure
    }
  }

  async abort(): Promise<void> {
    this.cancelled = true
    this.resolveCancellation()
    this.tokenManager.stop()
    if (this.active && this.sessionAdapter && !this.session && !this.setupCleanup) {
      // Queue cleanup now, before a resumed turn can enqueue another shared-session open.
      // Do not await unabortable session creation on the cancellation critical path.
      this.setupCleanup = this.sessionAdapter.reset().catch(error => {
        log.error('cancelled setup cleanup failed', { taskId: this.context.taskId, runId: this.context.runId, error: String(error) })
      })
    }
    await this.session?.abort()
  }

  private checkCancellation(): void {
    if (this.cancelled) throw new Error('Task execution cancelled.')
  }

  private async duringSetup<T>(operation: Promise<T>): Promise<T> {
    // Observe even an already-started operation when cancellation won the previous await.
    return Promise.race([operation, this.cancellation.then(() => {
      throw new Error('Task execution cancelled.')
    })])
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


