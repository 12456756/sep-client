import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { FeedbackController } from './feedback-controller'

it('validates prompt input, keeps it through failure and executes a silent success once', async () => {
  const feedback = new FeedbackController()
  const values: string[] = []
  const promise = feedback.confirm({ message: 'rename', actionLabel: 'save', busyLabel: 'saving',
    input: { label: 'name', value: 'original', maxLength: 100 },
    validate: value => value.trim() ? null : 'name required',
    onConfirm: async value => { values.push(value); return { success: true } },
  })
  const id = feedback.getSnapshot()!.id
  feedback.setInput(id, '  ')
  await feedback.accept(id)
  assert.equal(feedback.getSnapshot()?.validationMessage, 'name required')
  assert.deepEqual(values, [])
  feedback.setInput(id, 'renamed')
  await feedback.accept(id)
  assert.equal(await promise, true)
  assert.deepEqual(values, ['renamed'])
  assert.equal(feedback.getSnapshot(), null)
})

it('permission confirmations settle directly without generating a success popup', async () => {
  const feedback = new FeedbackController()
  const permission = feedback.ask({ message: 'microphone?', actionLabel: 'allow' })
  await feedback.accept(feedback.getSnapshot()!.id)
  assert.equal(await permission, true)
  assert.equal(feedback.getSnapshot(), null)
  const abort = new AbortController()
  feedback.show({ tone: 'error', message: 'earlier error' })
  const canceled = feedback.ask({ message: 'queued consent', actionLabel: 'allow', signal: abort.signal })
  abort.abort()
  assert.equal(await canceled, false)
  assert.equal(feedback.getSnapshot()?.message, 'earlier error')
  feedback.dismiss(feedback.getSnapshot()!.id)
  assert.equal(feedback.getSnapshot(), null)
})

it('deduplicates, queues and ignores a stale close', () => {
  const feedback = new FeedbackController()
  feedback.show({ message: 'first', tone: 'error' })
  const first = feedback.getSnapshot()!
  feedback.show({ message: 'first', tone: 'error' })
  feedback.show({ message: 'second', tone: 'success' })
  feedback.dismiss(first.id)
  assert.equal(feedback.getSnapshot()?.message, 'second')
  feedback.dismiss(first.id)
  assert.equal(feedback.getSnapshot()?.message, 'second')
  feedback.dismiss(feedback.getSnapshot()!.id)
  assert.equal(feedback.getSnapshot(), null)
})

it('does not repeat a persistent background failure after dismissal until session reset', () => {
  const feedback = new FeedbackController()
  feedback.show({ key: 'poll:job', message: 'failed', tone: 'error', once: true })
  feedback.dismiss(feedback.getSnapshot()!.id)
  feedback.show({ key: 'poll:job', message: 'failed', tone: 'error', once: true })
  assert.equal(feedback.getSnapshot(), null)
  feedback.clear()
  feedback.show({ key: 'poll:job', message: 'failed', tone: 'error', once: true })
  assert.equal(feedback.getSnapshot()?.message, 'failed')
})

it('settles canceled confirmations and fences in-flight actions across session reset', async () => {
  const feedback = new FeedbackController()
  let finish!: () => void
  let calls = 0
  const promise = feedback.confirm({ message: 'remove?', actionLabel: 'remove', busyLabel: 'removing', onConfirm: async () => {
    calls++
    await new Promise<void>(resolve => { finish = resolve })
    return { success: true, message: 'removed' }
  } })
  const id = feedback.getSnapshot()!.id
  const action = feedback.accept(id)
  await feedback.accept(id)
  feedback.dismiss(id)
  assert.equal(feedback.getSnapshot()?.busy, true)
  assert.equal(calls, 1)
  feedback.clear()
  assert.equal(await promise, false)
  feedback.show({ message: 'new session', tone: 'error' })
  finish()
  await action
  assert.equal(feedback.getSnapshot()?.message, 'new session')
  const canceled = feedback.confirm({ message: 'queued?', actionLabel: 'remove', busyLabel: 'removing', onConfirm: async () => { throw new Error('must not run') } })
  feedback.clear()
  assert.equal(await canceled, false)
})

it('replaces a failed confirmation in place and keeps queued prompts behind it', async () => {
  const feedback = new FeedbackController()
  const confirmation = feedback.confirm({ message: 'remove?', actionLabel: 'remove', busyLabel: 'removing', onConfirm: async () => ({ success: false, message: 'remove failed' }) })
  const id = feedback.getSnapshot()!.id
  feedback.show({ message: 'later', tone: 'success' })
  await feedback.accept(id)
  assert.equal(await confirmation, false)
  assert.equal(feedback.getSnapshot()?.id, id)
  assert.equal(feedback.getSnapshot()?.tone, 'error')
  assert.equal(feedback.getSnapshot()?.message, 'remove failed')
})
