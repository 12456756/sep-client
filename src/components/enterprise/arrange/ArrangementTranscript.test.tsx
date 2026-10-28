import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArrangementTranscriptView } from './ArrangementTranscript'
import type { WorkItem } from '../../../features/enterprise/types'
import { buildArrangementTranscript } from '../../../features/enterprise/arrangement-transcript'
import type { TaskExecutionEvent } from '../../../shared/types'

const work: WorkItem = {
  id: 'task', title: 'Report', goal: 'Original user goal', kind: 'flow', workType: { state: 'resolved', kind: 'arrangement' },
  status: 'running', isActive: true, progress: 0, currentEmployeeId: 'employee-a', currentEmployeeName: 'Alice',
  steps: ['a', 'b', 'c'].map(id => ({ id, title: `Node ${id}`, employeeId: `employee-${id}`, employeeName: `Employee ${id}`,
    input: 'INTERNAL PROMPT', output: '', dependsOn: [], needsConfirm: false, state: id === 'c' ? 'done' : 'running' })),
  nextUserAction: null, createdAt: 1, startedAt: 2, completedAt: null, updatedAt: 3, participants: [], deliverables: [],
  timeline: [], messages: [{ id: 'secret', role: 'user', content: 'REPAIR PROMPT', createdAt: 3 }], activities: [],
  sharedContext: { goal: '', confirmedInputs: [], previousResults: [], userNotes: [] }, stopReason: null, workDir: null,
}

function render(events: TaskExecutionEvent[] = []) {
  const previous = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try {
    return renderToStaticMarkup(React.createElement(ArrangementTranscriptView, { work, employees: [],
      nodes: buildArrangementTranscript(work.steps, events), busy: false, onStop: async () => true, onResults() {} }))
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previous })
  }
}

describe('arrangement process interface', () => {
  it('replaces chat with the original task and parallel node groups', () => {
    const html = render()
    assert.match(html, /Original user goal/)
    assert.match(html, /Employee a/)
    assert.match(html, /Employee b/)
    assert.doesNotMatch(html, /REPAIR PROMPT|INTERNAL PROMPT|textarea|发送|补充说明/)
    assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 2)
    assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 1)
    assert.match(html, /我已经完成工作。/)
  })

  it('collapses long thinking, decorates tools and never renders submission JSON', () => {
    const events = [
      { eventType: 'thinking_delta', text: 'Thinking '.repeat(30) },
      { eventType: 'text_delta', text: '{"nodeId":"a","finalDeliverables":[]}' },
      { eventType: 'tool_execution_start', toolId: 'read', toolName: 'read' },
    ].map((data, sequence) => ({ taskId: 'task', runId: 'parent', subscriptionId: 'owner', sequence, occurredAt: sequence,
      type: 'arrangement_node_progress', data: { ...data, nodeId: 'a', nodeRunId: 'run-a' } }))
    const html = render(events)
    assert.match(html, /<details class="ent-transcript-thinking">/)
    assert.doesNotMatch(html, /<details[^>]*open|finalDeliverables|nodeId/)
    assert.match(html, /正在读取文件/)
    assert.match(html, /进行中/)
  })

  it('renders model text without the answer-copy action', () => {
    const html = render([{ taskId: 'task', runId: 'parent', subscriptionId: 'owner', sequence: 1, occurredAt: 1,
      type: 'arrangement_node_progress', data: { nodeId: 'a', nodeRunId: 'run-a', eventType: 'text_delta', text: 'A visible answer' } }])
    assert.match(html, /A visible answer/)
    assert.doesNotMatch(html, /复制回答/)
  })
})
