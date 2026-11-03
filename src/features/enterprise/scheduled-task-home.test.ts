import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { authorizedScheduledModels, automaticPlanningSelection, emptyScheduledTaskDraft, SCHEDULE_EXAMPLES } from './scheduled-task-home'

const employees = [
  { id: 'first', assignedToMe: true, availability: 'ready' as const, allowedModels: ['model-a', 'shared'] },
  { id: 'second', assignedToMe: true, availability: 'ready' as const, allowedModels: ['model-b', 'shared'] },
]

test('homepage models are a deduplicated union of currently authorized employees', () => {
  assert.deepEqual(authorizedScheduledModels([...employees, { ...employees[0], assignedToMe: false, allowedModels: ['private'] }, { ...employees[0], availability: 'needs-auth', allowedModels: ['expired'] }]), ['model-a', 'shared', 'model-b'])
})

test('automatic planning selects an authorized employee and model without a visible employee choice', () => {
  assert.deepEqual(automaticPlanningSelection(employees, '', ''), { subscriptionId: 'first', modelId: 'model-a' })
  assert.deepEqual(automaticPlanningSelection(employees, 'model-b', 'first'), { subscriptionId: 'second', modelId: 'model-b' })
  assert.deepEqual(automaticPlanningSelection(employees, 'shared', 'second'), { subscriptionId: 'second', modelId: 'shared' })
  assert.deepEqual(automaticPlanningSelection(employees, 'retired-model', 'second'), { subscriptionId: 'second', modelId: 'model-b' })
})

test('automatic planning never selects unavailable, unauthorized or model-less employees', () => {
  const blocked = [
    { ...employees[0], assignedToMe: false },
    { ...employees[0], availability: 'needs-auth' as const },
    { ...employees[0], availability: 'unavailable' as const },
    { ...employees[0], allowedModels: [] },
  ]
  assert.deepEqual(automaticPlanningSelection(blocked, 'model-a', 'first'), { subscriptionId: '', modelId: '' })
  assert.deepEqual(automaticPlanningSelection([...blocked, employees[1]], 'model-a', 'first'), { subscriptionId: 'second', modelId: 'model-b' })
  assert.deepEqual(automaticPlanningSelection([], '', ''), { subscriptionId: '', modelId: '' })
})

test('home drafts start without execution authority or a guessed employee and do not share mutable settings', () => {
  const first = emptyScheduledTaskDraft(), second = emptyScheduledTaskDraft()
  assert.deepEqual(first, { goal: '', mode: 'employee', subscriptionId: '', settings: { workDir: '', modelId: '', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' }, knowledge: { mode: 'none', knowledgeBaseIds: [] } } })
  first.settings.permissions.approvalMode = 'auto-approve'
  assert.equal(second.settings.permissions.approvalMode, 'confirm-each')
})

test('examples provide editable goals with a schedule and file deliverables, not execution configuration', () => {
  assert.equal(new Set(SCHEDULE_EXAMPLES.map(item => item.id)).size, SCHEDULE_EXAMPLES.length)
  for (const example of SCHEDULE_EXAMPLES) {
    assert.ok(example.title && example.description)
    assert.match(example.prompt, /每/)
    assert.match(example.prompt, /Markdown|Excel/)
    assert.ok(example.prompt.length <= 16000)
    assert.deepEqual(Object.keys(example).sort(), ['description', 'id', 'prompt', 'title'])
  }
})
