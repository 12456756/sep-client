import type { TaskExecutionEvent } from '../../src/shared/types'
import { hasSideEffects } from '../common/constants'

export type TaskEventVisibility = 'stream' | 'important' | 'internal'

const INTERNAL_EVENT_TYPES = new Set([
  'agent_start',
  'agent_settled',
  'turn_start',
  'turn_end',
  'message_start',
  'message_end',
  'compaction_start',
  'compaction_end',
])

const IMPORTANT_EVENT_TYPES = new Set([
  'tool_execution_start',
  'tool_execution_end',
  'approval_requested',
  'approval_resolved',
  'tool_call_blocked',
  'unknown_tool_blocked',
  'agent_end',
  'auto_retry_start',
  'auto_retry_end',
  'session_error',
  'workflow_node_started',
  'workflow_node_completed',
  'workflow_node_failed',
  'workflow_state_changed',
  'SIDE_EFFECT_UNKNOWN',
])

/**
 * Renderer-facing event policy. Persistence still records every sanitized event;
 * this policy only controls the low-latency push stream used by work details.
 */
export function classifyTaskEvent(event: TaskExecutionEvent): TaskEventVisibility {
  if (event.type === 'text_delta') return 'stream'
  if (IMPORTANT_EVENT_TYPES.has(event.type)) return 'important'
  if (INTERNAL_EVENT_TYPES.has(event.type)) return 'internal'

  // Keep the safety invariant explicit: side-effect tool lifecycle events are
  // always important even if a future caller gives them a custom event type.
  if (event.type.startsWith('tool_execution_')) {
    const toolName = readToolName(event.data)
    if (toolName && hasSideEffects(toolName)) return 'important'
  }
  return 'internal'
}

export function shouldPushTaskEvent(event: TaskExecutionEvent): boolean {
  return classifyTaskEvent(event) !== 'internal'
}

function readToolName(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const value = (data as { toolName?: unknown }).toolName
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
