import type { PiAssistantMessage as AssistantMessage, PiAssistantMessageEvent as AssistantMessageEvent } from './pi-coding-agent-adapter'
import type { ModelTraceRecorder } from '../../domain/model-trace'
import { redactModelTraceText } from '../../common/redact'
import { logger } from '../../common/logger'

const roles: Record<string, string> = { system: '系统消息', developer: '开发者消息', user: '用户消息', assistant: '助手消息', tool: '工具返回' }
export function readableTraceValue(value: unknown): string {
  if (typeof value === 'string') return redactModelTraceText(value)
  return JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
    if (/^(authorization|cookie|password|secret|token|access_?token|refresh_?token|api_?key|credential)$/i.test(key)) return '[redacted]'
    if (key === 'data' && typeof item === 'string' && (this.type === 'image' || this.type === 'reasoning.encrypted' || typeof this.mimeType === 'string')) return `[binary data omitted: ${item.length} characters]`
    return typeof item === 'string' ? redactModelTraceText(item) : item
  }, 2) ?? String(value)
}

export function modelPayloadText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return readableTraceValue(payload)
  const { messages, tools, ...settings } = payload as Record<string, unknown>
  const sections = [`请求配置\n${readableTraceValue(settings)}`]
  if (Array.isArray(messages)) for (const [index, item] of messages.entries()) {
    if (!item || typeof item !== 'object') continue
    const { content, role, ...metadata } = item as Record<string, unknown>
    const body = Array.isArray(content) ? content.map(part => part?.type === 'text' ? readableTraceValue(part.text) : readableTraceValue(part)).join('\n\n') : readableTraceValue(content)
    sections.push(`消息 ${index + 1} · ${roles[String(role)] ?? String(role)}\n${readableTraceValue(metadata)}\n\n${body}`)
  }
  if (Array.isArray(tools)) sections.push(`工具定义（${tools.length} 项）\n${readableTraceValue(tools)}`)
  return sections.join('\n\n')
}

export interface StreamTimings {
  firstEventMs?: number
  firstThinkingMs?: number
  firstTextMs?: number
}

/** Disk writes are observational: they never block, throw into, or consume the provider stream. */
export async function* traceModelStream(
  source: AsyncIterable<AssistantMessageEvent>,
  record: ModelTraceRecorder,
  onComplete: (message: AssistantMessage, timings: StreamTimings) => Promise<void>,
  startedAt: number | (() => number) = Date.now(),
  onProgress?: (timings: StreamTimings) => void,
): AsyncGenerator<AssistantMessageEvent> {
  const parts = new Map<number, { kind: 'thinking' | 'output' | 'tool'; text: string; writtenAt: number }>()
  const timings: StreamTimings = {}
  let settled = false
  let failed = false
  const reportError = (): void => {
    if (failed) return
    failed = true
    logger.child('model-trace').warn('model trace write failed', { reason: '响应明细记录失败；业务请求继续运行' })
  }
  const save = (entry: Parameters<ModelTraceRecorder>[0]): void => {
    try { void record(entry).catch(reportError) } catch { reportError() }
  }
  const flush = (index: number): void => {
    const part = parts.get(index)!
    save({ phase: '', kind: part.kind, streamId: String(index), replace: true, text: part.text })
    part.writtenAt = Date.now()
  }
  try {
    for await (const event of source) {
      let changed = false
      const elapsed = Date.now() - (typeof startedAt === 'function' ? startedAt() : startedAt)
      if (timings.firstEventMs === undefined) { timings.firstEventMs = elapsed; changed = true }
      if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
        if (event.type === 'text_delta' && timings.firstTextMs === undefined) { timings.firstTextMs = elapsed; changed = true }
        if (event.type === 'thinking_delta' && timings.firstThinkingMs === undefined) { timings.firstThinkingMs = elapsed; changed = true }
        const part = parts.get(event.contentIndex) ?? { kind: event.type === 'text_delta' ? 'output' : event.type === 'thinking_delta' ? 'thinking' : 'tool', text: '', writtenAt: 0 }
        part.text += event.delta
        parts.set(event.contentIndex, part)
        if (Date.now() - part.writtenAt >= 1000) flush(event.contentIndex)
      } else if (event.type === 'text_end' || event.type === 'thinking_end') {
        if (parts.has(event.contentIndex)) flush(event.contentIndex)
      } else if (event.type === 'toolcall_end') {
        parts.set(event.contentIndex, { kind: 'tool', text: readableTraceValue(event.toolCall), writtenAt: Date.now() })
        flush(event.contentIndex)
      } else if (event.type === 'done' || event.type === 'error') {
        if (changed) { onProgress?.({ ...timings }); changed = false }
        const message = event.type === 'done' ? event.message : event.error
        for (const [index, part] of message.content.entries()) {
          const text = part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : readableTraceValue(part)
          const received = parts.get(index)
          const completeText = received && part.type !== 'toolCall' && received.text.startsWith(text) ? received.text : text
          parts.set(index, { kind: part.type === 'text' ? 'output' : part.type === 'thinking' ? 'thinking' : 'tool', text: completeText, writtenAt: Date.now() })
        }
        for (const index of parts.keys()) flush(index)
        try { void onComplete(message, timings).catch(reportError) } catch { reportError() }
        settled = true
      }
      if (changed) onProgress?.({ ...timings })
      yield event
    }
  } finally {
    if (!settled) {
      for (const index of parts.keys()) flush(index)
      save({ phase: '', kind: 'status', text: '流式响应未正常结束；以上仅为已接收内容。', completed: true })
    }
  }
}
