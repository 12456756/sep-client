import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { parseRetryAfter, readApiDiagnostic, safeApiDiagnostic, transportApiDiagnostic } from './api-diagnostic'

const json = (body: unknown, status = 400, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

describe('platform error diagnostics', () => {
  it('keeps validation reasons, unknown fields and actual HTTP authority', async () => {
    const body = { statusCode: 500, message: 'Invalid parameters',
      error: { code: 'invalid_parameter', message: 'Invalid parameters', reason: 'Expected number', field: 'requestedSpec.count', retryable: false },
      errors: [{ field: 'requestedSpec.count', message: 'Expected number' }], extra: { width: 1300 } }
    const result = await readApiDiagnostic(json(body), 'image-quote')
    assert.equal(result.httpStatus, 400)
    assert.equal(result.operation, 'image-quote')
    assert.equal(result.code, 'invalid_parameter')
    assert.equal(result.field, 'requestedSpec.count')
    assert.equal(result.retryable, false)
    assert.match(result.message!, /requestedSpec.count: Expected number/)
    assert.deepEqual(result.body, body)
  })

  for (const body of [null, false, 42, ['first reason', { code: 123, message: 'Second reason' }],
    { error: 'Generation rejected' }, { code: 123, message: 'Unsupported image dimensions' }]) {
    it(`accepts JSON ${JSON.stringify(body)}`, async () => {
      const result = await readApiDiagnostic(json(body))
      assert.deepEqual(result.body, body)
      assert.ok(result.message)
      if (body === null || typeof body === 'boolean' || typeof body === 'number') assert.equal(result.message, '未返回可读原因')
    })
  }

  it('reads plain text and unwraps diagnostic bodies without discarding the wrapper', async () => {
    const plain = await readApiDiagnostic(new Response('Stale client run', { status: 409 }))
    assert.equal(plain.message, 'Stale client run')
    const body = { body: { error: { code: 123, message: 'Image edit denied' } }, upstreamStatus: 200, readError: 'Body stream failed', truncated: true }
    const result = await readApiDiagnostic(json(body, 502))
    assert.equal(result.code, 123)
    assert.match(result.message!, /Image edit denied/)
    assert.deepEqual(result.body, body)
  })

  it('preserves independent association IDs and only diagnostic response headers', async () => {
    const result = await readApiDiagnostic(json({ requestId: 'body-id', sepRequestId: 'body-sep', message: 'Invalid API key' }, 401, {
      'X-Request-ID': 'sep-id', 'X-Compute-Request-ID': 'compute-id', 'X-Upstream-Request-ID': 'provider-id',
      'X-Client-Request-ID': 'client-id', 'X-Compute-Status': '200', 'X-SEP-Execution-ID': 'execution-id',
      'X-SEP-Error-Source': 'upstream', 'Retry-After': '5', 'Set-Cookie': 'private-cookie', Authorization: 'Bearer private-bearer',
    }))
    assert.equal(result.source, 'upstream')
    assert.equal(result.sepRequestId, 'sep-id')
    assert.equal(result.computeRequestId, 'compute-id')
    assert.equal(result.upstreamRequestId, 'provider-id')
    assert.equal(result.clientRequestId, 'client-id')
    assert.equal(result.executionId, 'execution-id')
    assert.equal(result.computeStatus, 200)
    assert.equal(result.headers?.['retry-after'], '5')
    assert.equal((result.body as { requestId: string }).requestId, 'body-id')
    assert.doesNotMatch(JSON.stringify(result), /private-cookie|private-bearer/)
  })

  it('keeps partial bytes and records a body read error', async () => {
    let reads = 0
    const result = await readApiDiagnostic(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) controller.enqueue(Buffer.from('Provider rejected input'))
        else controller.error(new Error('connection reset Bearer private-token'))
      },
    }), { status: 502 }))
    assert.equal(result.body, 'Provider rejected input')
    assert.match(result.readError!, /connection reset/)
    assert.doesNotMatch(result.readError!, /private-token/)
  })

  it('retains evidence with a mismatched byte count without accepting it as complete JSON', async () => {
    const result = await readApiDiagnostic(json({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' }, 402, { 'Content-Length': '1' }))
    assert.match(result.readError ?? '', /length mismatch/)
    assert.equal(typeof result.body, 'string')
    assert.equal(result.code, undefined)
  })

  it('does not compare automatically decoded bytes to the compressed content length', async () => {
    const result = await readApiDiagnostic(json({ message: 'Specific rejection' }, 400, { 'Content-Length': '1', 'Content-Encoding': 'gzip' }))
    assert.equal(result.readError, undefined)
    assert.deepEqual(result.body, { message: 'Specific rejection' })
  })

  it('bounds an error body without waiting for stream cancellation', async () => {
    let cancelled = false
    const result = await readApiDiagnostic(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('Too long error body')) },
      cancel() { cancelled = true; return new Promise(() => {}) },
    }), { status: 502 }), undefined, { maxBytes: 8 })
    assert.equal(result.body, 'Too long')
    assert.equal(result.truncated, true)
    assert.equal(cancelled, true)
  })

  it('bounds a stalled body read and keeps the evidence already received', async () => {
    const result = await readApiDiagnostic(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('Partial failure')) },
    }), { status: 502 }), undefined, { timeoutMs: 10 })
    assert.equal(result.body, 'Partial failure')
    assert.match(result.readError!, /timed out/)
  })

  it('redacts credentials and signed URLs throughout arrays and unknown fields', async () => {
    const result = await readApiDiagnostic(json({ message: 'Denied Bearer bearer-secret',
      secret: 'hidden-secret', refreshToken: 'refresh-secret', details: [{ apiKey: 'key-secret',
        message: 'https://objects.invalid/file?X-Amz-Signature=signed-secret', detail: 'Cookie: session=cookie-secret' }] }))
    assert.match(result.message!, /Denied/)
    assert.ok(Array.isArray((result.body as { details: unknown[] }).details))
    assert.doesNotMatch(JSON.stringify(result), /bearer-secret|hidden-secret|refresh-secret|key-secret|signed-secret|cookie-secret|https:/)
  })

  it('redacts known credentials before truncating strings at the evidence boundary', () => {
    const secret = 'opaque-credential-that-crosses-the-size-boundary'
    const result = safeApiDiagnostic({ body: { message: `${'x'.repeat(8180)}${secret}` },
      headers: { 'x-request-id': secret } }, [secret])!
    assert.doesNotMatch(JSON.stringify(result), /opaque-credential|crosses-the-size-boundary/)
    assert.equal(result.headers?.['x-request-id'], '[redacted]')
  })

  it('retains evidence when optional remote metadata has unexpected types', async () => {
    const body = { message: 'Useful reason', code: 'new_code', field: {}, stage: false, requestId: [], retryable: 'yes' }
    const result = await readApiDiagnostic(json(body))
    assert.equal(result.message, 'Useful reason')
    assert.deepEqual(result.body, body)
    assert.equal(result.field, undefined)
  })

  it('marks diagnostic size limits and revalidates explicit diagnostics', () => {
    const result = safeApiDiagnostic({ body: { details: Array.from({ length: 51 }, () => ({ reason: 'Useful' })) },
      headers: { authorization: 'Bearer private', 'X-Request-ID': 'sep-id' }, unknown: 'discarded' })!
    assert.equal(result.truncated, true)
    assert.equal((result.body as { details: unknown[] }).details.length, 50)
    assert.deepEqual(result.headers, { 'x-request-id': 'sep-id' })
    assert.doesNotMatch(JSON.stringify(result), /private|discarded/)
  })

  it('keeps transport causes without fabricating an HTTP response', () => {
    const result = transportApiDiagnostic(new TypeError('fetch failed', { cause: Object.assign(new Error('DNS failure'), { code: 'ENOTFOUND' }) }), 'subscriptions')
    assert.equal(result.httpStatus, undefined)
    assert.match(JSON.stringify(result.transportError), /DNS failure|ENOTFOUND/)
    assert.doesNotMatch(JSON.stringify(result), /stack/)
  })

  it('parses Retry-After seconds and dates and rejects malformed numeric hints', () => {
    const now = Date.UTC(2026, 10, 18)
    assert.equal(parseRetryAfter('3', now), 3000)
    assert.equal(parseRetryAfter('0', now), 0)
    assert.equal(parseRetryAfter(new Date(now + 5000).toUTCString(), now), 5000)
    for (const value of [null, '', '-1', '1e3', 'Infinity']) assert.equal(parseRetryAfter(value, now), undefined)
  })
})
