import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { videoGenerationInputSchema, type VideoGenerationInput } from '../src/shared/video-host'

/** Explicit isolated harness fixture: no fetch, filesystem access or tool execution. */
export const PI_VIDEO_MODEL_MOCK_PROMPT = '[SEP_PI_VIDEO_MOCK]'
type RecordValue = Record<string, unknown>
type ToolName = 'video_from_image' | 'video_get_job'

export interface PiVideoModelMockOptions {
  generationInput: VideoGenerationInput
}

export interface PiVideoModelMockAudit {
  requests: number
  steps: Record<ToolName | 'final' | 'businessError', number>
  generationCount: number
}

function fail(code: string): never {
  throw new Error(`Pi video model mock: ${code}`)
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return fail('INVALID_TOOL_HISTORY') }
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

function failed(value: unknown): boolean {
  return record(value) && (value.ok === false || value.isError === true
    || record(value.details) && value.details.isError === true || value.error != null
    || ['FAILED', 'CANCELLED', 'RESULT_EXPIRED', 'SUBMISSION_UNKNOWN'].includes(String(value.generationStatus))
    || value.trackingStatus === 'AUTH_REQUIRED')
}

/** One instance per run. Replay-safe counters retain fingerprints, never transcripts. */
export class PiVideoModelMock {
  private readonly input: VideoGenerationInput
  private readonly counted = new Set<string>()
  private readonly counters: PiVideoModelMockAudit = {
    requests: 0, steps: { video_from_image: 0, video_get_job: 0, final: 0, businessError: 0 }, generationCount: 0,
  }

  constructor(options: PiVideoModelMockOptions) {
    const input = videoGenerationInputSchema.safeParse(options?.generationInput)
    if (!input.success || input.data.operation !== 'image-to-video') fail('INVALID_GENERATION_INPUT')
    this.input = input.data
  }

  get audit(): PiVideoModelMockAudit {
    return { ...this.counters, steps: { ...this.counters.steps } }
  }

  respond(body: unknown): Response {
    this.counters.requests++
    if (!record(body) || typeof body.model !== 'string' || !body.model.trim()
      || !Array.isArray(body.messages) || !body.messages.length || !Array.isArray(body.tools)
      || body.stream !== undefined && body.stream !== true) fail('INVALID_BODY')
    const messages = body.messages.map((message: unknown) => {
      if (!record(message) || !['system', 'user', 'assistant', 'tool'].includes(String(message.role))
        || typeof message.content !== 'string' && message.content !== null) fail('INVALID_BODY')
      return message
    })
    const advertised = new Set<string>()
    for (const tool of body.tools) {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function)
        || typeof tool.function.name !== 'string' || advertised.has(tool.function.name)) fail('INVALID_BODY')
      advertised.add(tool.function.name)
    }
    if (!advertised.has('video_from_image') || !advertised.has('video_get_job')) fail('TOOL_NOT_ADVERTISED')
    let userIndex = messages.length - 1
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex--
    const prompt = messages[userIndex]?.content
    if (userIndex < 0 || typeof prompt !== 'string' || !prompt.includes(PI_VIDEO_MODEL_MOCK_PROMPT)) fail('UNKNOWN_PROMPT')
    const turn = createHash('sha256').update(JSON.stringify(messages.slice(0, userIndex + 1))).digest('hex').slice(0, 20)
    let stage = 0
    let jobId: string | undefined
    let businessError = false
    const ids = new Set<string>()
    const expected = (): { name: ToolName; input: unknown } => stage === 0
      ? { name: 'video_from_image', input: this.input }
      : { name: 'video_get_job', input: { jobId } }
    const history = messages.slice(userIndex + 1)
    for (let index = 0; index < history.length; index += 2) {
      const assistant = history[index]
      if (assistant.role !== 'assistant') fail('INVALID_TOOL_HISTORY')
      if (assistant.tool_calls === undefined || Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 0) {
        if ((!businessError && stage !== 2) || index !== history.length - 1 || !assistant.content) fail('INVALID_TOOL_HISTORY')
        break
      }
      if (businessError || stage === 2 || !Array.isArray(assistant.tool_calls) || assistant.tool_calls.length !== 1) fail('INVALID_TOOL_HISTORY')
      const call: unknown = assistant.tool_calls[0]
      const result = history[index + 1]
      const next = expected()
      if (!record(call) || typeof call.id !== 'string' || !call.id || ids.has(call.id)
        || call.type !== 'function' || !record(call.function) || call.function.name !== next.name
        || typeof call.function.arguments !== 'string' || !isDeepStrictEqual(json(call.function.arguments), next.input)
        || result?.role !== 'tool' || result.tool_call_id !== call.id || typeof result.content !== 'string'
        || result.name !== undefined && result.name !== next.name) fail('INVALID_TOOL_HISTORY')
      ids.add(call.id)
      let value: unknown
      try { value = JSON.parse(result.content) as unknown } catch {
        // Pi can serialize a guard denial or our fixed safe failure as plain text.
        if (!/^(?:Video tool (?:request (?:failed\.|cancelled\.|exceeds the safe limit\.)|is not enabled for this run\.)|Invalid video tool input\.|(?:Tool denied|Unknown tool|User denied)\b)/.test(result.content)) fail('INVALID_TOOL_RESULT')
        businessError = true
        continue
      }
      if (failed(value)) { businessError = true; continue }
      if (!record(value) || typeof value.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.jobId)
        || value.operation !== this.input.operation || value.profileId !== this.input.profileId) fail('INVALID_TOOL_RESULT')
      if (stage === 0) jobId = value.jobId
      else if (value.jobId !== jobId) fail('INVALID_TOOL_RESULT')
      stage++
    }
    const count = (step: keyof PiVideoModelMockAudit['steps']): void => {
      const key = `${turn}:${step}`
      if (this.counted.has(key)) return
      this.counted.add(key)
      this.counters.steps[step]++
      if (step === 'video_from_image') this.counters.generationCount++
    }
    if (businessError || stage === 2) {
      if (businessError) count('businessError')
      count('final')
      return response(body.model, `${turn}-final`, {
        role: 'assistant', content: businessError ? '本地视频工具返回错误或拒绝，本轮已结束，未重试。' : '本地 mock 视频请求已提交，并已查询任务状态。',
      }, 'stop')
    }
    const next = expected()
    count(next.name)
    const id = `sep-pi-video-${turn}-${stage}`
    return response(body.model, id, { role: 'assistant', tool_calls: [{
      index: 0, id, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.input) },
    }] }, 'tool_calls')
  }
}

export function createPiVideoModelMock(options: PiVideoModelMockOptions): PiVideoModelMock {
  return new PiVideoModelMock(options)
}
