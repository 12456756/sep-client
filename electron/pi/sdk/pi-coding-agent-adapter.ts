import { mkdir } from 'node:fs/promises'
import { lazyStream, type AssistantMessage, type SimpleStreamOptions, type StreamFunction } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  loadSkills,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type BeforeProviderRequestEvent,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type Skill,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { z } from 'zod'
import type { MediaToolName } from '../../domain/media-tools'
import { mediaCapabilitiesSchema, mediaGenerationInputSchema, mediaId } from '../../common/platform/media-contract'
import { mediaToolFailure, mediaToolFailureFrom } from '../../errors/media-tool-error'
import type {
  PiAgentEvent,
  PiAgentRuntime,
  PiAgentSession,
  PiAgentSessionConfig,
} from './pi-agent-runtime'
import { MAX_RUN_AUTO_RETRIES } from './pi-agent-runtime'
import { redactText, redactValue } from '../../common/redact'
import {
  BUILTIN_TOOL_NAMES,
  READ_ONLY_TOOLS,
  buildBearerAuthorizationHeader,
  evaluateToolCall,
  isUnrestrictedToolPolicy,
  requiresToolApproval,
} from '../../../pi-extension'
import { isLogLevelEnabled, logger } from '../../common/logger'
import { createMcpRuntime, type McpRuntime } from './pi-mcp-client'
import { loadHostMcpServers, PLAYWRIGHT_GUIDELINES } from './pi-playwright-mcp'
import { buildEmployeeSystemPrompt } from './employee-system-prompt'
import { GatewayRetryWait } from './gateway-retry-wait'
import { buildModelRequestAwareness, ModelRequestTracker, type ModelRequestSnapshot } from './model-request-tracker'
import { employeeSkillLoaderOptions } from './employee-skill-loader'

const log = logger.child('pi-gateway')

export type PiSkill = Skill
export type PiLoadSkills = typeof loadSkills
export type PiResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

let gatewayRequestSequence = 0

const DEFAULT_SESSION_TOOLS = ['read', 'bash', 'edit', 'write'] as const
const MEDIA_TOOL_NAMES: readonly MediaToolName[] = ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job']
const READ_ONLY_MEDIA_TOOLS = new Set<MediaToolName>(['media_get_capabilities', 'media_get_job'])

function registeredMediaNames(config: PiAgentSessionConfig): MediaToolName[] {
  if (config.disableTools || !config.mediaTools) return []
  return MEDIA_TOOL_NAMES.filter(name => config.mediaTools?.names.includes(name) && (
    READ_ONLY_MEDIA_TOOLS.has(name) || !config.toolPolicy || (
      config.toolPolicy.preset !== 'read-only' &&
      (config.toolPolicy.preset === 'full-local' || config.toolPolicy.allowedTools.includes(name))
    )
  ))
}

const mediaJobInputSchema = z.object({ jobId: mediaId }).strict()
const mediaCancelInputSchema = mediaJobInputSchema.extend({ cancelUpstream: z.boolean() }).strict()
const emptyMediaInputSchema = z.object({}).strict()
const mediaAssetResultSchema = z.object({
  localAssetId: mediaId, taskId: z.string(), jobId: z.string().nullable(), outputId: z.string().nullable(),
  source: z.enum(['reference', 'output']), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  size: z.number(), width: z.number(), height: z.number(),
  status: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
})
const mediaJobResultSchema = z.object({
  jobId: mediaId, taskId: z.string(), runId: z.string(), profileId: z.string(), operation: z.enum(['generate', 'edit']),
  parameters: mediaGenerationInputSchema.shape.parameters,
  generationStatus: z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']),
  trackingStatus: z.enum(['ACTIVE', 'INTERRUPTED', 'AUTH_REQUIRED', 'STOPPED']),
  saveStatus: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
  billingStatus: z.string(), error: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
  assets: z.array(mediaAssetResultSchema), canCancelUpstream: z.boolean(),
})

