import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { describeError, redactModelTraceText, redactOptionalText, redactText, redactValue } from './redact'

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

  it('preserves only safe numeric thinking estimates while still hiding credentials', () => {
    assert.deepEqual(redactValue({ estimatedThinkingTokens: 4096, accessToken: 123456 }), {
      estimatedThinkingTokens: 4096, accessToken: '[redacted]',
    })
    assert.deepEqual(redactValue({ estimatedThinkingTokens: 0 }), { estimatedThinkingTokens: 0 })
    for (const value of ['Bearer private', '4096', -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, { token: 'private' }]) {
      assert.deepEqual(redactValue({ estimatedThinkingTokens: value }), { estimatedThinkingTokens: '[redacted]' })
    }
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

  it('keeps schema-bounded tool data intact with local limits while preserving credential redaction', () => {
    const values = Array.from({ length: 128 }, (_, index) => `${1024 + index}x1024`)
    const value = { capabilities: { profiles: [{ capabilityHints: [{ field: 'size', values,
      source: 'Bearer private-token', apiKey: 'private-key' }] }] } }
    assert.match(JSON.stringify(redactValue(value)), /max-depth/)
    const expected = { capabilities: { profiles: [{ capabilityHints: [{ field: 'size', values,
      source: 'Bearer [redacted]', apiKey: '[redacted]' }] }] } }
    assert.deepEqual(redactValue(value, 0, '', { maxDepth: 8, maxArrayLength: 128 }), expected)
    assert.equal((redactValue(values) as unknown[]).length, 50)
    assert.equal((redactValue([...values, 'extra'], 0, '', { maxArrayLength: 128 }) as unknown[]).length, 128)
    let deep: unknown = { apiKey: 'private-deep-key' }
    for (let level = 0; level < 10; level++) deep = { nested: deep }
    const bounded = JSON.stringify(redactValue(deep, 0, '', { maxDepth: 8 }))
    assert.match(bounded, /max-depth/)
    assert.doesNotMatch(bounded, /private-deep-key/)
  })
})

describe('describeError', () => {
  it('renders errors as one redacted line', () => {
    assert.equal(describeError(new TypeError('Bearer abc')), 'TypeError: Bearer [redacted]')
    assert.equal(describeError('Bearer abc'), 'Bearer [redacted]')
    assert.equal(describeError(42), '42')
  })
})

describe('redactModelTraceText', () => {
  it('redacts complete raw HTTP authorization and cookie headers', () => {
    const text = 'HTTP/1.1 200 OK\r\nAuthorization: Basic PRIVATE_BASIC\r\nProxy-Authorization: Digest username="PRIVATE_USER", response="PRIVATE_DIGEST"\r\nCookie: session=PRIVATE_SESSION; csrf=PRIVATE_CSRF\r\nSet-Cookie: auth=PRIVATE_COOKIE; Path=/; HttpOnly\r\nBusiness result: keep this'
    const result = redactModelTraceText(text)
    assert.doesNotMatch(result, /PRIVATE_/)
    assert.match(result, /Business result: keep this/)
  })

  it('redacts hyphenated credentials in serialized or query text', () => {
    const text = '{"x-api-key":"PRIVATE_API","refresh-token":"PRIVATE_REFRESH","access-token":"PRIVATE_ACCESS"}\nhttps://example.test/?id_token=PRIVATE_ID&x-api-key=PRIVATE_KEY'
    assert.doesNotMatch(redactModelTraceText(text), /PRIVATE_/)
  })
})

