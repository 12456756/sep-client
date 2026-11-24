import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getCurrentRelease } from './current-release'

test('current version notes never use a different bundled version', () => {
  const release = { version: '0.5.9', notes: '### 1. Changes\nDetails' }
  assert.deepEqual(getCurrentRelease('0.5.9', release), release)
  assert.equal(getCurrentRelease('0.6.0', release), null)
  assert.equal(getCurrentRelease('0.5.9', null), null)
  assert.equal(getCurrentRelease('0.5.9', { ...release, notes: '  ' }), null)
})
