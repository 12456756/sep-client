import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { lazyStream, type AssistantMessage, type AssistantMessageEvent, type SimpleStreamOptions, type StreamFunction } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createBashToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
  defineTool,
  getShellConfig,
  loadSkills,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type Skill,
  type BashOperations,
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
import { redactModelTraceText, redactText, redactValue } from '../../common/redact'
import {
  BUILTIN_TOOL_NAMES,
  READ_ONLY_TOOLS,
  buildBearerAuthorizationHeader,
  evaluateToolCall,
  isUnrestrictedToolPolicy,
  requiresToolApproval,
} from '../../../pi-extension'
import { logger } from '../../common/logger'
import { createMcpRuntime, type McpRuntime } from './pi-mcp-client'
import { loadHostMcpServers, PLAYWRIGHT_GUIDELINES } from './pi-playwright-mcp'
import { buildEmployeeSystemPrompt } from './employee-system-prompt'
import { GatewayRetryWait } from './gateway-retry-wait'
import { buildModelRequestAwareness, ModelRequestTracker, type ModelRequestSnapshot } from './model-request-tracker'
import { employeeSkillLoaderOptions } from './employee-skill-loader'
import { encodingToolDefinitions } from './pi-text-tools'
import { videoErrorMessage } from '../../../src/shared/video-errors'
import { prepareCommonSkills, type CommonSkillsResult } from './common-skills'
import { attachOfficeRuntime, officeTaskPolicy } from './pi-office-runtime'
import { modelPayloadText, readableTraceValue, traceModelStream } from './pi-model-trace'
import { fetchWithModelDiagnostics } from './model-transport-diagnostics'
import { evaluateOfficeCommand, OFFICE_TOOL_NAME } from './pi-office-policy'

const log = logger.child('pi-gateway')

export type PiSkill = Skill
export type PiAssistantMessage = AssistantMessage
export type PiAssistantMessageEvent = AssistantMessageEvent
export type PiBashOperations = BashOperations
export type PiToolDefinition = ToolDefinition
export type PiEncodingToolSdk = Pick<typeof import('@earendil-works/pi-coding-agent'),
  'createBashToolDefinition' | 'createGrepToolDefinition' | 'createReadToolDefinition' | 'defineTool' | 'getShellConfig'>
export type PiLoadSkills = typeof loadSkills
export type PiResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

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
  error: z.string().max(8192).nullable().transform(value => value === null ? null : videoErrorMessage(value) ? value : 'Video job reported an error.'),
  createdAt: z.number().nonnegative().finite(), updatedAt: z.number().nonnegative().finite(),
  outputs: z.array(videoOutputSchema.strip()).max(4),
  artifacts: z.array(z.object({
    artifactId: z.string().regex(/^vout_[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    status: z.enum(['pending', 'saving', 'saved', 'save-failed', 'missing', 'expired']),
  })).max(4).optional(),
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
        ? 'Read cached task-local video status by jobId, or call with {} to list VIDEO profiles, specifications, jobs and referenceAssets. The host tracks and saves submitted jobs. Never poll this tool or use sleep to wait; end the turn after submission. Image capabilities do not describe video availability.'
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
            ...(diagnostic.requestId === undefined ? {} : { requestId: diagnostic.requestId }),
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
    const parsed = z.object({ ok: z.literal(false), error: z.object({
      code: z.string(), message: z.string(),
      businessCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).optional(),
      field: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/).optional(),
      stage: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
      recovery: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
    }) }).safeParse(result)
    if (parsed.success) return { value: mediaToolFailure(parsed.data.error.code, parsed.data.error.message, parsed.data.error), isError: true }
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
    media_get_job: 'Read cached status and task-local assets of an image job. The host tracks and saves submitted jobs. Never poll this tool or use sleep to wait; end the turn after submission.',
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

