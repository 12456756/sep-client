import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import type { ScheduledCreation } from '../../../shared/scheduled-creation'
import { FeedbackProvider } from '../../feedback/FeedbackProvider'
import { ScheduledCreationList } from './ScheduledCreationList'

function render(stage: ScheduledCreation['stage'], options: Pick<ScheduledCreation, 'confirmationOutcome'> = {}, cancelling = false): string {
  const creation: ScheduledCreation = { id: '11111111-1111-4111-8111-111111111111', revision: 2,
    fromConversation: true, conversationId: 'chat', stage, createdAt: 1, updatedAt: 2, referenceNow: 1,
    request: { message: '每日统计', modelId: 'model', workDir: 'C:/reports', timezone: 'Asia/Shanghai',
      permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } },
    messages: [{ role: 'user', content: '每日统计' }], submissionKey: 'request', parsedSubmissionKey: null,
    definitionSubmissionKey: null, interpretation: null, definitionId: null, definitionInput: null, error: null, ...options,
  }
  const model = { data: { definitions: [], occurrences: [], creations: [creation] }, pendingCreations: [],
    cancellingCreations: cancelling ? [creation.id] : [] } as unknown as ScheduledTasksModel
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try {
    return renderToStaticMarkup(<FeedbackProvider><ScheduledCreationList model={model} onResume={() => {}} onOpen={() => {}} /></FeedbackProvider>)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'React', previous)
    else Reflect.deleteProperty(globalThis, 'React')
  }
}

test('conversation drafts expose continuation on the title and next to cancel', () => {
  for (const stage of ['failed', 'needs_input', 'blocked'] as const) {
    const html = render(stage)
    assert.match(html, /<button[^>]*aria-label="继续创建：定时工作"/)
    assert.match(html, /取消创建<\/button><button[^>]*>.*继续创建<\/button>/)
  }
})

test('working and finished records cannot continue, and cancellation disables both entries', () => {
  for (const stage of ['parsing', 'completed', 'cancelled'] as const) assert.doesNotMatch(render(stage), /继续创建/)
  assert.doesNotMatch(render('needs_confirmation', { confirmationOutcome: 'pending' }), /继续创建/)
  const cancelling = render('needs_input', {}, true)
  assert.match(cancelling, /aria-label="继续创建：定时工作"[^>]*disabled/)
  assert.match(cancelling, /正在取消…<\/button><button[^>]*disabled[^>]*>.*继续创建<\/button>/)
})