function safeMediaResult(name: MediaToolName, result: unknown): { value: unknown; isError: boolean } {
  // Project business views only: quotes, provider credentials, URLs and transport DTOs never reach Pi.
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    const parsed = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }).safeParse(result)
    if (parsed.success) return { value: mediaToolFailure(parsed.data.error.code, parsed.data.error.message), isError: true }
    throw new Error('Invalid media business error.')
  }
  const value = name === 'media_get_capabilities'
    ? (result && typeof result === 'object' && 'capabilities' in result
        ? z.object({ capabilities: mediaCapabilitiesSchema, referenceAssets: z.array(mediaAssetResultSchema) }).parse(result)
        : mediaCapabilitiesSchema.parse(result))
    : mediaJobResultSchema.parse(result)
  return { value: redactValue(value), isError: false }
}

function mediaToolDefinitions(config: PiAgentSessionConfig, names: readonly MediaToolName[]): ToolDefinition[] {
  const id = Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' })
  const parameters = {
    media_get_capabilities: Type.Object({}, { additionalProperties: false }),
    media_generate_image: Type.Object({
      profileId: Type.String({ minLength: 1, maxLength: 256 }),
      operation: Type.Union([Type.Literal('generate'), Type.Literal('edit')]),
      localAssetIds: Type.Array(id, { maxItems: 16 }),
      creativeBrief: Type.String({ minLength: 1, maxLength: 20_000 }),
      parameters: Type.Object({
        aspectRatio: Type.String({ minLength: 1, maxLength: 32 }), count: Type.Integer({ minimum: 1, maximum: 16 }),
        size: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        quality: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
    media_get_job: Type.Object({ jobId: id }, { additionalProperties: false }),
    media_cancel_job: Type.Object({ jobId: id, cancelUpstream: Type.Boolean() }, { additionalProperties: false }),
  }
  const validators = {
    media_get_capabilities: emptyMediaInputSchema, media_generate_image: mediaGenerationInputSchema,
    media_get_job: mediaJobInputSchema, media_cancel_job: mediaCancelInputSchema,
  }
  const descriptions = {
    media_get_capabilities: 'Get available image profiles and their supported operations.',
    media_generate_image: 'Generate or edit images using a supported profile and task-local reference assets. First call media_get_capabilities; use only advertised operations, aspect ratios, sizes, qualities and counts. Omit optional size or quality unless advertised by the profile; do not invent quality values. INVALID_ARGUMENT means unsupported input, not denied permission: correct parameters using capabilities. The host validates cost and obtains approval before submission.',
    media_get_job: 'Get the business status and task-local assets of an image job.',
    media_cancel_job: 'Stop tracking an image job, optionally requesting upstream cancellation through the host approval policy.',
  }
  return names.map(name => ({
    name, label: name, description: descriptions[name], parameters: parameters[name], executionMode: 'sequential',
    async execute(_toolCallId, input, signal) {
      try {
        const parsed = validators[name].safeParse(input)
        if (!parsed.success) return {
          content: [{ type: 'text', text: 'Invalid media tool input.' }], details: { isError: true },
        }
        if (signal?.aborted) throw new Error('Cancelled media call.')
        const result = safeMediaResult(name, await config.mediaTools!.execute(name, parsed.data, signal))
        return { content: [{ type: 'text', text: JSON.stringify(result.value) }], details: { isError: result.isError } }
      } catch (error) {
        const value = mediaToolFailureFrom(error, signal?.aborted)
        return {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          details: { isError: true },
        }
      }
    },
  }))
}
const GATEWAY_MAX_OUTPUT_TOKENS = 4096
const OPENAI_COMPLETIONS_API_MODULE = '@earendil-works/pi-ai/api/openai-completions'
const HAN_CHARACTER = /\p{Script=Han}/u

export function sessionToolOptions(
  toolPolicy: PiAgentSessionConfig['toolPolicy'],
  disableTools = false,
  registeredMcpNames: readonly string[] = [],
  registeredMediaNames: readonly MediaToolName[] = [],
): { tools?: string[]; noTools?: 'all' } {
  if (disableTools) return { noTools: 'all' }
  const allowedTools = toolPolicy && isUnrestrictedToolPolicy(toolPolicy)
    ? [...BUILTIN_TOOL_NAMES]
    : toolPolicy ? [...toolPolicy.allowedTools] : [...DEFAULT_SESSION_TOOLS]
  return { tools: [...new Set([
    ...allowedTools.filter(name => (!name.startsWith('mcp__') || registeredMcpNames.includes(name)) &&
      (!name.startsWith('media_') || registeredMediaNames.includes(name as MediaToolName))),
    ...registeredMcpNames,
    ...registeredMediaNames,
  ])] }
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
      return redactText(candidate.errorMessage)
    }
    return candidate.stopReason === 'aborted' ? 'Agent run was aborted.' : 'Agent run failed.'
  }
  return undefined
}

function gatewayContent(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(part => {
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      return ''
    }).filter(Boolean).join('\n')
  }
  return value == null ? null : String(value)
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(toolResultText).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.error === 'string') return record.error
    if ('content' in record) return toolResultText(record.content)
  }
  return value == null ? '' : String(value)
}

