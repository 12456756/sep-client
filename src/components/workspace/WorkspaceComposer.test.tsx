import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkspaceComposer } from './WorkspaceComposer'

test('shows the selected directory tail in conversation and workflow composers', () => {
  const previousReact = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try {
    for (const mode of ['conversation', 'workflow'] as const) {
      const html = renderToStaticMarkup(React.createElement(WorkspaceComposer, {
        mode,
        draft: {
          employeeId: '', modelId: '', skillIds: [],
          workspace: { path: 'C:/Users/alice/Projects/sep', displayName: 'sep', accessMode: 'read-write' },
        },
        employees: [],
        skills: [],
        workflows: [],
        onDraftChange: () => undefined,
        onConversationSubmit: () => undefined,
        onWorkflowSubmit: () => undefined,
      }))
      assert.match(html, /\.\.\.\/alice\/Projects\/sep/)
      assert.match(html, /title="C:\/Users\/alice\/Projects\/sep"/)
    }
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact })
  }
})

test('shows context usage only inside an existing conversation', () => {
  const previousReact = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try {
    const props = {
      mode: 'conversation' as const,
      draft: { employeeId: 'employee', modelId: 'model', skillIds: [], workspace: { path: '', displayName: '', accessMode: 'read-write' as const } },
      employees: [], skills: [], workflows: [], onDraftChange: () => undefined,
      onConversationSubmit: () => undefined, onWorkflowSubmit: () => undefined,
    }
    const currentTask = { id: 'task-existing', type: 'conversation', workspace: props.draft.workspace } as import('../../features/workspace/useWorkspaceDemo').Task
    const existing = renderToStaticMarkup(React.createElement(WorkspaceComposer, { ...props, currentTask }))
    const fresh = renderToStaticMarkup(React.createElement(WorkspaceComposer, props))
    assert.match(existing, /context-usage-indicator/)
    assert.doesNotMatch(fresh, /context-usage-indicator/)
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact })
  }
})
