import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { FeedbackController } from './feedback-controller'
import { createRuntimeFailureListener, RUNTIME_FAILURE_EVENT } from './runtime-feedback'
import type { TaskExecutionEvent } from './types'

const owner = { memberId: 'member', enterpriseId: 'enterprise' }
function event(runId = 'run'): TaskExecutionEvent {
  return { taskId: 'task', runId, subscriptionId: 'employee', type: RUNTIME_FAILURE_EVENT, sequence: 0,
    occurredAt: Date.now(), data: { owner, code: 'MODEL_TIMEOUT' } }
}

it('only displays final failures and remembers a dismissed run across route changes', () => {
  const feedback = new FeedbackController()
  const listener = createRuntimeFailureListener(feedback, owner)
  for (const type of ['session_error', 'auto_retry_start', 'auto_retry_end', 'arrangement_node_failed', 'arrangement_state_changed']) {
    listener.receive({ ...event(), type })
    assert.equal(feedback.getSnapshot(), null)
  }
  listener.receive(event())
  assert.equal(feedback.getSnapshot()?.message, '模型请求超时，请稍后重试')
  feedback.dismiss(feedback.getSnapshot()!.id)
  listener.receive(event())
  assert.equal(feedback.getSnapshot(), null)
  listener.receive(event('new-run'))
  assert.equal(feedback.getSnapshot()?.tone, 'error')
})

it('rejects wrong owners, cleared sessions, disposed listeners and arbitrary error content', () => {
  const feedback = new FeedbackController()
  const listener = createRuntimeFailureListener(feedback, owner)
  listener.receive({ ...event(), data: { owner: { ...owner, memberId: 'other' }, code: 'MODEL_TIMEOUT' } })
  listener.receive({ ...event(), data: { owner: { ...owner, enterpriseId: 'other' }, code: 'MODEL_TIMEOUT' } })
  listener.receive({ ...event(), data: { owner, code: 'private upstream text' } })
  listener.receive({ ...event(), occurredAt: 1 })
  assert.equal(feedback.getSnapshot(), null)
  feedback.clear()
  listener.receive(event())
  assert.equal(feedback.getSnapshot(), null)
  const next = createRuntimeFailureListener(feedback, owner)
  next.dispose()
  next.receive(event())
  assert.equal(feedback.getSnapshot(), null)
})
