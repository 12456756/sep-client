import { mkdir } from 'node:fs/promises'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSessionEvent,
  type BeforeProviderHeadersEvent,
  type BeforeProviderRequestEvent,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import { lazyApi, type ProviderStreams } from '@earendil-works/pi-ai'
import type {
  PiAgentEvent,
  PiAgentRuntime,
  PiAgentSession,
  PiAgentSessionConfig,
} from '../pi-agent-runtime'
import {
  APPROVAL_TOOLS,
  READ_ONLY_TOOLS,
  buildBearerAuthorizationHeader,
} from '../../../pi-extension'

const MAX_STRING_LENGTH = 8_192
const MAX_ARRAY_LENGTH = 50
const MAX_OBJECT_KEYS = 50
const MAX_DEPTH = 5
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key|credential/i
let gatewayRequestSequence = 0

export type GatewayErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'transient'
  | 'non_retryable'

export interface GatewayErrorInfo {
  kind: GatewayErrorKind
  status?: number
  retryAfterMs?: number
  retryable: boolean
  message: string
}

const MAX_GATEWAY_RETRY_AFTER_MS = 60_000
const MAX_GATEWAY_TRANSIENT_RETRIES = 2
const OPENAI_COMPLETIONS_MODULE_ID = '@earendil-works/pi-ai/api/openai-completions'
const openAICompletionsApi = lazyApi(
  () => import(OPENAI_COMPLETIONS_MODULE_ID) as Promise<ProviderStreams>,
)

function getNumericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown; statusCode?: unknown }
    cause?: { status?: unknown; statusCode?: unknown }
  }
  for (const candidate of [
    value.status,
    value.statusCode,
    value.response?.status,
    value.response?.statusCode,
    value.cause?.status,
    value.cause?.statusCode,
  ]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate
  }
  return undefined
}

function getHeader(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as {
    headers?: Headers | Record<string, unknown>
    response?: { headers?: Headers | Record<string, unknown> }
  }
  const headers = value.headers ?? value.response?.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined
  for (const [key, candidate] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof candidate === 'string') return candidate
  }
  return undefined
}

export function parseRetryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number.parseFloat(value.trim())
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now
  if (!Number.isFinite(delay)) return undefined
  return Math.min(MAX_GATEWAY_RETRY_AFTER_MS, Math.max(0, Math.ceil(delay)))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return truncate(error.message)
  return truncate(String(error))
}

/** Classify SDK/provider errors without exposing credentials or raw response bodies. */
export function classifyGatewayError(error: unknown): GatewayErrorInfo {
  const status = getNumericStatus(error)
  const message = errorMessage(error)
  const lower = message.toLowerCase()
  const retryAfterMs = parseRetryAfterMs(getHeader(error, 'retry-after'))
  if (status === 401 || /\b401\b|unauthorized|invalid employment token/i.test(lower)) {
    return { kind: 'unauthorized', status: status ?? 401, retryable: true, message }
  }
  if (status === 403 || /\b403\b|forbidden|subscription|insufficient balance|not authorized/i.test(lower)) {
    return { kind: 'forbidden', status: status ?? 403, retryable: false, message }
  }
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(lower)) {
    return { kind: 'rate_limited', status: status ?? 429, retryAfterMs, retryable: true, message }
  }
  const networkFailure = !status && /network|fetch failed|econn|etimedout|socket|connection reset|terminated/i.test(lower)
  if (networkFailure || (status !== undefined && status >= 500)) {
    return { kind: 'transient', status, retryable: true, message }
  }
  return { kind: 'non_retryable', status, retryable: false, message }
}

