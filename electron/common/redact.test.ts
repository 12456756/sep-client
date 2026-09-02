import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { describeError, redactOptionalText, redactText, redactValue } from './redact'

describe('redactText', () => {
  it('strips bearer tokens', () => {
    assert.equal(
      redactText('request failed: Authorization: Bearer abc.def.ghi; retrying'),
      'request failed: Authorization: Bearer [redacted]; retrying',
    )
  })

  it('strips credentials from query strings', () => {
    assert.equal(
      redactText('GET /v1/items?page=2&token=secret-value&sort=asc'),
      'GET /v1/items?page=2&token=[redacted]&sort=asc',
    )
  })

  it('truncates runaway strings', () => {
    const redacted = redactText('x'.repeat(20_000))
    assert.ok(redacted.length < 20_000)
    assert.ok(redacted.endsWith('...[truncated]'))
  })
})

describe('redactOptionalText', () => {
  it('normalizes empty input to null', () => {
    assert.equal(redactOptionalText(undefined), null)
    assert.equal(redactOptionalText(''), null)
    assert.equal(redactOptionalText('plain'), 'plain')
  })
})

describe('redactValue', () => {
  it('replaces values whose key looks sensitive', () => {
    assert.deepEqual(
      redactValue({ accessToken: 'a', apiKey: 'b', Cookie: 'c', keep: 'd' }),
      { accessToken: '[redacted]', apiKey: '[redacted]', Cookie: '[redacted]', keep: 'd' },
    )
  })

  it('reaches into nested structures', () => {
    assert.deepEqual(
      redactValue({ outer: { headers: { authorization: 'Bearer x' } }, list: ['Bearer y'] }),
      { outer: { headers: { authorization: '[redacted]' } }, list: ['Bearer [redacted]'] },
    )
  })

  it('bounds depth, array length, and key count', () => {
    let deep: unknown = 'bottom'
    for (let level = 0; level < 8; level += 1) deep = { nested: deep }
    assert.equal(JSON.stringify(redactValue(deep)).includes('[max-depth]'), true)

    const long = redactValue(Array.from({ length: 200 }, (_unused, index) => index)) as unknown[]
    assert.equal(long.length, 50)

    const wide = Object.fromEntries(Array.from({ length: 200 }, (_unused, index) => [`k${index}`, index]))
    assert.equal(Object.keys(redactValue(wide) as object).length, 50)
  })

  it('drops values it cannot represent instead of leaking them', () => {
    assert.deepEqual(redactValue({ fn: () => undefined, ok: 1 }), { ok: 1 })
  })
})

describe('describeError', () => {
  it('renders errors as one redacted line', () => {
    assert.equal(describeError(new TypeError('Bearer abc')), 'TypeError: Bearer [redacted]')
    assert.equal(describeError('Bearer abc'), 'Bearer [redacted]')
    assert.equal(describeError(42), '42')
  })
})
