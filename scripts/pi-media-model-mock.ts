import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { mediaCapabilitiesSchema, mediaGenerationInputSchema, mediaId } from '../electron/common/platform/media-contract'

// Opt-in integration fixture only. This module performs no I/O or tool execution:
// the caller must feed the real host's tool results back through the Pi transcript.
const toolNames = ['read', 'media_get_capabilities', 'media_generate_image', 'media_get_job'] as const
type ToolName = typeof toolNames[number]
type Scenario = 'SYNC' | 'ASYNC' | 'DENY' | 'GENERATE' | 'PARTIAL'
type RecordValue = Record<string, unknown>
type Message = RecordValue & { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null }
type Call = { name: ToolName; input: RecordValue }
type Capabilities = ReturnType<typeof mediaCapabilitiesSchema.parse>

export interface PiMediaModelMockOptions {
  approvedSkillPath: string
}

export interface PiMediaModelMockAudit {
  requests: number
  steps: Record<ToolName | 'final' | 'businessError', number>
  skillReadVerified: boolean
  generationCount: number
}

function fail(code: string): never {
  // Never interpolate request data, paths, tool output or parser diagnostics.
  throw new Error(`Pi media model mock: ${code}`)
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return fail('INVALID_TOOL_RESULT') }
}

function businessError(value: unknown): boolean {
  if (!record(value)) return false
  return value.ok === false || value.isError === true
    || (record(value.details) && value.details.isError === true)
    || (value.error !== undefined && value.error !== null)
    || ['FAILED', 'CANCELLED', 'RESULT_EXPIRED', 'SUBMISSION_UNKNOWN'].includes(String(value.generationStatus))
    || value.trackingStatus === 'AUTH_REQUIRED'
}

function messagesFrom(body: unknown): { model: string; messages: Message[]; advertised: Set<string> } {
  if (!record(body) || typeof body.model !== 'string' || !body.model.trim()
    || !Array.isArray(body.messages) || !body.messages.length || !Array.isArray(body.tools)
    || (body.stream !== undefined && body.stream !== true)) fail('INVALID_BODY')
  const messages: Message[] = body.messages.map((value: unknown) => {
    if (!record(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role))
      || (typeof value.content !== 'string' && value.content !== null)) fail('INVALID_BODY')
    return value as Message
  })
  const advertised = new Set<string>()
  for (const tool of body.tools) {
    if (!record(tool) || tool.type !== 'function' || !record(tool.function)
      || typeof tool.function.name !== 'string' || advertised.has(tool.function.name)) fail('INVALID_BODY')
    advertised.add(tool.function.name)
  }
  return { model: body.model, messages, advertised }
}

