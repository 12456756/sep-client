import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSpeechPermission } from './speech-permission-state'

test('uses the authoritative permission returned by the main process', () => {
  assert.equal(resolveSpeechPermission({ data: { permission: 'denied' } }, 'prompt'), 'denied')
  assert.equal(resolveSpeechPermission({ data: { permission: 'granted' } }, 'denied'), 'granted')
})

test('does not infer microphone permission from a malformed or missing response', () => {
  assert.equal(resolveSpeechPermission({}, 'prompt'), 'prompt')
  assert.equal(resolveSpeechPermission({ data: { permission: 'unexpected' } }, 'denied'), 'denied')
  assert.equal(resolveSpeechPermission({}, null), 'prompt')
})
