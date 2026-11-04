import type { TaskExecutionEvent } from '../../shared/types'
import { mergeTranscriptEvents, selectTranscriptEvent, type TranscriptEntry } from './arrangement-transcript'
import { processActivityLabel } from './work-process'
import type { WorkItem, WorkMessage } from './types'

export interface ConversationProcessEntry extends TranscriptEntry {
  toolName?: string
}

export interface ConversationRunTranscript {
  runId: string
  entries: ConversationProcessEntry[]
}

export type ConversationReplyItem =
  | { kind: 'message'; id: string; message: WorkMessage }
  | { kind: 'reply'; id: string; runId?: string; messages: WorkMessage[]; active: boolean; createdAt: number }

/** Persisted user messages belong to started runs; waiting queue entries never enter this list. */
export function buildConversationReplies(work: WorkItem, preparing: boolean): ConversationReplyItem[] {
  const replies = new Map<string, WorkMessage[]>()
  for (const message of work.messages) {
    if (message.role === 'employee' && message.runId) replies.set(message.runId, [...(replies.get(message.runId) ?? []), message])
  }
  const items: ConversationReplyItem[] = []
  const shown = new Set<string>()
  const activeRunId = work.isActive ? work.activeRunId : null
  const appendReply = (runId: string, createdAt: number) => {
    if (shown.has(runId)) return
    shown.add(runId)
    items.push({ kind: 'reply', id: `reply:${runId}`, runId, messages: replies.get(runId) ?? [], active: runId === activeRunId, createdAt })
  }
  for (const message of work.messages) {
    if (message.role !== 'employee') {
      items.push({ kind: 'message', id: message.id, message })
      if (message.role === 'user' && message.runId) appendReply(message.runId, message.createdAt)
    } else if (message.runId) appendReply(message.runId, message.createdAt)
    else items.push({ kind: 'reply', id: `reply:${message.id}`, messages: [message], active: false, createdAt: message.createdAt })
  }
  if (activeRunId) appendReply(activeRunId, work.currentRunStartedAt ?? work.queuedAt ?? work.updatedAt)
  else if (preparing) items.push({ kind: 'reply', id: `reply:${work.id}:preparing`, messages: [], active: true, createdAt: work.updatedAt })
  return items
}

/** Project only display-safe thinking and tool lifecycle data, never prompts or tool arguments. */
export function buildConversationTranscript(source: readonly TaskExecutionEvent[]): ConversationRunTranscript[] {
  const runs = new Map<string, ConversationRunTranscript>()
  const tools = new Map<string, ConversationProcessEntry>()
  const approvals = new Map<string, ConversationProcessEntry>()
  const streamed = new Set<string>()
  const snapshots = new Set<string>()
  const turns = new Map<string, number>()
  const lastThinking = new Map<string, ConversationProcessEntry>()
  for (const raw of mergeTranscriptEvents([], source)) {
    if (raw.type === 'arrangement_node_progress') continue
    const event = selectTranscriptEvent(raw)
    if (!event) continue
    const data = event.data as Record<string, unknown>
    const { runId, type, occurredAt: at } = event
    const turn = `${runId}:${turns.get(runId) ?? 0}`
    if (type === 'turn_start') {
      turns.set(runId, (turns.get(runId) ?? 0) + 1)
      lastThinking.delete(runId)
      continue
    }
    if (type === 'text_delta') { lastThinking.delete(runId); continue }
    const run = runs.get(runId) ?? { runId, entries: [] }
    const append = (entry: ConversationProcessEntry) => { run.entries.push(entry); runs.set(runId, run) }
    if (type === 'thinking_delta' && typeof data.text === 'string' && data.text) {
      let entry = lastThinking.get(runId)
      if (!entry) {
        entry = { id: `${runId}:${event.sequence}:thinking`, kind: 'thinking', text: '', at }
        lastThinking.set(runId, entry)
        append(entry)
      }
      entry.text += data.text
      streamed.add(turn)
    } else if (type === 'message_end' || type === 'turn_end') {
      if (typeof data.thinking === 'string' && !streamed.has(turn) && !snapshots.has(turn)) {
        append({ id: `${turn}:snapshot`, kind: 'thinking', text: data.thinking, at })
        snapshots.add(turn)
      }
      lastThinking.delete(runId)
    } else if (type === 'tool_execution_start' || type === 'tool_execution_end') {
      lastThinking.delete(runId)
      if (typeof data.toolId !== 'string') continue
      const id = `${runId}:tool:${data.toolId}`
      let entry = tools.get(id)
      if (!entry) {
        const toolName = typeof data.toolName === 'string' ? data.toolName : undefined
        const text = toolName === 'mcp__officecli__officecli' ? '处理办公文档'
          : processActivityLabel({ id, runId, toolName, text: '执行工具操作', state: 'running', startedAt: at })
        entry = { id, kind: 'tool', text, toolName, state: 'running', at }
        tools.set(id, entry)
        append(entry)
      }
      if (type === 'tool_execution_end') entry.state = data.success === false ? 'failed' : 'completed'
    } else if (type === 'approval_requested') {
      lastThinking.delete(runId)
      if (typeof data.requestId !== 'string') continue
      const id = `${runId}:approval:${data.requestId}`
      const entry: ConversationProcessEntry = { id, kind: 'status', at, state: 'waiting-user', text: '等待你的操作确认' }
      approvals.set(id, entry)
      append(entry)
    } else if (type === 'approval_resolved') {
      if (typeof data.requestId !== 'string') continue
      const entry = approvals.get(`${runId}:approval:${data.requestId}`)
      if (!entry) continue
      entry.state = data.approved === true ? 'completed' : 'failed'
      entry.text = data.approved === true ? '已允许操作' : '操作未获允许'
    } else if (type === 'auto_retry_start') {
      lastThinking.delete(runId)
      append({ id: `${runId}:${event.sequence}:status`, kind: 'status', at, text: '连接暂时中断，正在重试' })
    }
  }
  return [...runs.values()]
}
