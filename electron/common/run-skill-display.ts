import { isAbsolute, join, normalize, sep } from 'node:path'
import type { TaskExecutionEvent } from '../../src/shared/types'
import type { EmployeeRuntimeSnapshot } from './platform/employee-runtime-contract'
import { redactText } from './redact'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function pathKey(path: string): string | undefined {
  if (sep === '\\') {
    path = path.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '')
    if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(path)) return undefined
    return normalize(path).toLowerCase()
  }
  return isAbsolute(path) ? normalize(path) : undefined
}

function skillReadPath(event: TaskExecutionEvent): string | undefined {
  const data = record(event.data)
  if (event.type !== 'tool_execution_start' || data.toolName !== 'read') return undefined
  const path = record(data.input).path
  return typeof path === 'string' && /(?:^|[\\/])SKILL\.md$/i.test(path) ? pathKey(path) : undefined
}

export function needsRunSkillDisplay(event: TaskExecutionEvent): boolean {
  return !!skillReadPath(event) && typeof record(record(event.data).skillDetails).name !== 'string'
}

/** Tool arguments only identify an entry. Display text comes from this run's trusted snapshot. */
export function runSkillDisplay(snapshot: EmployeeRuntimeSnapshot | undefined): (event: TaskExecutionEvent) => TaskExecutionEvent {
  if (!snapshot?.skills.length) return event => event
  const labels = new Map(snapshot.approvedSkills.map(skill => [skill.capabilityId, skill]))
  const installed = new Map(snapshot.skills.flatMap(skill => {
    if (!pathKey(skill.path)) return []
    const path = pathKey(join(skill.path, 'SKILL.md'))
    const label = labels.get(skill.capabilityId)
    return [[path, { name: redactText(label?.name || skill.name),
      description: redactText(label ? label.description ?? '' : skill.description) }] as const]
  }))
  return event => {
    if (event.subscriptionId !== snapshot.subscriptionId) return event
    const path = skillReadPath(event)
    const skillDetails = path && installed.get(path)
    return skillDetails ? { ...event, data: { ...record(event.data), skillDetails } } : event
  }
}
