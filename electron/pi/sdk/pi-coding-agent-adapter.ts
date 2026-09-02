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
import type {
  PiAgentEvent,
  PiAgentRuntime,
  PiAgentSession,
  PiAgentSessionConfig,
} from './pi-agent-runtime'
import { redactText, redactValue } from '../../common/redact'
import {
  APPROVAL_TOOLS,
  READ_ONLY_TOOLS,
  buildBearerAuthorizationHeader,
} from '../../../pi-extension'
import { logger } from '../../common/logger'

const log = logger.child('pi-gateway')

let gatewayRequestSequence = 0

function getFailure(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
    if (candidate.role !== 'assistant') continue
    if (candidate.stopReason !== 'error' && candidate.stopReason !== 'aborted') return undefined
    if (typeof candidate.errorMessage === 'string' && candidate.errorMessage.trim()) {
      return redactText(candidate.errorMessage)
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

/** 将每次提供商请求序列化为 SEP 网关要求的消息格式。 */
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
      return { type: 'text_delta', data: { text: redactText(update.delta) } }
    }
    case 'tool_execution_start':
      return {
        type: event.type,
        data: {
          toolId: raw.toolCallId,
          toolName: raw.toolName,
          input: redactValue(raw.args),
        },
      }
    case 'tool_execution_end':
      return {
        type: event.type,
        data: {
          toolId: raw.toolCallId,
          toolName: raw.toolName,
          success: raw.isError !== true,
          error: raw.isError === true ? redactValue(raw.result) : undefined,
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
          error: redactText(event.errorMessage),
        },
      }
    case 'auto_retry_end':
      return {
        type: event.type,
        data: {
          success: event.success,
          attempt: event.attempt,
          error: event.finalError ? redactText(event.finalError) : undefined,
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
      return { type: event.type, data: redactValue(raw) }
    default:
      return null
  }
}

function buildExtensions(config: PiAgentSessionConfig): ExtensionFactory[] {
  const gatewayPayload: ExtensionFactory = pi => {
    log.debug('provider payload hook registered')
    pi.on('before_provider_request', (event: BeforeProviderRequestEvent) => {
      const requestId = ++gatewayRequestSequence
      log.debug('provider request hook entered', { requestId })
      try {
        const normalized = normalizeGatewayPayload(event.payload)
        const normalizedRecord = normalized && typeof normalized === 'object' ? normalized as { model?: unknown; messages?: unknown } : {}
        log.debug('normalized provider request', {
          requestId,
          model: typeof normalizedRecord.model === 'string' ? normalizedRecord.model : undefined,
          messageCount: Array.isArray(normalizedRecord.messages) ? normalizedRecord.messages.length : 0,
        })
        return normalized
      } catch (error) {
        log.error('payload normalization failed', {
          requestId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        throw error
      }
    })

    pi.on('after_provider_response', event => {
      log.debug('provider response received', {
        status: event.status,
        headers: redactValue(event.headers),
      })
    })
  }

  const toolGuard: ExtensionFactory = pi => {
    pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
      const toolName = event.toolName ?? 'unknown'
      if (READ_ONLY_TOOLS.has(toolName)) return { block: false }
      if (!APPROVAL_TOOLS.has(toolName)) {
        await config.reportPolicyEvent?.('unknown_tool_blocked', {
          toolName,
          reason: 'Unknown tools are denied by default.',
        })
        return { block: true, reason: `Unknown tool: ${toolName} - default deny` }
      }
      const approved = await config.authorizeTool({ toolName, input: redactValue(event.input) })
      return approved
        ? { block: false }
        : { block: true, reason: `User denied execution of high-risk tool: ${toolName}` }
    })
  }

  const providerAuth: ExtensionFactory = pi => {
    log.debug('provider headers hook registered')
    pi.on('before_provider_headers', async (event: BeforeProviderHeadersEvent): Promise<void> => {
      log.debug('provider headers hook entered')
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
    log.info('createSession started', {
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
    modelRuntime.registerProvider('sep-gateway', {
      name: 'SEP Gateway',
      baseUrl: config.gatewayUrl,
      apiKey: 'placeholder',
      api: 'openai-completions',
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
      noSkills: false,
      noContextFiles: true,
      additionalSkillPaths: config.additionalSkillPaths,
    })
    await resourceLoader.reload()
    const extensionState = resourceLoader.getExtensions()
    log.debug('resource loader reloaded', {
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
    log.info('createAgentSession completed', { sessionId: session.sessionId })
    return new PiCodingAgentSession(session)
  }
}
