import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSpeechPermission } from './speech-permission-state'

test('uses the authoritative permission returned by the main process', () => {
  assert.equal(resolveSpeechPermission({ data: { permission: 'denied' } }, true), 'denied')
  assert.equal(resolveSpeechPermission({ data: { permission: 'granted' } }, false), 'granted')
})

test('keeps a successful enable action selected when the response omits permission data', () => {
  assert.equal(resolveSpeechPermission({}, true), 'granted')
  assert.equal(resolveSpeechPermission({}, false), 'denied')
})