function gatewayOutputLimit(context: Record<string, unknown>): number | undefined {
  return typeof context.max_tokens === 'number' ? context.max_tokens
    : typeof context.max_completion_tokens === 'number' ? context.max_completion_tokens : undefined
}

export function buildGatewayThinkingLogFields(content: readonly AssistantMessage['content'][number][]): {
  thinkingLength: number
  estimatedThinkingTokens: number
} {
  let thinkingLength = 0
  let estimatedTokenTenths = 0
  for (const part of content) {
    if (part.type !== 'thinking') continue
    // Length uses JS UTF-16 units, matching the existing contentLength diagnostic.
    thinkingLength += part.thinking.length
    // Diagnostic heuristic only: ASCII 0.3, Han 0.6, other Unicode code points 1.
    // Iterate code points without copying the text; round once across all blocks.
    for (const character of part.thinking) {
      estimatedTokenTenths += character.charCodeAt(0) <= 0x7f ? 3 : HAN_CHARACTER.test(character) ? 6 : 10
    }
  }
  return { thinkingLength, estimatedThinkingTokens: Math.ceil(estimatedTokenTenths / 10) }
}

export function buildGatewayRequestLogFields(context: Record<string, unknown>, requestId: number): Record<string, unknown> {
  const tools = Array.isArray(context.tools) ? context.tools as unknown[] : []
  const toolNames = tools.flatMap(tool => {
    if (!tool || typeof tool !== 'object') return []
    const definition = (tool as Record<string, unknown>).function
    const name = definition && typeof definition === 'object' ? (definition as Record<string, unknown>).name : undefined
    return typeof name === 'string' ? [name] : []
  })
  return {
    requestId,
    model: context.model,
    messageCount: Array.isArray(context.messages) ? context.messages.length : 0,
    outputLimit: gatewayOutputLimit(context),
    temperature: context.temperature,
    stream: context.stream,
    includeUsage: context.stream_options && typeof context.stream_options === 'object'
      ? (context.stream_options as Record<string, unknown>).include_usage : undefined,
    toolCount: toolNames.length,
    ...(toolNames.length ? { tools: toolNames.join(', ') } : {}),
  }
}


/**
 * Classify tool failures for event metadata and audit consumers.
 * Tool failures are returned to Pi as error tool results; this classification
 * must not be used to abort or retry the agent loop.
 * Exported for testing.
 */
export function classifyToolFailure(_toolName: unknown, result: unknown): 'unknown-tool' | 'policy-denied' | 'execution-failed' {
  const resultStr = toolResultText(result)

  // Pi SDK returns "Tool xxx not found" when tool is not in registry
  if (/Tool .* not found/i.test(resultStr)) {
    return 'unknown-tool'
  }

  // Our guard returns denial messages with "denied" or "blocked"
  if (/denied|blocked|not allowed|policy/i.test(resultStr)) {
    return 'policy-denied'
  }

  // Everything else is a real execution failure
  return 'execution-failed'
}