export function gatewayBackoffMs(
  info: GatewayErrorInfo,
  retryIndex: number,
  baseDelayMs = 1_000,
): number {
  if (info.retryAfterMs !== undefined) return info.retryAfterMs
  return Math.min(8_000, baseDelayMs * 2 ** Math.max(0, retryIndex))
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The request was aborted.', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('The request was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Keep gateway recovery bounded at the HTTP boundary. The SDK provider retry
 * loop is disabled below so a 401 can refresh exactly once per request and a
 * transient response cannot multiply the token refresh or backoff attempts.
 */
export function createGatewayFetch(
  config: Pick<PiAgentSessionConfig, 'refreshAccessToken' | 'onGatewayAuthorizationRejected'>,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input.clone() : null
    const originalHeaders = new Headers(init?.headers ?? request?.headers)
    const signal = init?.signal ?? request?.signal
    let authRetried = false
    let transientRetries = 0
    let headers = new Headers(originalHeaders)

    for (;;) {
      const responseInput = request ? request.clone() : input
      const responseInit = request
        ? { ...init, headers, signal }
        : { ...init, headers, signal }
      let response: Response
      try {
        response = await baseFetch(responseInput, responseInit)
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        if (transientRetries >= MAX_GATEWAY_TRANSIENT_RETRIES) throw error
        const delay = gatewayBackoffMs({ kind: 'transient', retryable: true, message: errorMessage(error) }, transientRetries)
        transientRetries += 1
        await sleep(delay, signal)
        continue
      }

      if (response.status === 401 && config.refreshAccessToken && !authRetried) {
        authRetried = true
        await response.body?.cancel()
        const refreshedToken = await config.refreshAccessToken()
        headers = new Headers(headers)
        headers.set('Authorization', buildBearerAuthorizationHeader(refreshedToken))
        continue
      }

      if (response.status === 403 || response.status === 404) {
        config.onGatewayAuthorizationRejected?.(response.status)
        return response
      }

      if ((response.status === 429 || response.status >= 500) && transientRetries < MAX_GATEWAY_TRANSIENT_RETRIES) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after') ?? undefined)
        await response.body?.cancel()
        const info: GatewayErrorInfo = {
          kind: response.status === 429 ? 'rate_limited' : 'transient',
          status: response.status,
          retryAfterMs,
          retryable: true,
          message: `SEP gateway returned HTTP ${response.status}`,
        }
        const delay = gatewayBackoffMs(info, transientRetries)
        transientRetries += 1
        await sleep(delay, signal)
        continue
      }
      return response
    }
  }
}