function generation(capabilities: Capabilities, references: unknown[], scenario: Scenario): RecordValue {
  const profileId = scenario === 'ASYNC' ? 'mock-async' : 'mock-sync'
  const profile = capabilities.profiles.find(candidate => candidate.profileId === profileId)
  const operation = scenario === 'SYNC' ? 'edit' : 'generate'
  const count = scenario === 'PARTIAL' ? 2 : 1
  if (!profile || profile.executionMode !== (scenario === 'ASYNC' ? 'async-query' : 'sync-response')
    || !profile.operations.includes(operation)
    || profile.maxCount === undefined || profile.maxCount < count
    || (operation === 'edit' && !profile.capabilities.referenceImage)
    || !toolNames.slice(1).every(name => capabilities.tools.some(tool => tool === name))) fail('CAPABILITIES_UNAVAILABLE')
  const localAssetIds: string[] = []
  if (operation === 'edit') {
    const first = references[0]
    const id = mediaId.safeParse(record(first) ? first.localAssetId : undefined)
    if (!id.success) fail('REFERENCE_REQUIRED')
    localAssetIds.push(id.data)
  }
  const input = mediaGenerationInputSchema.safeParse({
    profileId: profile.profileId, operation, localAssetIds,
    creativeBrief: operation === 'edit' ? 'Deterministic ecommerce mock reference edit.' : 'Deterministic ecommerce mock image.',
    parameters: {
      aspectRatio: profile.allowedAspectRatios[0], count,
      ...(profile.allowedSizes?.[0] ? { size: profile.allowedSizes[0] } : {}),
      ...(profile.allowedQualities?.[0] ? { quality: profile.allowedQualities[0] } : {}),
    },
  })
  if (!input.success) fail('CAPABILITIES_UNAVAILABLE')
  return input.data
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function response(model: string, id: string, delta: RecordValue, finish: 'tool_calls' | 'stop'): Response {
  const chunks = [[delta, null], [{}, finish]].map(([current, reason]) => `data: ${JSON.stringify({
    id: `response-${id}`, object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: current, finish_reason: reason }],
  })}\n\n`)
  return new Response(`${chunks.join('')}data: [DONE]\n\n`, {
    status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
  })
}

/** One instance per integration run; audit snapshots contain only counts/flags. */
export class PiMediaModelMock {
  private readonly approvedSkillPath: string
  private readonly counted = new Set<string>()
  private readonly counters: PiMediaModelMockAudit = {
    requests: 0, steps: { read: 0, media_get_capabilities: 0, media_generate_image: 0, media_get_job: 0, final: 0, businessError: 0 },
    skillReadVerified: false, generationCount: 0,
  }

  constructor(options: PiMediaModelMockOptions) {
    if (!record(options) || typeof options.approvedSkillPath !== 'string'
      || !isAbsolute(options.approvedSkillPath) || basename(options.approvedSkillPath) !== 'SKILL.md'
      || /[\r\n\0]/.test(options.approvedSkillPath)) fail('INVALID_APPROVED_SKILL')
    this.approvedSkillPath = options.approvedSkillPath
  }

  get audit(): PiMediaModelMockAudit {
    return { ...this.counters, steps: { ...this.counters.steps } }
  }

  respond(body: unknown): Response {
    this.counters.requests++
    const { model, messages, advertised } = messagesFrom(body)
    let userIndex = messages.length - 1
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex--
    if (userIndex < 0) fail('UNKNOWN_PROMPT')
    const prompt = messages[userIndex].content ?? ''
    const scenarios = (['SYNC', 'ASYNC', 'DENY', 'GENERATE', 'PARTIAL'] as const).filter(value => prompt.includes(`[SEP_PI_MEDIA_MOCK_${value}]`))
    if (scenarios.length !== 1) fail('UNKNOWN_PROMPT')
    const scenario = scenarios[0]
    // Require a skill name outside the path and boundaries around the entire path.
    const approved = messages.slice(0, userIndex).some(message => {
      if (message.role !== 'system' || !message.content) return false
      const parts = message.content.split(this.approvedSkillPath)
      if (!/(?:^|[\s<>"'`])ecommerce-image-mock(?=$|[\s<>"'`])/.test(parts.join(''))) return false
      return parts.some((suffix, index) => index > 0
        && (parts[index - 1].length === 0 || /[\s<>"'`]$/.test(parts[index - 1]))
        && (suffix.length === 0 || /^[\s<>"'`]/.test(suffix)))
    })
    if (!approved) fail('APPROVED_SKILL_MISSING')
    if (!toolNames.every(name => advertised.has(name))) fail('TOOL_NOT_ADVERTISED')

    let stage = 0
    let capabilities: Capabilities | undefined
    let references: unknown[] = []
    let jobId: string | undefined
    let failed = false
    let verified = false
    let finalSeen = false
    const ids = new Set<string>()
    const next = (): Call => {
      if (stage === 0) return { name: 'read', input: { path: this.approvedSkillPath } }
      if (stage === 1) return { name: 'media_get_capabilities', input: {} }
      if (stage === 2 && capabilities) return { name: 'media_generate_image', input: generation(capabilities, references, scenario) }
      if (stage === 3 && jobId) return { name: 'media_get_job', input: { jobId } }
      return fail('INVALID_TOOL_HISTORY')
    }
    const current = messages.slice(userIndex + 1)
    for (let index = 0; index < current.length; index += 2) {
      const assistant = current[index]
      if (assistant.role !== 'assistant') fail('INVALID_TOOL_HISTORY')
      if (assistant.tool_calls === undefined || (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 0)) {
        if ((!failed && stage !== 4) || index !== current.length - 1 || !assistant.content) fail('INVALID_TOOL_HISTORY')
        finalSeen = true
        break
      }
      if (failed || stage === 4 || !Array.isArray(assistant.tool_calls) || assistant.tool_calls.length !== 1) fail('INVALID_TOOL_HISTORY')
      const call: unknown = assistant.tool_calls[0]
      const result = current[index + 1]
      const expected = next()
      if (!record(call) || typeof call.id !== 'string' || !call.id || ids.has(call.id)
        || call.type !== 'function' || !record(call.function) || call.function.name !== expected.name
        || typeof call.function.arguments !== 'string'
        || !isDeepStrictEqual(json(call.function.arguments), expected.input)
        || result?.role !== 'tool' || result.tool_call_id !== call.id || typeof result.content !== 'string'
        || (result.name !== undefined && result.name !== expected.name)) fail('INVALID_TOOL_HISTORY')
      ids.add(call.id)
      let value: unknown
      if (expected.name === 'read') {
        // A read is text, but a JSON business-error envelope is still a failure.
        try { value = JSON.parse(result.content) as unknown } catch { value = result.content }
      } else {
        value = json(result.content)
      }
      if (businessError(value)) {
        failed = true
        continue
      }
      if (expected.name === 'read') {
        if (!/\bSEP_ECOMMERCE_IMAGE_MOCK_V1\b/.test(result.content)) fail('SKILL_READ_UNVERIFIED')
        verified = true
      } else if (expected.name === 'media_get_capabilities') {
        if (!record(value)) fail('INVALID_TOOL_RESULT')
        const parsed = mediaCapabilitiesSchema.safeParse(value.capabilities)
        if (!parsed.success || !Array.isArray(value.referenceAssets)) fail('INVALID_TOOL_RESULT')
        capabilities = parsed.data
        references = value.referenceAssets
      } else if (expected.name === 'media_generate_image') {
        if (scenario === 'DENY') fail('DENIAL_NOT_OBSERVED')
        const parsed = mediaId.safeParse(record(value) ? value.jobId : undefined)
        if (!parsed.success) fail('INVALID_TOOL_RESULT')
        jobId = parsed.data
        if (record(value) && ((value.profileId !== undefined && value.profileId !== expected.input.profileId)
          || (value.operation !== undefined && value.operation !== expected.input.operation))) fail('INVALID_TOOL_RESULT')
      } else if (!record(value) || value.jobId !== jobId) {
        fail('INVALID_TOOL_RESULT')
      }
      stage++
    }
    this.counters.skillReadVerified ||= verified
    const turn = digest(messages.slice(0, userIndex + 1))
    // Only fingerprints are retained, never prompts or complete request bodies.
    // Replayed fetches yield the same call ID and do not inflate operation counts.
    const count = (step: keyof PiMediaModelMockAudit['steps']): void => {
      const key = `${turn}:${step}`
      if (this.counted.has(key)) return
      this.counted.add(key)
      this.counters.steps[step]++
      if (step === 'media_generate_image') this.counters.generationCount++
    }
    if (failed || stage === 4 || finalSeen) {
      if (failed) count('businessError')
      count('final')
      const content = failed ? '媒体工具返回业务错误或拒绝，已终止本轮，未重试。'
        : scenario === 'SYNC' ? '本地 mock 图片编辑请求已提交，并已查询任务状态。'
          : scenario === 'GENERATE' || scenario === 'PARTIAL' ? '本地 mock 图片生成请求已提交，并已查询任务状态。'
          : '本地 mock 异步图片请求已提交，并已查询任务状态。'
      return response(model, `${turn.slice(0, 20)}-final`, { role: 'assistant', content }, 'stop')
    }
    const call = next()
    count(call.name)
    const id = `sep-pi-media-${turn.slice(0, 20)}-${stage}`
    return response(model, id, { role: 'assistant', tool_calls: [{
      index: 0, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) },
    }] }, 'tool_calls')
  }
}

export function createPiMediaModelMock(options: PiMediaModelMockOptions): PiMediaModelMock {
  return new PiMediaModelMock(options)
}
