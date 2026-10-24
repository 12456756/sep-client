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
import type { VideoToolName } from '../../domain/video-tools'
import { videoToolGenerationInputSchema, videoToolJobInputSchema } from '../../../src/shared/video-host'
import { videoBillingStatusSchema, videoOutputSchema, videoParametersSchema, videoRuntimeSchema } from '../../../src/shared/video-media'
import { mediaToolGenerationInputSchema } from '../../../src/shared/media-host'
import { mediaCapabilitiesSchema, mediaGenerationInputSchema, mediaId } from '../../common/platform/media-contract'
import { mediaToolFailure, mediaToolFailureFrom } from '../../errors/media-tool-error'
import { videoToolFailureDiagnostic, videoToolFailureFrom } from '../../errors/video-tool-error'
import { AppError } from '../../errors/app-error'
import type {
  PiAgentEvent,
  PiAgentRuntime,
  PiAgentSession,
  PiAgentSessionConfig,
} from './pi-agent-runtime'
import { MAX_RUN_AUTO_RETRIES } from './pi-agent-runtime'
import { redactText, redactValue } from '../../common/redact'
import { redactKnowledgeContextForLog } from '../../common/knowledge-context'
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
import { encodingToolDefinitions } from './pi-text-tools'

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

const VIDEO_TOOL_NAMES: readonly VideoToolName[] = ['video_from_image', 'video_generate', 'video_get_job']

function registeredVideoNames(config: PiAgentSessionConfig): VideoToolName[] {
  if (config.disableTools || !config.videoTools) return []
  return VIDEO_TOOL_NAMES.filter(name => config.videoTools?.names.includes(name) && (
    name === 'video_get_job' || !config.toolPolicy || (
      config.toolPolicy.preset !== 'read-only' &&
      (config.toolPolicy.preset === 'full-local' || config.toolPolicy.allowedTools.includes(name))
    )
  ))
}

const videoId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const videoJobResultSchema = z.object({
  jobId: videoId, taskId: videoId, profileId: videoId,
  operation: z.enum(['image-to-video', 'text-to-video']),
  parameters: videoParametersSchema.extend({ aspectRatio: z.string().regex(/^\d+:\d+$/).max(32) }),
  generationStatus: z.enum(['NOT_SUBMITTED', 'SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']),
  trackingStatus: z.enum(['ACTIVE', 'INTERRUPTED', 'AUTH_REQUIRED', 'STOPPED']),
  saveStatus: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
  billingStatus: videoBillingStatusSchema,
  amountCny: z.string().regex(/^\d+\.\d{6}$/).max(128).optional(),
  actualCostCny: z.string().regex(/^\d+\.\d{6}$/).max(128).optional(),
  amountUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).max(128).optional(),
  // Free-form upstream messages can echo prompts, paths or credentials. Never forward them.
  error: z.string().max(8192).nullable().transform(value => value === null ? null : 'Video job reported an error.'),
  createdAt: z.number().nonnegative().finite(), updatedAt: z.number().nonnegative().finite(),
  outputs: z.array(videoOutputSchema.strip()).max(4),
}).refine(job => job.billingStatus !== 'MOCK_NOT_CHARGED' || job.amountCny === undefined && job.actualCostCny === undefined && job.amountUsd === undefined)
const videoTaskResultSchema = z.object({
  mock: z.boolean(), runtime: videoRuntimeSchema.refine(runtime => runtime.tools.length <= 4 &&
    runtime.profiles.every(profile => profile.capabilities.aspectRatios.every(ratio => ratio.length <= 32))),
  jobs: z.array(videoJobResultSchema).max(50),
  referenceAssets: z.array(z.object({
    localAssetId: videoId, taskId: videoId, jobId: z.null(), outputId: z.null(), source: z.literal('reference'),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), size: z.number().int().positive(),
    width: z.number().int().positive(), height: z.number().int().positive(),
    status: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
  })).max(100).optional(),
}).refine(task => (task.runtime.executionMode ?? 'mock') === (task.mock ? 'mock' : 'real') &&
  task.jobs.every(job => (job.billingStatus === 'MOCK_NOT_CHARGED') === task.mock))

