import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { retryFileOperation } from './retry-file-operation'

test('retries temporary local I/O failures and returns the verified result', async () => {
  let attempts = 0
  const value = await retryFileOperation(async () => {
    if (++attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return 'saved'
  }, new AbortController().signal)
  assert.equal(value, 'saved')
  assert.equal(attempts, 3)
})

test('does not retry permissions, full disks, unsafe paths or model validation failures', async () => {
  for (const code of ['EACCES', 'ENOSPC', 'UNSAFE_PATH', 'MEDIA_MIME_MISMATCH', 'AUTH_REQUIRED']) {
    let attempts = 0
    const error = Object.assign(new Error(code), { code })
    await assert.rejects(retryFileOperation(async () => { attempts++; throw error }, new AbortController().signal), value => value === error)
    assert.equal(attempts, 1)
  }
})

test('stops local I/O retry delays immediately when cancelled', async () => {
  const controller = new AbortController()
  let attempts = 0
  const reason = new Error('Stopped')
  const result = retryFileOperation(async () => { attempts++; throw new Error('FILE_CHANGED') }, controller.signal)
  controller.abort(reason)
  await assert.rejects(result)
  assert.equal(attempts, 1)
})
