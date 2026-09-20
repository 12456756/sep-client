import { isDeepStrictEqual } from 'node:util'
import type { TaskExecutionEvent, ToolAuthorizationRequest } from '../../../src/shared/types'
import { EmploymentTokenManager } from '../../common/platform/employment-token-manager'
import { MAX_RUN_AUTO_RETRIES } from './pi-agent-runtime'
import type { PiAgentRuntime, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import { SharedPiSession } from './pi-shared-session'
import { logger } from '../../common/logger'

const log = logger.child('pi-task-worker')
const MAX_IDENTICAL_UNKNOWN_TOOL_TURNS = 3
const MAX_IDENTICAL_TOOL_TURNS = 3

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
  private turnHasUnknownTool = false
  private previousInvalidToolTurn: unknown = null
  private identicalInvalidToolTurns = 0
  private previousSuccessfulToolTurn: unknown = null
  private identicalSuccessfulToolTurns = 0
  private finalFailure: string | null = null
  private eventChain: Promise<void> = Promise.resolve()

  constructor(options: PiTaskWorkerOptions) {
    this.context = options.context
    this.runtime = options.runtime ?? new PiCodingAgentAdapter()
    this.onApprovalRequest = options.onApprovalRequest
    this.onEvent = options.onEvent
    this.onSessionCreated = options.onSessionCreated
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
    this.turnHasUnknownTool = false
    this.previousInvalidToolTurn = null
    this.identicalInvalidToolTurns = 0
    this.previousSuccessfulToolTurn = null
    this.identicalSuccessfulToolTurns = 0
    this.finalFailure = null
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
      await this.duringSetup(this.tokenManager.initialize(this.context.subscriptionId).finally(() => {
        if (this.cancelled) this.tokenManager.stop()
      }))
      this.checkCancellation()
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
      if (this.finalFailure) return
      const loopReason = this.hasRepeatedUnknownToolTurn(event)
        ? `Repeated unknown-tool loop: 模型连续 ${MAX_IDENTICAL_UNKNOWN_TOOL_TURNS} 轮返回相同的无效工具调用，且结果没有变化。工具错误已回传模型，已停止本轮以避免无限循环。`
        : this.hasRepeatedSuccessfulToolTurn(event)
          ? `Repeated tool loop: 模型连续 ${MAX_IDENTICAL_TOOL_TURNS} 轮返回相同的工具调用，且工具结果没有变化。已停止本轮以避免无限循环。`
          : null
      if (loopReason) {
        this.finalFailure = loopReason
        log.warn('stopped repeated tool loop', { ...logContext, reason: loopReason })
        void this.emit('tool_loop_detected', { error: this.finalFailure })
        // turn_end is after all parallel results have been appended to SDK context.
        void this.abort().catch(error => {
          log.error('tool loop cancellation failed', { ...logContext, error: String(error) })
        })
      }
    })
    try {
      stage = 'session-persist'
      await this.duringSetup(Promise.resolve(this.onSessionCreated?.({ sessionId: session.sessionId, sessionFile: session.sessionFile })))
      this.checkCancellation()
      stage = 'prompt'
      await session.prompt(prompt)
      stage = 'event-flush'
      await this.eventChain
      stage = 'agent-result'
      if (this.finalFailure) throw new Error(this.finalFailure)
      this.checkCancellation()
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

  private hasRepeatedUnknownToolTurn(event: import('./pi-agent-runtime').PiAgentEvent): boolean {
    if (event.type === 'turn_start') this.turnHasUnknownTool = false
    if (event.type === 'tool_execution_end') {
      const data = event.data as { success?: boolean; failureReason?: string }
      if (data.success === false && data.failureReason === 'unknown-tool') this.turnHasUnknownTool = true
    }
    if (event.type !== 'turn_end') return false
    const data = event.data as {
      message?: { content?: Array<{ type: string; name?: string; arguments?: unknown }> }
      toolResults?: Array<{ toolName: string; isError: boolean; content: unknown }>
    }
    if (!this.turnHasUnknownTool || !Array.isArray(data.message?.content) || !Array.isArray(data.toolResults)) {
      this.previousInvalidToolTurn = null
      this.identicalInvalidToolTurns = 0
      return false
    }
    // Compare complete batches, not completion order. A successful sibling ls must not
    // hide an identical ls + unknown-tool loop. Changed arguments/results are progress.
    // Ignore call IDs/timestamps, which change on every provider response.
    const signature = {
      calls: data.message.content.filter(call => call.type === 'toolCall')
        .map(call => ({ name: call.name, arguments: call.arguments })),
      results: data.toolResults.map(result => ({ toolName: result.toolName, isError: result.isError, content: result.content })),
    }
    this.identicalInvalidToolTurns = isDeepStrictEqual(signature, this.previousInvalidToolTurn)
      ? this.identicalInvalidToolTurns + 1 : 1
    this.previousInvalidToolTurn = signature
    return this.identicalInvalidToolTurns >= MAX_IDENTICAL_UNKNOWN_TOOL_TURNS
  }

  private hasRepeatedSuccessfulToolTurn(event: import('./pi-agent-runtime').PiAgentEvent): boolean {
    if (event.type !== 'turn_end') return false
    const data = event.data as {
      message?: { content?: Array<{ type: string; name?: string; arguments?: unknown }> }
      toolResults?: Array<{ toolName: string; isError: boolean; content: unknown }>
    }
    const calls = data.message?.content?.filter(call => call.type === 'toolCall')
    const results = data.toolResults
    if (!Array.isArray(calls) || calls.length === 0 || !Array.isArray(results) || results.length === 0 || results.some(result => result.isError)) {
      this.previousSuccessfulToolTurn = null
      this.identicalSuccessfulToolTurns = 0
      return false
    }

    // Ignore tool-call IDs: providers normally generate a new ID for every response.
    const signature = {
      calls: calls.map(call => ({ name: call.name, arguments: call.arguments })),
      results: results.map(result => ({ toolName: result.toolName, isError: result.isError, content: result.content })),
    }
    this.identicalSuccessfulToolTurns = isDeepStrictEqual(signature, this.previousSuccessfulToolTurn)
      ? this.identicalSuccessfulToolTurns + 1 : 1
    this.previousSuccessfulToolTurn = signature
    return this.identicalSuccessfulToolTurns >= MAX_IDENTICAL_TOOL_TURNS
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