export function normalizeEvent(event: AgentSessionEvent): PiAgentEvent | null {
  const raw = event as unknown as Record<string, unknown>
  switch (event.type) {
    case 'message_update': {
      const update = raw.assistantMessageEvent as Record<string, unknown> | undefined
      if ((update?.type !== 'text_delta' && update?.type !== 'thinking_delta') || typeof update.delta !== 'string') return null
      return { type: update.type, data: { text: update.type === 'thinking_delta' ? redactModelTraceText(update.delta) : redactText(update.delta) } }
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
    for (const tool of encodingToolDefinitions(config.workspaceDir, {
      createBashToolDefinition, createGrepToolDefinition, createReadToolDefinition, defineTool, getShellConfig,
    })) {
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
    // Request bodies and timings are observed at the provider boundary, including compaction.
    pi.on('message_end', event => {
      const response = event.message
      if (response.role !== 'assistant') return
      const calls = response.content.filter(part => part.type === 'toolCall')
      if (calls.length === 0) return
      const availableTools = pi.getActiveTools()
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
      if (toolName === OFFICE_TOOL_NAME && mcp.builtinOffice) {
        const decision = evaluateOfficeCommand(event.input, officeTaskPolicy(config))
        if (!decision.allowed) {
          await config.reportPolicyEvent?.('tool_call_blocked', { toolName, reason: decision.reason })
          return { block: true, reason: decision.reason ?? 'Office command denied.' }
        }
        if (!decision.requiresApproval) return { block: false }
        const approved = await config.authorizeTool({ toolName, input: redactValue({ command: decision.args }) })
        return { block: !approved, ...(approved ? {} : { reason: 'User denied Office document modification.' }) }
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
    private readonly flushTrace: () => Promise<void> = async () => {},
    private readonly diagnostics?: {
      current: () => PiAgentSessionConfig
      update: (config: Pick<PiAgentSessionConfig, 'runId' | 'taskTitle' | 'tracePhase' | 'nodeTitle' | 'modelTrace'>) => void
      purpose: (purpose: string) => void
      observe: (event: AgentSessionEvent) => void
      startPrompt: () => void
    },
  ) {
    const toolStarts = new Map<string, number>()
    const operationStarts = new Map<string, number>()
    this.unsubscribe = session.subscribe(event => {
      this.diagnostics?.observe(event)
      if (event.type === 'auto_retry_end' && event.success === true) retryWait.reset()
      const delayMs = event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled'
        ? retryWait.schedule() : undefined
      const config = this.diagnostics?.current()
      if (config && (event.type === 'tool_execution_start' || event.type === 'tool_execution_end')) {
        const started = event.type === 'tool_execution_start'
        if (started) toolStarts.set(event.toolCallId, Date.now())
        const elapsedMs = started ? undefined : toolStarts.has(event.toolCallId) ? Date.now() - toolStarts.get(event.toolCallId)! : undefined
        const fields = { taskTitle: config.taskTitle, nodeTitle: config.nodeTitle, toolName: event.toolName, elapsedMs,
          ...(!started ? { success: !event.isError } : {}) }
        log.info(started ? 'tool execution started' : 'tool execution completed', fields)
        void config.modelTrace?.({ phase: '', kind: 'tool', text: `${started ? '工具开始' : '工具结束'}\n${readableTraceValue({ ...fields, ...event })}` }).catch(() => undefined)
        if (!started) toolStarts.delete(event.toolCallId)
      }
      if (config && /^(auto_retry_|compaction_|summarization_retry_scheduled)/.test(event.type)) {
        const operation = event.type.replace(/_(start|end)$/, '')
        if (event.type.endsWith('_start')) operationStarts.set(operation, Date.now())
        const elapsedMs = event.type.endsWith('_end') && operationStarts.has(operation) ? Date.now() - operationStarts.get(operation)! : undefined
        log.info(event.type, { taskTitle: config.taskTitle, nodeTitle: config.nodeTitle, elapsedMs, delayMs })
        void config.modelTrace?.({ phase: '', kind: 'status', text: `${event.type}\n${readableTraceValue({ ...event, ...(delayMs === undefined ? {} : { delayMs }) })}${elapsedMs === undefined ? '' : `\n耗时 ${elapsedMs} 毫秒`}` }).catch(() => undefined)
        if (event.type.endsWith('_end')) operationStarts.delete(operation)
      }
      if (event.type === 'turn_start') this.settledResponse = { text: '' }
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        this.settledResponse = {
          text: event.message.content.filter(part => part.type === 'text').map(part => part.text).join(''),
          stopReason: event.message.stopReason,
        }
      }
      this.requestTracker?.observe(event)
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

  setDiagnostics(config: Pick<PiAgentSessionConfig, 'runId' | 'taskTitle' | 'tracePhase' | 'nodeTitle' | 'modelTrace'>): void {
    this.diagnostics?.update(config)
  }

  setRequestPurpose(purpose: string): void { this.diagnostics?.purpose(purpose) }

  get sessionFile(): string | null {
    return this.session.sessionFile ?? null
  }

  getSettledResponse(): { text: string; stopReason?: string } {
    return { ...this.settledResponse }
  }

  async prompt(text: string, options?: { images?: readonly { type: 'image'; data: string; mimeType: string }[] }): Promise<void> {
    this.diagnostics?.startPrompt()
    this.settledResponse = { text: '' }
    this.requestTracker?.startPrompt()
    this.retryWait.reset()
    this.settingsManager.setRetryEnabled(true)
    await this.session.prompt(text, options?.images?.length ? {
      images: options.images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
    } : undefined)
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
      await this.flushTrace()
    }
  }
}

export class PiCodingAgentAdapter implements PiAgentRuntime {
  async createSession(config: PiAgentSessionConfig): Promise<PiAgentSession> {
    const pendingTraces = new Set<Promise<void>>()
    let originalRecorder = config.modelTrace
    let traceFailureReported = false
    const record: NonNullable<PiAgentSessionConfig['modelTrace']> = entry => {
      const destination = originalRecorder
      if (!destination) return Promise.resolve()
      const phase = entry.phase || config.tracePhase || '模型执行'
      const pending = Promise.resolve().then(() => destination({ ...entry, phase })).catch(() => {
        if (!traceFailureReported) {
          traceFailureReported = true
          log.warn('model trace write failed', { taskTitle: config.taskTitle, reason: '日志采集失败；业务任务继续运行' })
        }
      })
      pendingTraces.add(pending)
      void pending.finally(() => pendingTraces.delete(pending))
      return pending
    }
    config = { ...config, modelTrace: originalRecorder ? record : undefined }
    let requestNumber = 0
    const traceSessionId = randomUUID()
    let requestsInPrompt = 0
    let requestPurpose = config.resumeSessionFile ? '恢复执行' : '首次执行'
    let observedKind = 'execution'
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
        const number = ++requestNumber
        const purpose = requestsInPrompt++ === 0 ? requestPurpose : '工具执行后续轮'
        const requestKind = snapshot?.kind ?? observedKind
        const requestId = `${config.runId}-${traceSessionId}-${number}`
        let startedAt = Date.now()
        let headersMs: number | undefined
        let platformRequestId: string | undefined
        let providerStatus: number | undefined
        let sent = false
        let overview: Record<string, unknown> = {}
        const fields = { runId: config.runId, taskTitle: config.taskTitle, nodeTitle: config.nodeTitle, phase: config.tracePhase, requestNumber: number, model: config.modelId }
        const requestRecord: typeof record = entry => record({ ...entry, requestId, requestNumber: number })
        void requestRecord({ phase: '', kind: 'status', text: `第 ${number} 次请求；用途：${purpose}；类型：${requestKind}；运行标识：${config.runId}`, metrics: { 模型: config.modelId, 请求用途: purpose, 请求类型: requestKind } })
        const source = streamSimple({ ...model, api: 'openai-completions' }, requestContext, {
          ...options,
          maxRetries: 0,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(payload, requestModel)
            // Standalone summaries omit the Agent hooks; normalize once after any caller hook.
            const normalized = normalizeGatewayPayload(replacement === undefined ? payload : replacement)
            overview = buildGatewayRequestLogFields(normalized && typeof normalized === 'object' ? normalized as Record<string, unknown> : {}, number)
            void requestRecord({ phase: '', kind: 'input', text: modelPayloadText(normalized) })
            return normalized
          },
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            headers.set('authorization', buildBearerAuthorizationHeader(await config.getAccessToken()))
            startedAt = Date.now()
            sent = true
            log.info('model request overview', { ...overview, ...fields, requestId: number, traceRequestId: requestId })
            void requestRecord({ phase: '', kind: 'status', text: '请求已发送，等待模型响应。', timestamp: startedAt, metrics: { 请求发送时间: new Date(startedAt).toISOString() } })
            const response = await fetchWithModelDiagnostics(input, { ...init, headers }, failure => {
              const { causes, ...diagnostic } = failure
              const cause = causes[0]
              const details = { ...diagnostic, causeName: cause?.name, causeCode: cause?.code, causeMessage: cause?.message }
              log[failure.signalAborted ? 'info' : 'warn']('model transport interrupted', { ...fields, ...details, traceRequestId: requestId, causes })
              return requestRecord({ phase: '', kind: 'status', text: '模型传输中断；以下为 SDK 格式化之前采集的底层诊断。',
                metrics: {
                  传输阶段: failure.transportPhase === 'connect' ? '连接建立' : '响应流读取',
                  错误类型: failure.errorName, 错误信息: failure.errorMessage, 错误代码: failure.errorCode,
                  底层错误类型: cause?.name, 底层错误码: cause?.code, 底层原因: cause?.message,
                  原因链: JSON.stringify(causes), 平台请求标识: failure.platformRequestId, 响应状态码: failure.providerStatus,
                  已接收字节数: failure.bytesReceived, 总耗时毫秒: failure.elapsedMs,
                  网络首字节毫秒: failure.firstByteMs, 距离最后收包毫秒: failure.lastDataAgeMs,
                  是否主动取消: failure.signalAborted ? '是' : '否',
                } })
            })
            headersMs = Date.now() - startedAt
            platformRequestId = response.headers.get('x-request-id') ?? undefined
            providerStatus = response.status
            void requestRecord({ phase: '', kind: 'status', text: `收到响应头；状态码 ${providerStatus}`, metrics: { 响应头耗时毫秒: headersMs, 平台请求标识: platformRequestId, 响应状态码: providerStatus } })
            if (!retryWait.inspect(response)) settingsManager.setRetryEnabled(false)
            return response
          },
        })
        return traceModelStream(source, requestRecord, async (response, timings) => {
          const elapsedMs = Date.now() - startedAt
          const usage = { input: response.usage.input, output: response.usage.output, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, total: response.usage.totalTokens }
          log.info('model response completed', { ...fields, requestId: number, traceRequestId: requestId, platformRequestId, providerStatus, elapsedMs, ...timings,
            stopReason: response.stopReason, usage, outputBudgetSource: 'platform',
            contentLength: response.content.filter(part => part.type === 'text').map(part => part.text).join('\n').length,
            toolCount: response.content.filter(part => part.type === 'toolCall').length, ...buildGatewayThinkingLogFields(response.content) })
          await requestRecord({ phase: '', kind: 'status', completed: true,
            text: `响应结束；结束原因：${response.stopReason}${response.errorMessage ? `；错误：${response.errorMessage}` : ''}；耗时 ${elapsedMs} 毫秒`,
            metrics: { 总耗时毫秒: elapsedMs, 首个SDK流事件毫秒: timings.firstEventMs, 首次思考毫秒: timings.firstThinkingMs, 首次正文毫秒: timings.firstTextMs,
              响应结束时间: new Date().toISOString(), 发送状态: sent ? '已发送' : '未发送',
              响应头耗时毫秒: headersMs, 平台请求标识: platformRequestId, 响应状态码: providerStatus, 结束原因: response.stopReason,
              输入Token: usage.input, 输出Token: usage.output, 缓存读取Token: usage.cacheRead, 缓存写入Token: usage.cacheWrite, 总Token: usage.total } })
        }, () => startedAt, timings => {
          log.info('model stream progress', { ...fields, ...timings })
          void requestRecord({ phase: '', kind: 'status', text: '模型流式响应进度（首个 SDK 事件不等同于网络首字节）',
            metrics: { 首个SDK流事件毫秒: timings.firstEventMs, 首次思考毫秒: timings.firstThinkingMs, 首次正文毫秒: timings.firstTextMs } })
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
    const common: CommonSkillsResult = !config.disableSkills && config.employeeProfile && canUseMcp && config.mcpServers === undefined && !process.env.SEP_MCP_CONFIG
      ? prepareCommonSkills() : { skills: [], unavailable: [] }
    if (common.skills.length && config.resumeSessionFile) {
      try {
        const saved: unknown = JSON.parse(await readFile(join(config.agentDir, 'common-skill-snapshot.json'), 'utf8'))
        const expected = common.skills.map(({ id, version, sha256 }) => ({ id, version, sha256 }))
        if (JSON.stringify(saved) !== JSON.stringify(expected)) {
          common.skills = []; common.office = undefined
          common.unavailable.push('The resumed session requires a different common skill version; Office was not silently upgraded.')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          common.skills = []; common.office = undefined
          common.unavailable.push('The common skill recovery snapshot is unreadable; Office was not silently replaced.')
        }
      }
    }
    for (const reason of common.unavailable) {
      log.warn('common skill unavailable', { skillId: 'officecli', reason })
      await config.reportPolicyEvent?.('common_skill_unavailable', { skillId: 'officecli', reason })
    }
    const baseMcp = await createMcpRuntime(servers, config.workspaceDir)
    const attached = await attachOfficeRuntime(baseMcp, common, config).catch(async error => {
      await baseMcp.dispose()
      throw error
    })
    const mcp = attached.runtime
    if (common.office && !attached.enabled) common.unavailable.push('Office MCP startup failed.')
    const commonPaths = attached.enabled ? common.skills.map(skill => skill.path) : []
    if (commonPaths.length && config.toolPolicy) config = { ...config, toolPolicy: {
      ...config.toolPolicy, approvedSkillPaths: [...(config.toolPolicy.approvedSkillPaths ?? []),
        ...commonPaths.map(path => ({ entryPath: join(path, 'SKILL.md') }))],
    } }
    try {
      const employeePrompt = !config.useNativeSystemPrompt && config.employeeProfile ? buildEmployeeSystemPrompt(config.employeeProfile) : undefined
      const resourceLoader = new DefaultResourceLoader({
        cwd: config.workspaceDir,
        agentDir: config.agentDir,
        extensionFactories: buildExtensions(config, mcp),
        ...(config.disableSkills ? { noSkills: true, skillsOverride: () => ({ skills: [], diagnostics: [] }) } : employeeSkillLoaderOptions(
          config.workspaceDir,
          config.agentDir,
          config.employeeProfile ? config.additionalSkillPaths ?? [] : undefined,
          loadSkills,
          commonPaths,
        )),
        noContextFiles: true,
        additionalSkillPaths: config.disableSkills ? [] : [...(config.additionalSkillPaths ?? []), ...commonPaths],
        // Native mode also bypasses discovered SYSTEM.md overrides; employee chats keep literal overrides.
        systemPromptOverride: config.useNativeSystemPrompt ? () => undefined
          : config.systemPrompt === undefined ? undefined : () => config.systemPrompt,
        appendSystemPromptOverride: employeePrompt || config.fixedSystemPrompt || common.unavailable.length
          ? base => [...base, ...(employeePrompt ? [employeePrompt] : []), ...(config.fixedSystemPrompt ? [config.fixedSystemPrompt] : []),
            ...(common.unavailable.length ? ['The built-in Office capability is unavailable for this session. Do not claim it was used or install another executable.'] : [])]
          : undefined,
      })
      await resourceLoader.reload()
      if (commonPaths.length) {
        await writeFile(join(config.agentDir, 'common-skill-snapshot.json'), JSON.stringify(
          common.skills.map(({ id, version, sha256 }) => ({ id, version, sha256 }))), 'utf8')
      }
      if (config.employeeProfile) {
        await writeFile(join(config.agentDir, 'skill-runtime-names.json'), JSON.stringify(
          resourceLoader.getSkills().skills.map(skill => ({ runtimeName: skill.name, path: skill.filePath,
            source: commonPaths.includes(skill.baseDir) ? 'common' : 'employee' }))), 'utf8')
      }
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
      return new PiCodingAgentSession(session, mcp, retryWait, settingsManager, requestTracker, async () => { await Promise.all([...pendingTraces]) }, {
        current: () => config,
        update: next => { originalRecorder = next.modelTrace; config = { ...config, ...next, modelTrace: next.modelTrace ? record : undefined } },
        purpose: value => { requestPurpose = value },
        startPrompt: () => { requestsInPrompt = 0; observedKind = 'execution' },
        observe: event => {
          if (event.type === 'compaction_start') observedKind = 'compaction'
          else if (event.type === 'auto_retry_start') observedKind = 'retry'
          else if (event.type === 'compaction_end' || event.type === 'auto_retry_end') observedKind = 'execution'
        },
      })
    } catch (error) {
      await mcp.dispose()
      throw error
    }
  }
}


