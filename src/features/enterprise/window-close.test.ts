import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeedbackController } from '../../shared/feedback-controller'
import type { WindowCloseCommand } from '../../shared/window-close'
import { confirmWindowClose } from './window-close'

test('close prompt offers both actions and only a confirmed, checked choice is remembered', async () => {
  const feedback = new FeedbackController()
  const sent: WindowCloseCommand[] = []
  let changes = 0
  const confirm = (requestId: number) => confirmWindowClose(feedback, async command => {
    sent.push(command)
    return { success: true }
  }, requestId, () => { changes++ })

  const cancel = confirm(1)
  const first = feedback.getSnapshot()!
  assert.equal(first.actionLabel, '最小化')
  assert.equal(first.alternateLabel, '直接退出')
  assert.equal(first.cancelPlacement, 'corner')
  assert.deepEqual(first.checkbox, { label: '不再提示', checked: false })
  feedback.setChecked(first.id, true)
  feedback.dismiss(first.id)
  await cancel

  const minimize = confirm(2)
  const second = feedback.getSnapshot()!
  assert.equal(second.checkbox?.checked, false)
  await feedback.accept(second.id)
  await minimize

  const quit = confirm(3)
  const third = feedback.getSnapshot()!
  feedback.setChecked(third.id, true)
  await feedback.accept(third.id, 'alternate')
  await quit
  assert.deepEqual(sent, [
    { type: 'resolve', requestId: 1, action: 'cancel', remember: false },
    { type: 'resolve', requestId: 2, action: 'minimize', remember: false },
    { type: 'resolve', requestId: 3, action: 'quit', remember: true },
  ])
  assert.equal(changes, 1)
})
