import type { TaskExecutionEvent } from '../../shared/types'
import type { WorkStep } from './types'
import { processActivityLabel } from './work-process'

export interface TranscriptEntry {
  id: string
  kind: 'thinking' | 'text' | 'tool' | 'status'
  text: string
  state?: 'running' | 'completed' | 'failed' | 'waiting-user'
  at: number
}

export interface NodeTranscript {
  step: WorkStep
  entries: TranscriptEntry[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Hold protocol-looking suffixes back even before the final JSON is complete. */
export function visibleModelText(text: string): string {
  let fence: string | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (!fence) {
      const protocol = /^(?:`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?\s*$|`{3}json\b|\{|\[(?=\s|"|\{|\[|\]|$))|\{\s*"(?:nodeId|finalDeliverables|summary)"\s*:/i.exec(trimmed)
      if (protocol) return text.slice(0, offset + line.length - trimmed.length + protocol.index).trim()
    }
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
    }
    offset += line.length + 1
  }
  return text.trim()
}

export function mergeTranscriptEvents(current: readonly TaskExecutionEvent[], incoming: readonly TaskExecutionEvent[]): TaskExecutionEvent[] {
  const events = new Map(current.map(event => [`${event.runId}:${event.sequence}`, event]))
  for (const event of incoming) events.set(`${event.runId}:${event.sequence}`, event)
  return [...events.values()].sort((a, b) => a.occurredAt - b.occurredAt || a.runId.localeCompare(b.runId) || a.sequence - b.sequence)
}

const PROGRESS_TYPES = new Set(['turn_start', 'turn_end', 'text_delta', 'thinking_delta', 'tool_execution_start', 'tool_execution_end',
  'approval_requested', 'approval_resolved', 'auto_retry_start', 'auto_retry_end'])

function snapshotThinking(data: Record<string, unknown>): string {
  if (typeof data.thinking === 'string') return data.thinking
  const message = record(data.message)
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  return message.content.flatMap(value => {
    const block = record(value)
    return block.type === 'thinking' && typeof block.thinking === 'string' ? [block.thinking] : []
  }).join('\n').trim()
}

/** Excludes prompts, tool arguments/results and session internals from UI state. */
export function selectTranscriptEvent(event: TaskExecutionEvent): TaskExecutionEvent | null {
  const data = record(event.data)
  const type = event.type === 'arrangement_node_progress' ? data.eventType : event.type
  if (typeof type !== 'string' || (!PROGRESS_TYPES.has(type) && !['message_end', 'arrangement_node_started', 'arrangement_node_completed', 'arrangement_node_failed'].includes(type))) return null
  const safe: Record<string, unknown> = {}
  for (const key of ['nodeId', 'nodeRunId', 'eventType', 'text', 'toolId', 'toolName', 'requestId', 'success', 'approved', 'stopReason']) {
    const value = data[key]
    if (typeof value === 'string' || typeof value === 'boolean') safe[key] = value
  }
  if (type === 'message_end' || type === 'turn_end') {
    const thinking = snapshotThinking(data)
    if (thinking) safe.thinking = thinking
    else if (type === 'message_end') return null
  }
  return { ...event, data: safe }
}

export function buildArrangementTranscript(steps: readonly WorkStep[], source: readonly TaskExecutionEvent[]): NodeTranscript[] {
  const events = mergeTranscriptEvents([], source)
  const result = steps.map(step => ({ step, entries: [] as TranscriptEntry[] }))
  const nodes = new Map(result.map(node => [node.step.id, node]))
  const runNodes = new Map<string, string>()
  const wrappedRuns = new Set<string>()
  for (const event of events) {
    const data = record(event.data)
    if (typeof data.nodeRunId === 'string' && typeof data.nodeId === 'string') {
      runNodes.set(data.nodeRunId, data.nodeId)
      if (event.type === 'arrangement_node_progress') wrappedRuns.add(data.nodeRunId)
    }
  }
  const turns = new Map<string, number>()
  const entries = new Map<string, TranscriptEntry>()
  const streamedThinking = new Set<string>()
  for (const event of events) {
    const data = record(event.data)
    const wrapped = event.type === 'arrangement_node_progress'
    const runId = wrapped && typeof data.nodeRunId === 'string' ? data.nodeRunId : event.runId
    if (!wrapped && wrappedRuns.has(runId) && !['message_end', 'turn_end'].includes(event.type)) continue
    const nodeId = wrapped ? data.nodeId : runNodes.get(runId)
    const node = typeof nodeId === 'string' ? nodes.get(nodeId) : undefined
    if (!node) continue
    const type = wrapped ? data.eventType : event.type
    if (type === 'turn_start') { turns.set(runId, (turns.get(runId) ?? 0) + 1); continue }
    const at = event.occurredAt
    const turn = `${runId}:${turns.get(runId) ?? 0}`
    if (type === 'message_end' || type === 'turn_end') {
      const thinking = snapshotThinking(data)
      if (thinking && !streamedThinking.has(turn)) {
        const id = `${turn}:thinking`
        let entry = entries.get(id)
        if (!entry) {
          entry = { id, kind: 'thinking', text: thinking, at }
          entries.set(id, entry)
          const replyIndex = node.entries.findIndex(item => item.id === `${turn}:text`)
          if (replyIndex < 0) node.entries.push(entry)
          else node.entries.splice(replyIndex, 0, entry)
        } else entry.text = thinking
      }
      continue
    }
    if ((type === 'text_delta' || type === 'thinking_delta') && typeof data.text === 'string') {
      const kind = type === 'thinking_delta' ? 'thinking' : 'text'
      const id = `${turn}:${kind}`
      let entry = entries.get(id)
      if (!entry) { entry = { id, kind, text: '', at }; entries.set(id, entry); node.entries.push(entry) }
      if (kind === 'thinking') {
        if (!streamedThinking.has(turn)) entry.text = ''
        streamedThinking.add(turn)
      }
      entry.text += data.text
    } else if (type === 'tool_execution_start' || type === 'tool_execution_end') {
      if (typeof data.toolId !== 'string') continue
      const id = `${runId}:tool:${data.toolId}`
      let entry = entries.get(id)
      if (!entry) {
        const toolName = typeof data.toolName === 'string' ? data.toolName : undefined
        const label = toolName === 'mcp__officecli__officecli' ? '使用 OfficeCLI 处理文档'
          : processActivityLabel({ id, runId, toolName, text: '处理任务', state: 'running', startedAt: at })
        entry = { id, kind: 'tool', text: `正在${label}`, at, state: 'running' }
        entries.set(id, entry); node.entries.push(entry)
      }
      if (type === 'tool_execution_end') entry.state = data.success === false ? 'failed' : 'completed'
    } else if (type === 'auto_retry_start' || type === 'approval_requested') {
      node.entries.push({ id: `${runId}:${event.sequence}:status`, kind: 'status',
        text: type === 'auto_retry_start' ? '连接暂时中断，正在重试' : '等待你的操作确认', at })
    }
  }
  return result.map(node => ({ ...node, entries: node.entries.flatMap(entry => {
    if (entry.kind !== 'text') return [entry]
    const text = visibleModelText(entry.text)
    return text ? [{ ...entry, text }] : []
  }) }))
}