function safeVideoResult(result: unknown, names: readonly VideoToolName[]): unknown {
  // Only bounded business schemas are serialized. Raw host records and error objects fail closed.
  const parsed = z.union([videoJobResultSchema, videoTaskResultSchema]).parse(result)
  if (!('runtime' in parsed)) return parsed
  return {
    ...parsed,
    runtime: {
      ...parsed.runtime,
      tools: parsed.runtime.tools.filter(name => names.includes(name as VideoToolName)),
      profiles: parsed.runtime.profiles.map(profile => ({
        ...profile, configVersion: videoId.parse(profile.configVersion),
        // Runtime display names are free text too; keep model-facing metadata deterministic.
        displayName: 'Video profile',
      })),
    },
  }
}

function videoToolDefinitions(config: PiAgentSessionConfig, names: readonly VideoToolName[]): ToolDefinition[] {
  const id = Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' })
  const parameters = Type.Object({
    durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    aspectRatio: Type.Optional(Type.String({ pattern: '^\\d+:\\d+$' })),
    resolution: Type.Optional(Type.Union(['480p', '720p', '1080p', '4k'].map(value => Type.Literal(value)))),
    frameRate: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })), audio: Type.Optional(Type.Boolean()),
    outputFormat: Type.Optional(Type.Union([Type.Literal('video/mp4'), Type.Literal('video/webm')])),
  }, { additionalProperties: false })
  return names.map(name => {
    const operation = name === 'video_from_image' ? 'image-to-video' : 'text-to-video'
    return {
      name, label: name, executionMode: 'sequential',
      description: name === 'video_get_job'
        ? 'Get a task-local video job by jobId, or call with {} to list current VIDEO profiles, supported specifications, jobs and referenceAssets. Image capabilities do not describe video availability.'
        : `Generate a video using ${operation}. Supply creativeBrief; the host selects the authorized video profile and backend defaults. Do not require users to configure profileId or technical parameters. Only specify parameters explicitly requested by the user, using video_get_job with {} to check supported values. ${name === 'video_from_image' ? 'Supply one SAVED task-local referenceAssets localAssetId; never invent IDs or file paths.' : 'No reference assets are needed.'} The host validates cost and obtains approval before submission. Report tool error codes, never invent a missing-profile diagnosis, and never automatically retry a paid submission.`,
      parameters: name === 'video_get_job' ? Type.Object({ jobId: Type.Optional(id) }, { additionalProperties: false })
        : Type.Object({
          profileId: Type.Optional(id), operation: Type.Optional(Type.Literal(operation)),
          localAssetIds: name === 'video_from_image' ? Type.Array(id, { minItems: 1, maxItems: 1 }) : Type.Optional(Type.Array(id, { maxItems: 0 })),
          creativeBrief: Type.String({ minLength: 1, maxLength: 4000 }), parameters: Type.Optional(parameters),
        }, { additionalProperties: false }),
      async execute(_toolCallId, input, signal) {
        const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], details: { isError: true } })
        try {
          // Recheck the facade and task policy at dispatch, including direct SDK execution.
          if (!registeredVideoNames(config).includes(name)) return failure('Video tool is not enabled for this run.')
          const parsed = name === 'video_get_job' ? videoToolJobInputSchema.safeParse(input) : videoToolGenerationInputSchema.safeParse(input)
          if (!parsed.success || ('creativeBrief' in parsed.data && (parsed.data.operation !== undefined && parsed.data.operation !== operation || parsed.data.localAssetIds.length !== (name === 'video_from_image' ? 1 : 0)))) {
            return failure(JSON.stringify(videoToolFailureFrom(new AppError('INVALID_ARGUMENT'))))
          }
          if (signal?.aborted) return failure('Video tool request cancelled.')
          const result = await config.videoTools!.execute(name, parsed.data, signal)
          if (signal?.aborted) return failure('Video tool request cancelled.')
          const value = safeVideoResult(result, registeredVideoNames(config))
          const text = JSON.stringify(value)
          if (text.length > 65_536) return failure('Video tool result exceeds the safe limit.')
          return { content: [{ type: 'text', text: redactText(text, 65_536) }], details: { isError: false } }
        } catch (error) {
          // Neither validation diagnostics nor transport errors may echo the Pi prompt or host internals.
          if (signal?.aborted) return failure('Video tool request cancelled.')
          const business = videoToolFailureFrom(error)
          const diagnostic = videoToolFailureDiagnostic(error)
          log.warn('video tool rejected', {
            runId: config.runId,
            toolCallId: _toolCallId,
            tool: name,
            exceptionType: diagnostic.exceptionType,
            code: diagnostic.code,
            ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
            ...(diagnostic.resource === undefined ? {} : { resource: diagnostic.resource }),
            ...(diagnostic.stage === undefined ? {} : { stage: diagnostic.stage }),
          })
          return failure(JSON.stringify(business))
        }
      },
    } satisfies ToolDefinition
  })
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
      profileId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      operation: Type.Optional(Type.Union([Type.Literal('generate'), Type.Literal('edit')])),
      localAssetIds: Type.Optional(Type.Array(id, { maxItems: 16 })),
      creativeBrief: Type.String({ minLength: 1, maxLength: 20_000 }),
      parameters: Type.Optional(Type.Object({
        aspectRatio: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
        size: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        quality: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    media_get_job: Type.Object({ jobId: id }, { additionalProperties: false }),
    media_cancel_job: Type.Object({ jobId: id, cancelUpstream: Type.Boolean() }, { additionalProperties: false }),
  }
  const validators = {
    media_get_capabilities: emptyMediaInputSchema, media_generate_image: mediaToolGenerationInputSchema,
    media_get_job: mediaJobInputSchema, media_cancel_job: mediaCancelInputSchema,
  }
  const descriptions = {
    media_get_capabilities: 'Get the currently authorized image capability and the task reference images selected in the image panel.',
    media_generate_image: "Create an image from the user's creative brief. The host selects the authorized image profile and fills supported defaults. Use the task reference images selected in the image panel when relevant; request localAssetIds only when the user names a different saved referenceAssets item. Specify profile, operation or supported parameters only when the user explicitly asks. The host validates cost and obtains approval before submission.",
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
const GATEWAY_CONTEXT_WINDOW = 128_000
const OPENAI_COMPLETIONS_API_MODULE = '@earendil-works/pi-ai/api/openai-completions'
const HAN_CHARACTER = /\p{Script=Han}/u

export function sessionToolOptions(
  toolPolicy: PiAgentSessionConfig['toolPolicy'],
  disableTools = false,
  registeredMcpNames: readonly string[] = [],
  registeredMediaNames: readonly MediaToolName[] = [],
  registeredVideoNames: readonly VideoToolName[] = [],
): { tools?: string[]; noTools?: 'all' } {
  if (disableTools) return { noTools: 'all' }
  const allowedTools = toolPolicy && isUnrestrictedToolPolicy(toolPolicy)
    ? [...BUILTIN_TOOL_NAMES]
    : toolPolicy ? [...toolPolicy.allowedTools] : [...DEFAULT_SESSION_TOOLS]
  return { tools: [...new Set([
    ...allowedTools.filter(name => (!name.startsWith('mcp__') || registeredMcpNames.includes(name)) &&
      (!name.startsWith('media_') || registeredMediaNames.includes(name as MediaToolName)) &&
      (!name.startsWith('video_') || registeredVideoNames.includes(name as VideoToolName))),
    ...registeredMcpNames,
    ...registeredMediaNames,
    ...registeredVideoNames,
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
    outputBudgetSource: 'platform',
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
  const streamOptions = source.stream_options && typeof source.stream_options === 'object'
    ? source.stream_options as Record<string, unknown> : undefined
  return {
    model: typeof source.model === 'string' ? source.model : '',
    messages,
    ...(typeof source.temperature === 'number' ? { temperature: source.temperature } : {}),
    // Omit SDK-generated budgets for execution and compaction; the platform owns the limit.
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

export function buildExtensions(config: PiAgentSessionConfig, mcp: McpRuntime): ExtensionFactory[] {
  const systemPromptTransform: ExtensionFactory = pi => {
    if (config.transformSystemPrompt) {
      pi.on('before_agent_start', event => ({ systemPrompt: config.transformSystemPrompt!(event.systemPrompt) }))
    }
  }
  const encodingTools: ExtensionFactory = pi => {
    const selected = sessionToolOptions(config.toolPolicy, config.disableTools).tools ?? []
    for (const tool of encodingToolDefinitions(config.workspaceDir)) {
      if (selected.includes(tool.name)) pi.registerTool(tool)
    }
  }
  const mediaNames = registeredMediaNames(config)
  const videoNames = registeredVideoNames(config)
  const videoExtension: ExtensionFactory = pi => {
    for (const tool of videoToolDefinitions(config, videoNames)) pi.registerTool(tool)
    pi.on('tool_result', event => {
      if (!videoNames.includes(event.toolName as VideoToolName)) return
      if (event.details && typeof event.details === 'object' && 'isError' in event.details && event.details.isError === true) {
        return { isError: true }
      }
    })
  }
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
    let activeRequest: { requestId: number; startedAt: number; platformRequestId?: string; providerStatus?: number } | undefined
    let latestInputSequence = 0
    log.trace('provider payload hook registered')
    pi.on('turn_start', () => { activeRequest = undefined })
    pi.on('before_provider_request', (event: BeforeProviderRequestEvent) => {
      const requestId = ++gatewayRequestSequence
      activeRequest = { requestId, startedAt: Date.now() }
      try {
        const context = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
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
        const content = redactKnowledgeContextForLog(gatewayContent(response.content))
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
        outputBudgetSource: 'platform',
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
          content: redactKnowledgeContextForLog([text, toolSummary].filter(Boolean).join('\n\n')) || '（本轮没有正文输出）',
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
      if (toolName.startsWith('video_')) {
        if (registeredVideoNames(config).includes(toolName as VideoToolName) && pi.getActiveTools().includes(toolName)) {
          return { block: false }
        }
        await config.reportPolicyEvent?.('unknown_tool_blocked', { toolName, reason: 'Video tool is not enabled for this run.' })
        return { block: true, reason: `Unknown tool: ${toolName} - default deny` }
      }
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

  return [...(config.transformSystemPrompt ? [systemPromptTransform] : []), gatewayPayload, encodingTools, ...(mcp.tools.length ? [mcpExtension] : []), ...(mediaNames.length ? [mediaExtension] : []), ...(videoNames.length ? [videoExtension] : []), toolGuard]
}

class PiCodingAgentSession implements PiAgentSession {
  private readonly listeners = new Set<(event: PiAgentEvent) => void>()
  private readonly unsubscribe: () => void
  private settledResponse: { text: string; stopReason?: string } = { text: '' }

  constructor(
    private readonly session: Awaited<ReturnType<typeof createAgentSession>>['session'],
    private readonly mcp: McpRuntime,
    private readonly retryWait: GatewayRetryWait,
    private readonly settingsManager: SettingsManager,
    private readonly requestTracker: ModelRequestTracker | null,
  ) {
    this.unsubscribe = session.subscribe(event => {
      if (event.type === 'turn_start') this.settledResponse = { text: '' }
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        this.settledResponse = {
          text: event.message.content.filter(part => part.type === 'text').map(part => part.text).join(''),
          stopReason: event.message.stopReason,
        }
      }
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

  getSettledResponse(): { text: string; stopReason?: string } {
    return { ...this.settledResponse }
  }

  async prompt(text: string): Promise<void> {
    this.settledResponse = { text: '' }
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
        const systemPrompt = config.transformSystemPrompt && context.systemPrompt
          ? config.transformSystemPrompt(context.systemPrompt) : context.systemPrompt
        const requestContext = {
          ...context,
          systemPrompt: config.modelRequestAwareness !== false && snapshot && snapshot.kind !== 'compaction'
            ? [systemPrompt, buildModelRequestAwareness(snapshot.progress, snapshot.kind)].filter(Boolean).join('\n\n')
            : systemPrompt,
        }
        return streamSimple({ ...model, api: 'openai-completions' }, requestContext, {
          ...options,
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
        contextWindow: GATEWAY_CONTEXT_WINDOW,
        // Pi requires positive numeric metadata. This is not a provider output budget:
        // normalizeGatewayPayload removes all output limits before sending to the gateway.
        maxTokens: GATEWAY_CONTEXT_WINDOW,
      }],
    })
    const model = modelRuntime.getModel('sep-gateway', config.modelId)
    if (!model) throw new Error('Failed to resolve task model.')

    // Execution-disabled/planner policies must not gain external tools or spawn MCP servers.
    const canUseMcp = !config.disableTools && (!config.toolPolicy || config.toolPolicy.allowedTools.length > 0 || isUnrestrictedToolPolicy(config.toolPolicy))
    const servers = canUseMcp ? config.mcpServers ?? await loadHostMcpServers() : []
    const mcp = await createMcpRuntime(servers, config.workspaceDir)
    try {
      const employeePrompt = !config.useNativeSystemPrompt && config.employeeProfile ? buildEmployeeSystemPrompt(config.employeeProfile) : undefined
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
        // Native mode also bypasses discovered SYSTEM.md overrides; employee chats keep literal overrides.
        systemPromptOverride: config.useNativeSystemPrompt ? () => undefined
          : config.systemPrompt === undefined ? undefined : () => config.systemPrompt,
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
        ...sessionToolOptions(config.toolPolicy, config.disableTools, [...mcp.permissions.keys()], registeredMediaNames(config), registeredVideoNames(config)),
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