/** Serialize each provider request into the SEP gateway message shape. */
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

    return [{
      role,
      content: gatewayContent(current.content),
      ...(role === 'assistant' && current.reasoning_content !== undefined
        ? { reasoning_content: current.reasoning_content }
        : {}),
      ...(role === 'assistant' && Array.isArray(current.tool_calls) ? { tool_calls: current.tool_calls } : {}),
      ...(role === 'tool' && typeof current.tool_call_id === 'string' ? { tool_call_id: current.tool_call_id } : {}),
      ...(typeof current.name === 'string' ? { name: current.name } : {}),
    }]
  })

  const source = payload as Record<string, unknown>
  const maxTokens = Number.isInteger(source.max_tokens) && (source.max_tokens as number) > 0
    ? source.max_tokens
    : source.max_completion_tokens
  const streamOptions = source.stream_options && typeof source.stream_options === 'object'
    ? source.stream_options as Record<string, unknown> : undefined
  return {
    model: typeof source.model === 'string' ? source.model : '',
    messages,
    ...(typeof source.temperature === 'number' ? { temperature: source.temperature } : {}),
    ...(Number.isInteger(maxTokens) && (maxTokens as number) > 0 ? { max_tokens: maxTokens } : {}),
    ...(typeof source.stream === 'boolean' ? { stream: source.stream } : {}),
    ...(typeof streamOptions?.include_usage === 'boolean'
      ? { stream_options: { include_usage: streamOptions.include_usage } } : {}),
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
      log.debug('tool execution completed', {
        toolId: raw.toolCallId,
        toolName: raw.toolName,
        success: raw.isError !== true,
        resultLength: toolResultText(raw.result).length,
      })
      return {
        type: event.type,
        data: {
          toolId: raw.toolCallId,
          toolName: raw.toolName,
          success: raw.isError !== true,
          error: raw.isError === true ? redactValue(raw.result) : undefined,
          // Tag the failure reason for worker to classify it properly
          failureReason: raw.isError === true ? classifyToolFailure(raw.toolName, raw.result) : undefined,
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

function buildExtensions(config: PiAgentSessionConfig, mcp: McpRuntime): ExtensionFactory[] {
  const mediaNames = registeredMediaNames(config)
  const mediaExtension: ExtensionFactory = pi => {
    for (const tool of mediaToolDefinitions(config, mediaNames)) pi.registerTool(tool)
    pi.on('tool_result', event => {
      if (!mediaNames.includes(event.toolName as MediaToolName)) return
      if (event.details && typeof event.details === 'object' && 'isError' in event.details && event.details.isError === true) {
        return { isError: true }
      }
    })
  }
  const toolPolicy = config.toolPolicy ? {
    ...config.toolPolicy,
    // Only explicitly enabled and actually discovered host tools extend the local policy.
    allowedTools: [...config.toolPolicy.allowedTools, ...mcp.permissions.keys()],
  } : undefined
  const gatewayPayload: ExtensionFactory = pi => {
    let activeRequest: { requestId: number; startedAt: number; outputLimit?: number; platformRequestId?: string; providerStatus?: number } | undefined
    let latestInputSequence = 0
    log.trace('provider payload hook registered')
    pi.on('turn_start', () => { activeRequest = undefined })
    pi.on('before_provider_request', (event: BeforeProviderRequestEvent) => {
      const requestId = ++gatewayRequestSequence
      activeRequest = { requestId, startedAt: Date.now() }
      try {
        const context = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
        activeRequest.outputLimit = gatewayOutputLimit(context)
        if (isLogLevelEnabled('info')) {
          const { tools, ...fields } = buildGatewayRequestLogFields(context, requestId)
          log.info('model request overview', {
            runId: config.runId, latestInputSequence, ...fields,
          })
          if (tools) log.trace('model request tool list', { runId: config.runId, requestId, tools })
        }
      } catch (error) {
        log.error('provider request diagnostics failed', {
          runId: config.runId,
          requestId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        throw error
      }
    })

    pi.on('after_provider_response', event => {
      if (activeRequest) {
        activeRequest.platformRequestId = event.headers['x-request-id']
        activeRequest.providerStatus = event.status
      }
      log.trace('provider response received', {
        runId: config.runId,
        requestId: activeRequest?.requestId,
        status: event.status,
        platformRequestId: event.headers['x-request-id'],
        retryAfter: event.headers['retry-after'],
      })
    })

    // after_provider_response exposes headers only, never a JSON body (including SSE).
    // Inspect the final assembled message rather than logging every streaming delta.
    pi.on('message_end', event => {
      const response = event.message
      if (response.role !== 'assistant') {
        if (response.role !== 'user' && response.role !== 'toolResult' && response.role !== 'custom') return
        // Live events contain only new inputs; replayed history and retry payloads never pass here.
        const inputSequence = ++latestInputSequence
        if (!isLogLevelEnabled('debug')) return
        const role = response.role === 'toolResult' ? 'tool' : response.role
        const content = gatewayContent(response.content)
        log.debug(`model input added: ${role}`, {
          displayTitle: role === 'tool' ? '模型输入（工具返回）' : role === 'user' ? '模型输入（用户消息）' : '模型输入（补充消息）',
          runId: config.runId, inputSequence, role, content, contentLength: content?.length ?? 0,
          ...(response.role === 'toolResult' ? { toolCallId: response.toolCallId, name: response.toolName, isError: response.isError } : {}),
        })
        return
      }
      const request = activeRequest
      activeRequest = undefined
      const calls = response.content.filter(part => part.type === 'toolCall')
      const textParts = response.content.filter(part => part.type === 'text')
      const contentLength = textParts.reduce((length, part) => length + part.text.length, Math.max(textParts.length - 1, 0))
      log.info('model response completed', {
        runId: config.runId,
        requestId: request?.requestId,
        platformRequestId: request?.platformRequestId,
        providerStatus: request?.providerStatus,
        model: response.model,
        stopReason: response.stopReason,
        elapsedMs: request ? Date.now() - request.startedAt : undefined,
        outputLimit: request?.outputLimit,
        contentLength,
        ...(isLogLevelEnabled('info') ? buildGatewayThinkingLogFields(response.content) : {}),
        toolCount: calls.length,
        usage: { input: response.usage.input, output: response.usage.output,
          cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, total: response.usage.totalTokens },
        ...(response.errorMessage ? { error: response.errorMessage } : {}),
      })
      if (isLogLevelEnabled('debug')) {
        const thinking = response.content.filter(part => part.type === 'thinking').map(part => part.thinking).join('\n')
        if (thinking) {
          log.debug('model response thinking', {
            displayTitle: '模型思考', runId: config.runId, requestId: request?.requestId,
            content: thinking,
          })
        }
        const text = textParts.map(part => part.text).join('\n')
        const toolSummary = calls.length ? `调用工具：${calls.map(call => call.name).join('、')}` : ''
        log.debug('model response content', {
          displayTitle: '模型输出', runId: config.runId, requestId: request?.requestId,
          content: [text, toolSummary].filter(Boolean).join('\n\n') || '（本轮没有正文输出）',
        })
      }
      if (calls.length === 0) return
      const availableTools = pi.getActiveTools()
      log.trace('provider tool calls assembled', {
        runId: config.runId,
        requestId: request?.requestId,
        toolCalls: calls.map(call => ({ toolId: call.id, toolName: call.name })),
      })
      const unavailable = calls.filter(call => !availableTools.includes(call.name))
      if (unavailable.length > 0) {
        log.warn('provider returned unavailable tool calls', {
          toolNames: unavailable.map(call => call.name), availableTools,
        })
      }
    })
  }

  const mcpExtension: ExtensionFactory = pi => {
    for (const tool of mcp.tools) {
      pi.registerTool(tool.name === 'mcp__playwright__browser_snapshot'
        ? { ...tool, promptGuidelines: PLAYWRIGHT_GUIDELINES } : tool)
    }
    pi.on('tool_result', event => {
      if (!mcp.permissions.has(event.toolName)) return
      const details: unknown = event.details
      if (details && typeof details === 'object' && 'isError' in details && details.isError === true) {
        return { isError: true }
      }
    })
  }

  const toolGuard: ExtensionFactory = pi => {
    pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
      const toolName = event.toolName ?? 'unknown'
      if (toolName.startsWith('media_')) {
        if (mediaNames.includes(toolName as MediaToolName) && pi.getActiveTools().includes(toolName)) {
          // The trusted facade owns quote validation and approval, even in full-local-auto.
          return { block: false }
        }
        await config.reportPolicyEvent?.('unknown_tool_blocked', { toolName, reason: 'Media tool is not enabled for this run.' })
        return { block: true, reason: `Unknown tool: ${toolName} - default deny` }
      }
      if (toolPolicy && isUnrestrictedToolPolicy(toolPolicy)) {
        // In the explicit highest-permission mode, the policy is no longer a
        // path/command/approval gate. Pi still remains the source of truth for
        // what can execute: an unknown provider name is not an executor.
        if (pi.getActiveTools().includes(toolName)) return { block: false }
        await config.reportPolicyEvent?.('unknown_tool_blocked', {
          toolName,
          reason: 'Unknown tools are denied by default.',
        })
        return { block: true, reason: `Unknown tool: ${toolName} - default deny` }
      }
      if (toolPolicy) {
        const decision = evaluateToolCall(toolName, event.input, toolPolicy, mcp.permissions)
        if (!decision.allowed) {
          await config.reportPolicyEvent?.('tool_call_blocked', {
            toolName,
            reason: decision.reason ?? 'policy-denied',
          })
          return { block: true, reason: `Tool denied by task policy: ${toolName} (${decision.reason ?? 'policy-denied'})` }
        }
        if (!decision.requiresApproval) return { block: false }
      }
      if (READ_ONLY_TOOLS.has(toolName)) return { block: false }
      if (mcp.permissions.get(toolName) === 'auto-approve') return { block: false }
      if (!requiresToolApproval(toolName) && !mcp.permissions.has(toolName)) {
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

  return [gatewayPayload, ...(mcp.tools.length ? [mcpExtension] : []), ...(mediaNames.length ? [mediaExtension] : []), toolGuard]
}

class PiCodingAgentSession implements PiAgentSession {
  private readonly listeners = new Set<(event: PiAgentEvent) => void>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly session: Awaited<ReturnType<typeof createAgentSession>>['session'],
    private readonly mcp: McpRuntime,
    private readonly retryWait: GatewayRetryWait,
    private readonly settingsManager: SettingsManager,
    private readonly requestTracker: ModelRequestTracker | null,
  ) {
    this.unsubscribe = session.subscribe(event => {
      this.requestTracker?.observe(event)
      if (event.type === 'auto_retry_end' && event.success === true) retryWait.reset()
      const delayMs = event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled'
        ? retryWait.schedule() : undefined
      const normalized = normalizeEvent(event)
      if (!normalized) return
      if (event.type === 'auto_retry_start') {
        normalized.data = { ...(normalized.data as Record<string, unknown>), delayMs }
      }
      if (event.type === 'agent_end' && !event.willRetry && retryWait.terminalError) {
        normalized.failure = retryWait.terminalError
      }
      for (const listener of this.listeners) listener(normalized)
    })
  }

  get sessionId(): string {
    return this.session.sessionId
  }

  get sessionFile(): string | null {
    return this.session.sessionFile ?? null
  }

  async prompt(text: string): Promise<void> {
    this.requestTracker?.startPrompt()
    this.retryWait.reset()
    this.settingsManager.setRetryEnabled(true)
    await this.session.prompt(text)
    if (this.requestTracker?.failure) throw this.requestTracker.failure
  }

  abort(): Promise<void> {
    return this.session.abort()
  }

  subscribe(listener: (event: PiAgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    this.listeners.clear()
    try {
      await this.session.dispose()
    } finally {
      await this.mcp.dispose()
    }
  }
}

export class PiCodingAgentAdapter implements PiAgentRuntime {
  async createSession(config: PiAgentSessionConfig): Promise<PiAgentSession> {
    log.trace('createSession started', {
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
    const retryWait = new GatewayRetryWait()
    const settingsManager = SettingsManager.inMemory({
      // The request boundary applies the one cancellable delay; Pi must not sleep again.
      retry: { enabled: true, maxRetries: MAX_RUN_AUTO_RETRIES, baseDelayMs: 0, provider: { maxRetries: 0 } },
    })
    const requestTracker = config.onModelRequest ? new ModelRequestTracker(config.onModelRequest) : null
    // The exported subpath is loaded dynamically under the project's legacy Node resolution.
    const { streamSimple }: { streamSimple: StreamFunction<'openai-completions', SimpleStreamOptions> } =
      await import(OPENAI_COMPLETIONS_API_MODULE)
    modelRuntime.registerProvider('sep-gateway', {
      name: 'SEP Gateway',
      baseUrl: config.gatewayUrl,
      apiKey: 'placeholder',
      api: 'openai-completions',
      streamSimple: (model, context, options) => lazyStream(model, async () => {
        // ModelRuntime prepares headers before entering this provider; authenticate at fetch instead.
        await retryWait.wait(options?.signal)
        options?.signal?.throwIfAborted()
        let snapshot: ModelRequestSnapshot | undefined
        try {
          // Persist outside extension hooks: Pi reports hook errors but can still send the request.
          snapshot = await requestTracker?.prepare(options?.signal)
        } catch (error) {
          settingsManager.setRetryEnabled(false)
          throw error
        }
        const requestContext = snapshot && snapshot.kind !== 'compaction'
          ? { ...context, systemPrompt: [context.systemPrompt, buildModelRequestAwareness(snapshot.progress, snapshot.kind)].filter(Boolean).join('\n\n') }
          : context
        return streamSimple({ ...model, api: 'openai-completions' }, requestContext, {
          ...options,
          maxTokens: GATEWAY_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(payload, requestModel)
            // Standalone summaries omit the Agent hooks; normalize once after any caller hook.
            return normalizeGatewayPayload(replacement === undefined ? payload : replacement)
          },
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            headers.set('authorization', buildBearerAuthorizationHeader(await config.getAccessToken()))
            const response = await globalThis.fetch(input, { ...init, headers })
            if (!retryWait.inspect(response)) settingsManager.setRetryEnabled(false)
            return response
          },
        })
      }),
      models: [{
        id: config.modelId,
        name: config.modelId,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: GATEWAY_MAX_OUTPUT_TOKENS,
      }],
    })
    const model = modelRuntime.getModel('sep-gateway', config.modelId)
    if (!model) throw new Error('Failed to resolve task model.')

    // Execution-disabled/planner policies must not gain external tools or spawn MCP servers.
    const canUseMcp = !config.disableTools && (!config.toolPolicy || config.toolPolicy.allowedTools.length > 0 || isUnrestrictedToolPolicy(config.toolPolicy))
    const servers = canUseMcp ? config.mcpServers ?? await loadHostMcpServers() : []
    const mcp = await createMcpRuntime(servers, config.workspaceDir)
    try {
      const employeePrompt = config.employeeProfile ? buildEmployeeSystemPrompt(config.employeeProfile) : undefined
      const resourceLoader = new DefaultResourceLoader({
        cwd: config.workspaceDir,
        agentDir: config.agentDir,
        extensionFactories: buildExtensions(config, mcp),
        ...employeeSkillLoaderOptions(
          config.workspaceDir,
          config.agentDir,
          config.employeeProfile ? config.additionalSkillPaths ?? [] : undefined,
          loadSkills,
        ),
        noContextFiles: true,
        additionalSkillPaths: config.additionalSkillPaths,
        // Use the literal override: the SDK's systemPrompt option also interprets existing paths as files.
        systemPromptOverride: config.systemPrompt === undefined ? undefined : () => config.systemPrompt,
        appendSystemPromptOverride: employeePrompt || config.fixedSystemPrompt
          ? base => [...base, ...(employeePrompt ? [employeePrompt] : []), ...(config.fixedSystemPrompt ? [config.fixedSystemPrompt] : [])]
          : undefined,
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
        // Advertise only the task policy's tools so the model cannot select denied tools.
        ...sessionToolOptions(config.toolPolicy, config.disableTools, [...mcp.permissions.keys()], registeredMediaNames(config)),
        // Apply retries at the session layer only; never inherit workstation CLI retry overrides.
        settingsManager,
      })
      log.trace('createAgentSession completed', { sessionId: session.sessionId })
      return new PiCodingAgentSession(session, mcp, retryWait, settingsManager, requestTracker)
    } catch (error) {
      await mcp.dispose()
      throw error
    }
  }
}


