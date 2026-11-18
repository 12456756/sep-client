import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { join, resolve, toNamespacedPath } from 'node:path'
import type { TaskExecutionEvent } from '../../src/shared/types'
import type { EmployeeRuntimeSnapshot } from './platform/employee-runtime-contract'
import { needsRunSkillDisplay, runSkillDisplay } from './run-skill-display'

const root = resolve('runtime', 'skills-v2', 'a'.repeat(64), 'opaque', 'skills')
const snapshot: EmployeeRuntimeSnapshot = {
  manifestVersion: 1, enterpriseId: 'ent-a', memberId: 'member-a', employeeId: 'employee-a',
  subscriptionId: 'sub-a', templateVersion: '1', employeeVersion: '1', maxSteps: 1, systemPrompt: '',
  modelId: 'model-a', allowedModels: ['model-a'], approvedSkills: [
    { capabilityId: 'cap-a', versionId: 'v1', version: '1', name: 'Archived label', description: 'Archived description', content: 'PRIVATE APPROVED' },
  ], skills: [
    { capabilityId: 'cap-a', versionId: 'local', baseSkillVersionId: 'v1', version: '1', source: 'owner-local',
      name: 'opaque', description: 'PRIVATE LOCAL DESCRIPTION', content: 'PRIVATE LOCAL', sha256: 'a'.repeat(64), path: root },
  ],
}
function event(path: string): TaskExecutionEvent {
  return { taskId: 'task-a', runId: 'run-a', subscriptionId: 'sub-a', sequence: 1, occurredAt: 1, type: 'tool_execution_start',
    data: { toolId: 'read-a', toolName: 'read', input: { path } } }
}

it('describes exact snapshot entries across normal, namespace and separator spellings', () => {
  const project = runSkillDisplay(snapshot)
  for (const path of [join(root, 'SKILL.md'), toNamespacedPath(join(root, 'SKILL.md')), join(root, 'SKILL.md').replace(/\\/g, '/')]) {
    const source = event(path)
    assert.equal(needsRunSkillDisplay(source), true)
    const described = project(source)
    assert.deepEqual((described.data as Record<string, unknown>).skillDetails, { name: 'Archived label', description: 'Archived description' })
    assert.equal(needsRunSkillDisplay(described), false)
    assert.doesNotMatch(JSON.stringify(described), /PRIVATE/)
    assert.equal((source.data as Record<string, unknown>).skillDetails, undefined)
  }
})

it('does not match another installation, relative paths, resources, subscriptions or tool names', () => {
  const project = runSkillDisplay(snapshot)
  const exact = event(join(root, 'SKILL.md'))
  const events = [
    event(join(root, 'elsewhere', 'SKILL.md')), event('SKILL.md'), event('C:SKILL.md'), event(join(root, 'guide.md')),
    { ...exact, subscriptionId: 'sub-b' }, { ...exact, type: 'tool_execution_end' },
    { ...exact, data: { ...(exact.data as object), toolName: 'write' } },
  ]
  for (const source of events) assert.equal(project(source), source)
  assert.equal(runSkillDisplay(undefined)(exact), exact)
})
