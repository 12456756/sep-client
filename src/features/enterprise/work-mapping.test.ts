import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { buildWorkItem, encodeWorkPrompt } from './work-mapping'
import type { ClientTask } from '../../shared/types'

const prompt = encodeWorkPrompt('整理资料', {
  kind: 'conversation', goal: '请整理这份资料', steps: [], participants: ['employee-a'],
  sharedContext: { goal: '请整理这份资料', confirmedInputs: [], previousResults: [], userNotes: [] },
})
const task: ClientTask = {
  id: 'task-a', title: '整理资料', prompt, status: 'running', workDir: null,
  createdAt: 1, startedAt: 2, completedAt: null, error: null, files: [], logs: [],
  ownerId: 'member-a', ownerEnterpriseId: 'enterprise-a', subscriptionId: 'employee-a', activeRunId: 'run-a',
}

describe('conversation display regressions', () => {
  it('renders only the original user goal for legacy encoded initial prompts', () => {
    const fallback = buildWorkItem({ task, employees: [] })
    const loaded = buildWorkItem({ task, employees: [], messages: [
      { id: 'run-a-user', role: 'user', content: prompt, createdAt: 1, runId: 'run-a' },
    ] })
    assert.equal(fallback.messages[0]?.content, '请整理这份资料')
    assert.equal(loaded.messages[0]?.content, '请整理这份资料')
  })

  it('never rewrites normal follow-up messages or assistant replies as goal metadata', () => {
    const content = '请解释“工作目标：”这个标签'
    const work = buildWorkItem({ task, employees: [], messages: [
      { id: 'user-2', role: 'user', content, createdAt: 3, runId: 'run-b' },
      { id: 'assistant', role: 'assistant', content: prompt, createdAt: 4, runId: 'run-b' },
    ] })
    assert.deepEqual(work.messages.map(message => message.content), [content, prompt])
  })

  it('replaces a partial persisted response with the live response for the same run', () => {
    const work = buildWorkItem({ task, employees: [], streamingText: '你好，世界', streamingRunId: 'run-a', messages: [
      { id: 'old-assistant', role: 'assistant', content: '之前的回答', createdAt: 1, runId: 'old-run' },
      { id: 'run-a-assistant', role: 'assistant', content: '你好', createdAt: 2, runId: 'run-a' },
    ] })
    assert.deepEqual(work.messages.map(message => message.content), ['之前的回答', '你好，世界'])
  })
})
