import type { TaskExecutionEvent } from '../../shared/types'
import type { SkillLibraryItem } from '../../shared/skill-library'

export function workSkillDetails(path: string, library: readonly SkillLibraryItem[]): { name: string; description: string } | null {
  const parts = path.replace(/\\/g, '/').split('/')
  const index = parts.lastIndexOf('skills')
  if (index < 0 || parts.length < index + 5) return null
  const item = library.find(skill => skill.capability.id === parts[index + 1])
  return item ? { name: item.capability.name, description: item.capability.description } : null
}

export interface WorkSkillUsage {
  path: string
  name: string
  completed: number
  pending: number
  failed: number
  nodeIds: string[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Retain only skill entry reads and their outcomes, never arbitrary tool inputs. */
export function selectSkillUsageEvent(event: TaskExecutionEvent): TaskExecutionEvent | null {
  const data = record(event.data)
  const type = event.type === 'arrangement_node_progress' ? data.eventType : event.type
  if (data.toolName !== 'read' || typeof data.toolId !== 'string'
    || (type !== 'tool_execution_start' && type !== 'tool_execution_end')) return null
  const safe: Record<string, unknown> = { toolId: data.toolId, toolName: 'read' }
  if (type === 'tool_execution_start') {
    const path = record(data.input).path
    if (typeof path !== 'string' || !/(?:^|[\\/])SKILL\.md$/i.test(path.trim())) return null
    safe.skillPath = path.trim().replace(/\\/g, '/')
  } else if (typeof data.success === 'boolean') safe.success = data.success
  for (const key of ['nodeId', 'nodeRunId', 'eventType']) {
    if (typeof data[key] === 'string') safe[key] = data[key]
  }
  return { ...event, data: safe }
}

export function collectWorkSkills(events: readonly TaskExecutionEvent[]): WorkSkillUsage[] {
  const calls = new Map<string, { path?: string; nodeId?: string; success?: boolean }>()
  for (const event of events) {
    const data = record(event.data)
    const type = event.type === 'arrangement_node_progress' ? data.eventType : event.type
    if (data.toolName !== 'read' || typeof data.toolId !== 'string') continue
    // Wrapped parent events and the child's own timeline describe the same call.
    const key = JSON.stringify([data.nodeRunId ?? event.runId, data.toolId])
    const call = calls.get(key) ?? {}
    if (type === 'tool_execution_start' && typeof data.skillPath === 'string') call.path = data.skillPath
    if (type === 'tool_execution_end' && typeof data.success === 'boolean') call.success = data.success
    if (typeof data.nodeId === 'string') call.nodeId = data.nodeId
    calls.set(key, call)
  }
  const skills = new Map<string, WorkSkillUsage>()
  for (const call of calls.values()) {
    if (!call.path) continue
    let skill = skills.get(call.path)
    if (!skill) {
      skill = { path: call.path, name: call.path.split('/').at(-2) || 'SKILL.md', completed: 0, pending: 0, failed: 0, nodeIds: [] }
      skills.set(call.path, skill)
    }
    if (call.success === true) skill.completed++
    else if (call.success === false) skill.failed++
    else skill.pending++
    if (call.nodeId && !skill.nodeIds.includes(call.nodeId)) skill.nodeIds.push(call.nodeId)
  }
  return [...skills.values()]
}
