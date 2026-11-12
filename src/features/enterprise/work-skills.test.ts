import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { TaskExecutionEvent } from '../../shared/types'
import { collectWorkSkills, selectSkillUsageEvent, workSkillDetails } from './work-skills'
import type { SkillLibraryItem } from '../../shared/skill-library'

it('uses capability identity to display the skill name and description instead of its installation name', () => {
  const library: SkillLibraryItem[] = [{ capability: { id: 'cap-a', name: '市场调研', description: '分析市场需求与竞争情况', type: 'SKILL' }, bindings: [], usableVersionIds: [], versions: [], localVersions: [] }]
  assert.deepEqual(workSkillDetails('C:/runtime/ent/member/sub/skills/cap-a/version/sep-f264/SKILL.md', library), { name: '市场调研', description: '分析市场需求与竞争情况' })
  assert.equal(workSkillDetails('C:/runtime/skills/other/version/sep-f264/SKILL.md', library), null)
  assert.equal(workSkillDetails('C:/runtime/skills/cap-a/SKILL.md', library), null)
  assert.equal(workSkillDetails('C:/work/市场调研/SKILL.md', library), null)
})

function event(sequence: number, type: string, data: Record<string, unknown>, runId = 'run'): TaskExecutionEvent {
  return { taskId: 'task', runId, subscriptionId: 'employee', sequence, type, occurredAt: sequence, data }
}

const start = (id: string, path = 'C:\\skills\\表格分析\\SKILL.md') => ({ toolName: 'read', toolId: id, input: { path, password: 'secret' } })
const end = (id: string, success: boolean) => ({ toolName: 'read', toolId: id, success })
const project = (events: TaskExecutionEvent[]) => events.flatMap(item => {
  const selected = selectSkillUsageEvent(item)
  return selected ? [selected] : []
})

it('selects only skill entry reads and removes unrelated inputs and results', () => {
  const selected = project([
    event(1, 'tool_execution_start', start('a')),
    event(2, 'tool_execution_start', start('b', '/work/report.md')),
    event(3, 'tool_execution_start', { ...start('c'), toolName: 'write' }),
    event(4, 'tool_execution_end', { ...end('a', true), result: 'PRIVATE CONTENT' }),
  ])
  assert.equal(selected.length, 2)
  assert.doesNotMatch(JSON.stringify(selected), /password|secret|PRIVATE CONTENT|report/)
  assert.equal(collectWorkSkills(selected)[0]?.name, '表格分析')
})

it('counts successful, pending and failed reads without treating failures as usage', () => {
  const result = collectWorkSkills(project([
    event(1, 'tool_execution_start', start('a')), event(2, 'tool_execution_end', end('a', true)),
    event(3, 'tool_execution_start', start('b')), event(4, 'tool_execution_end', end('b', false)),
    event(5, 'tool_execution_start', start('c')), event(6, 'tool_execution_end', end('missing-start', true)),
  ]))
  assert.deepEqual(result, [{ path: 'C:/skills/表格分析/SKILL.md', name: '表格分析', completed: 1, pending: 1, failed: 1, nodeIds: [] }])
})

it('deduplicates parent and child timelines while preserving node attribution and retries', () => {
  const events = project([
    event(1, 'tool_execution_start', start('same'), 'node-run'),
    event(2, 'arrangement_node_progress', { ...end('same', true), eventType: 'tool_execution_end', nodeId: 'node', nodeRunId: 'node-run' }),
    event(3, 'tool_execution_end', end('same', true), 'node-run'),
    event(4, 'tool_execution_start', start('same'), 'retry-run'),
    event(5, 'tool_execution_end', end('same', true), 'retry-run'),
  ])
  const result = collectWorkSkills([...events, ...events].reverse())
  assert.equal(result.length, 1)
  assert.equal(result[0]?.completed, 2)
  assert.deepEqual(result[0]?.nodeIds, ['node'])
})

it('does not infer usage from model text or skill configuration', () => {
  assert.deepEqual(collectWorkSkills(project([
    event(1, 'text_delta', { text: 'I used /skills/writer/SKILL.md' }),
    event(2, 'tool_execution_start', { toolName: 'read', toolId: 'bad', input: null }),
    event(3, 'tool_execution_start', start('extra', '/skills/writer/SKILL.md.bak')),
  ])), [])
})