function truncate(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
  return redacted.length <= MAX_STRING_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated]`
}

function sanitize(value: unknown, depth = 0, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return truncate(value)
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH) return '[max-depth]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map(item => sanitize(item, depth + 1))
  }

  const output: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const sanitized = sanitize(entryValue, depth + 1, entryKey)
    if (sanitized !== undefined) output[entryKey] = sanitized
  }
  return output
}

function getFailure(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
    if (candidate.role !== 'assistant') continue
    if (candidate.stopReason !== 'error' && candidate.stopReason !== 'aborted') return undefined
    if (typeof candidate.errorMessage === 'string' && candidate.errorMessage.trim()) {
      return truncate(candidate.errorMessage)
    }
    return candidate.stopReason === 'aborted' ? 'Agent run was aborted.' : 'Agent run failed.'
  }
  return undefined
}

function gatewayContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(part => {
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      return ''
    }).filter(Boolean).join('\n')
  }
  return value == null ? '' : String(value)
}

/** Serialize every provider request to the exact SEP gateway message shape. */
export function normalizeGatewayPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { messages?: unknown }).messages)) {
    return payload
  }

  const messages = (payload as { messages: unknown[] }).messages.flatMap(message => {
    if (!message || typeof message !== 'object') return []
    const current = message as Record<string, unknown>
    const role = current.role === 'system' || current.role === 'assistant' || current.role === 'tool' || current.role === 'user'
      ? current.role
      : 'user'

    if (role === 'assistant' && Array.isArray(current.tool_calls)) {
      const calls = current.tool_calls.map(call => {
        if (!call || typeof call !== 'object') return String(call)
        const entry = call as Record<string, unknown>
        const fn = entry.function && typeof entry.function === 'object'
          ? entry.function as Record<string, unknown>
          : undefined
        const name = typeof fn?.name === 'string' ? fn.name : 'unknown'
        const args = typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {})
        return `[tool call: ${name}] ${args}`
      }).join('\n')
      const existingContent = gatewayContent(current.content)
      const content = existingContent.trim()
        ? `${existingContent}\n${calls}`
        : calls
      return { role: 'assistant', content }
    }

    if (role === 'tool') {
      const content = gatewayContent(current.content)
      const name = typeof current.name === 'string' ? current.name : undefined
      return {
        role: 'user',
        ...(name ? { name: `tool:${name}` } : {}),
        content: `[tool result${name ? `: ${name}` : ''}]\n${content}`,
      }
    }

    return [{
      role,
      content: gatewayContent(current.content),
      ...(typeof current.name === 'string' ? { name: current.name } : {}),
    }]
  })

  const source = payload as Record<string, unknown>
  return {
    model: typeof source.model === 'string' ? source.model : '',
    messages,
    ...(typeof source.temperature === 'number' ? { temperature: source.temperature } : {}),
    ...(Number.isInteger(source.max_tokens) && (source.max_tokens as number) > 0 ? { max_tokens: source.max_tokens } : {}),
    ...(typeof source.stream === 'boolean' ? { stream: source.stream } : {}),
    ...(Array.isArray(source.tools) ? { tools: source.tools } : {}),
  }
}

function normalizeEvent(event: AgentSessionEvent): PiAgentEvent | null {
  const raw = event as unknown as Record<string, unknown>
  switch (event.type) {
    case 'message_update': {
      const update = raw.assistantMessageEvent as Record<string, unknown> | undefined
      if (update?.type !== 'text_delta' || typeof update.delta !== 'string') return null
      return { type: 'text_delta', data: { text: truncate(update.delta) } }
    }
    case 'tool_execution_start':
      return {
        type: event.type,
        data: {
          toolId: raw.toolCallId,
          toolName: raw.toolName,
          input: sanitize(raw.args),
        },
      }
    case 'tool_execution_end':
      return {
        type: event.type,
        data: {
          toolId: raw.toolCallId,
          toolName: raw.toolName,
          success: raw.isError !== true,
          error: raw.isError === true ? sanitize(raw.result) : undefined,
        },
      }
    case 'agent_end':
      return {
        type: event.type,
        data: { willRetry: event.willRetry },
        failure: event.willRetry ? undefined : getFailure(event.messages),
      }
    case 'auto_retry_start':
      return {
        type: event.type,
        data: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: truncate(event.errorMessage),
        },
      }
    case 'auto_retry_end':
      return {
        type: event.type,
        data: {
          success: event.success,
          attempt: event.attempt,
          error: event.finalError ? truncate(event.finalError) : undefined,
        },
      }
    case 'agent_start':
    case 'agent_settled':
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
    case 'message_end':
    case 'compaction_start':
    case 'compaction_end':
      return { type: event.type, data: sanitize(raw) }
    default:
      return null
  }
}

function buildExtensions(config: PiAgentSessionConfig): ExtensionFactory[] {
  const gatewayPayload: ExtensionFactory = pi => {
    console.error('[PiGateway] provider payload hook registered')
    pi.on('before_provider_request', (event: BeforeProviderRequestEvent) => {
      const requestId = ++gatewayRequestSequence
      console.error('[PiGateway] provider request hook entered', { requestId })
      try {
        const normalized = normalizeGatewayPayload(event.payload)
        const record = normalized && typeof normalized === 'object'
          ? normalized as Record<string, unknown>
          : undefined
        console.error('[PiGateway] normalized provider request', {
          requestId,
          model: typeof record?.model === 'string' ? record.model : undefined,
          messageCount: Array.isArray(record?.messages) ? record.messages.length : 0,
          stream: record?.stream === true,
        })
        return normalized
      } catch (error) {
        console.error('[PiGateway] payload normalization failed', {
          requestId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        throw error
      }
    })
  }

  const toolGuard: ExtensionFactory = pi => {
    pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
      const toolName = event.toolName ?? 'unknown'
      if (READ_ONLY_TOOLS.has(toolName)) return { block: false }
      if (!APPROVAL_TOOLS.has(toolName)) {
        return { block: true, reason: `Unknown tool: ${toolName} - default deny` }
      }
      const approved = await config.authorizeTool({ toolName, input: sanitize(event.input) })
      return approved
        ? { block: false }
        : { block: true, reason: `User denied execution of high-risk tool: ${toolName}` }
    })
  }

  const providerAuth: ExtensionFactory = pi => {
    console.error('[PiGateway] provider headers hook registered')
    pi.on('before_provider_headers', async (event: BeforeProviderHeadersEvent): Promise<void> => {
      console.error('[PiGateway] provider headers hook entered')
      event.headers.authorization = buildBearerAuthorizationHeader(await config.getAccessToken())
    })
  }

  return [gatewayPayload, toolGuard, providerAuth]
}

class PiCodingAgentSession implements PiAgentSession {
  constructor(private readonly session: Awaited<ReturnType<typeof createAgentSession>>['session']) {}

  get sessionId(): string {
    return this.session.sessionId
  }

  get sessionFile(): string | null {
    return this.session.sessionFile ?? null
  }

  prompt(text: string): Promise<void> {
    return this.session.prompt(text)
  }

  abort(): Promise<void> {
    return this.session.abort()
  }

  subscribe(listener: (event: PiAgentEvent) => void): () => void {
    return this.session.subscribe(event => {
      const normalized = normalizeEvent(event)
      if (normalized) listener(normalized)
    })
  }

  async dispose(): Promise<void> {
    await this.session.dispose()
  }
}

export class PiCodingAgentAdapter implements PiAgentRuntime {
  async createSession(config: PiAgentSessionConfig): Promise<PiAgentSession> {
    console.error('[PiGateway] createSession started', {
      modelId: config.modelId,
      gatewayUrl: config.gatewayUrl,
      workspaceDir: config.workspaceDir,
      resumeSessionFile: config.resumeSessionFile,
    })
    await Promise.all([
      mkdir(config.agentDir, { recursive: true }),
      mkdir(config.sessionDir, { recursive: true }),
    ])

    const modelRuntime = await ModelRuntime.create({ modelsPath: null })
    const gatewayFetch = createGatewayFetch(config)
    modelRuntime.registerProvider('sep-gateway', {
      name: 'SEP Gateway',
      baseUrl: config.gatewayUrl,
      apiKey: 'placeholder',
      api: 'openai-completions',
      streamSimple: (requestModel, context, options) => openAICompletionsApi.streamSimple(requestModel, context, {
        ...options,
        fetch: gatewayFetch,
        maxRetries: 0,
        maxRetryDelayMs: MAX_GATEWAY_RETRY_AFTER_MS,
      }),
      models: [{
        id: config.modelId,
        name: config.modelId,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      }],
    })
    const model = modelRuntime.getModel('sep-gateway', config.modelId)
    if (!model) throw new Error('Failed to resolve task model.')

    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspaceDir,
      agentDir: config.agentDir,
      extensionFactories: buildExtensions(config),
      noSkills: !config.skillPaths?.length,
      noContextFiles: !config.agentsFiles?.length,
      additionalSkillPaths: config.skillPaths,
      agentsFilesOverride: config.agentsFiles
        ? () => ({ agentsFiles: config.agentsFiles ?? [] })
        : undefined,
      systemPrompt: config.systemPrompt,
    })
    await resourceLoader.reload()
    const extensionState = resourceLoader.getExtensions()
    console.error('[PiGateway] resource loader reloaded', {
      extensionCount: extensionState.extensions.length,
      extensionErrors: extensionState.errors,
      extensionPaths: extensionState.extensions.map(extension => extension.path),
    })

    const sessionManager = config.resumeSessionFile
      ? SessionManager.open(config.resumeSessionFile, config.sessionDir, config.workspaceDir)
      : SessionManager.create(config.workspaceDir, config.sessionDir, { id: config.runId })
    const { session } = await createAgentSession({
      cwd: config.workspaceDir,
      agentDir: config.agentDir,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager,
    })
    console.error('[PiGateway] createAgentSession completed', { sessionId: session.sessionId })
    return new PiCodingAgentSession(session)
  }
}
