import { test } from 'node:test'
import { registerHooks } from 'node:module'
import * as assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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

test('scheduled automatic mode prefers a saved default and finds an employee authorized to use it', () => {
  assert.deepEqual(automaticPlanningSelection(employees, '', 'first', 'model-b'), { subscriptionId: 'second', modelId: 'model-b' })
  assert.deepEqual(automaticPlanningSelection(employees, '', 'second', 'shared'), { subscriptionId: 'second', modelId: 'shared' })
  assert.deepEqual(automaticPlanningSelection(employees, 'model-a', 'second', 'model-b'), { subscriptionId: 'first', modelId: 'model-a' })
  assert.deepEqual(automaticPlanningSelection(employees, 'revoked', 'first', 'model-b'), { subscriptionId: 'second', modelId: 'model-b' })
  assert.deepEqual(automaticPlanningSelection(employees, '', 'second', 'revoked'), { subscriptionId: 'second', modelId: 'model-b' })
})

test('home drafts start without execution authority or a guessed employee and do not share mutable settings', () => {
  const first = emptyScheduledTaskDraft(), second = emptyScheduledTaskDraft()
  assert.deepEqual(first, { goal: '', mode: 'general', subscriptionId: '', settings: { workDir: '', modelId: '', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' }, knowledge: { mode: 'none', knowledgeBaseIds: [] } } })
  first.settings.permissions.approvalMode = 'auto-approve'
  assert.equal(second.settings.permissions.approvalMode, 'confirm-each')
})

test('new editor defaults to the general assistant, hides the picker for orchestration, and preserves old local actions', async () => {
  const hooks = registerHooks({ load: (url, context, nextLoad) => url.endsWith('.css')
    ? { format: 'module', source: 'export {}', shortCircuit: true } : nextLoad(url, context) })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try {
    const { ScheduledTaskEditorForm } = await import('../../components/enterprise/scheduled/ScheduledTaskEditor')
    type EditorProps = React.ComponentProps<typeof ScheduledTaskEditorForm>
    const props = { workspace: { myEmployees: [] } as unknown as EditorProps['workspace'], model: { busy: false } as EditorProps['model'], onClose() {} }
    const scheduledAt = Date.now() + 3600000
    const fresh = renderToStaticMarkup(React.createElement(ScheduledTaskEditorForm, { ...props }))
    const modes = fresh.match(/<select aria-label="任务模式">(.*?)<\/select>/)?.[1]
    assert.ok(modes)
    assert.deepEqual([...modes.matchAll(/<option value="([^"]+)"[^>]*>/g)].map(match => match[1]), ['employee', 'auto'])
    assert.match(fresh, /title="通用助手" aria-label="执行员工"/)
    assert.doesNotMatch(fresh, /scheduled-filename-mode/)
    const auto = renderToStaticMarkup(React.createElement(ScheduledTaskEditorForm, { ...props, initialDraft: { ...emptyScheduledTaskDraft(), mode: 'auto' } }))
    assert.doesNotMatch(auto, /aria-label="执行员工"/)
    const existing = renderToStaticMarkup(React.createElement(ScheduledTaskEditorForm, { ...props, definition: {
      id: 'existing', revision: 1, enabled: false, deleted: false, plan: null, planInputKey: null, nextRunAt: null, createdAt: 1, updatedAt: 1,
      input: { mode: 'empty-text', name: 'Existing task', goal: 'Create an empty file', workDir: 'C:/work', scheduledAt, timezone: 'UTC',
        emptyText: { naming: 'fixed', filename: 'existing.txt' }, permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } },
    } }))
    assert.match(existing, /<option value="empty-text" selected="">/)
    assert.match(existing, /id="scheduled-filename"[^>]*value="existing\.txt"/)
  } finally {
    hooks.deregister()
    if (previous) Object.defineProperty(globalThis, 'React', previous)
    else Reflect.deleteProperty(globalThis, 'React')
  }
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
