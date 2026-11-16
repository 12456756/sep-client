import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { transportKind } from './transport-error'

test('classifies nested and aggregate transport failures with timeout taking priority', () => {
  assert.equal(transportKind(new TypeError('fetch failed')), 'network')
  assert.equal(transportKind(new TypeError('Failed to fetch')), 'network')
  assert.equal(transportKind(new Error('request', { cause: { code: 'ETIMEDOUT' } })), 'timeout')
  assert.equal(transportKind(new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }])), 'timeout')
  assert.equal(transportKind({ code: 'ENOTFOUND' }), 'network')
})

test('does not classify programming errors, cancellation or cyclic unknown causes as transport failures', () => {
  assert.equal(transportKind(new TypeError('Cannot read properties of undefined')), null)
  assert.equal(transportKind(new DOMException('cancelled', 'AbortError')), null)
  const error = new Error('unknown')
  error.cause = error
  assert.equal(transportKind(error), null)
})
