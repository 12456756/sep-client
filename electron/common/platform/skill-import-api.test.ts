import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { SkillImportApi, SkillImportApiError } from './skill-import-api'

test('import transport uses only the configured HTTPS instance and explicit grant', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const api = new SkillImportApi('https://sep.example/api', (async (url, init) => {
    requests.push({ url: String(url), init: init! })
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)
  await api.request('POST', 'pairings', z.object({ ok: z.boolean() }).strict(), { signal: new AbortController().signal, body: { sessionId: 'session' } })
  await api.request('GET', 'sessions/session/commands?cursor=0', z.object({ ok: z.boolean() }).strict(), { signal: new AbortController().signal, token: 'import-only' })
  assert.equal(requests[0]!.url, 'https://sep.example/api/skill-import/connector/pairings')
  assert.equal(requests[0]!.init.redirect, 'error')
  assert.equal(requests[0]!.init.credentials, 'omit')
  assert.equal(new Headers(requests[0]!.init.headers).get('authorization'), null)
  assert.equal(new Headers(requests[1]!.init.headers).get('authorization'), 'Bearer import-only')
  for (const base of ['http://sep.example/api', 'https://name:secret@sep.example/api', 'https://sep.example/api?token=secret']) assert.throws(() => new SkillImportApi(base), /UNTRUSTED_INSTANCE/)
  await assert.rejects(api.request('GET', '../secrets', z.unknown(), { signal: new AbortController().signal }), /INVALID_ARGUMENT/)
})

test('content requests and responses have no client byte quota while validation and Retry-After remain enforced', async () => {
  const signal = new AbortController().signal
  const content = 'x'.repeat(17 * 1024 * 1024)
  const large = new SkillImportApi('https://sep.example/api', (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).content, content)
    return new Response(JSON.stringify({ content }))
  }) as typeof fetch)
  assert.deepEqual(await large.request('POST', 'sessions/session/events', z.object({ content: z.string() }), { signal, body: { content }, contentResponse: true }), { content })
  const escaped = new SkillImportApi('https://sep.example/api', (async () => new Response('{}')) as typeof fetch)
  await assert.rejects(escaped.request('POST', 'pairings', z.unknown(), { signal, body: { content: '\u0001'.repeat(200000) } }), /REQUEST_BODY_TOO_LARGE/)
  const rate = new SkillImportApi('https://sep.example/api', (async () => new Response(JSON.stringify({ code: 'RATE_LIMITED', message: 'secret ignored' }), { status: 429, headers: { 'Retry-After': '8' } })) as typeof fetch)
  await assert.rejects(rate.request('GET', 'pairings', z.unknown(), { signal }), error => {
    assert.ok(error instanceof SkillImportApiError)
    assert.equal(error.retryAfterMs, 8000)
    assert.equal(error.retryable, true)
    assert.doesNotMatch(error.message, /secret/)
    return true
  })
  const invalid = new SkillImportApi('https://sep.example/api', (async () => new Response('{"grant":"secret"}')) as typeof fetch)
  await assert.rejects(invalid.request('GET', 'pairings', z.object({ ok: z.boolean() }).strict(), { signal }), /INVALID_RESPONSE/)
})

test('multipart upload streams the same bytes with only its upload grant', async () => {
  let streamed = ''
  const api = new SkillImportApi('https://sep.example/api', (async (url, init) => {
    assert.equal(String(url), 'https://sep.example/api/skill-import/connector/sessions/session/package?operationId=operation')
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer upload-only')
    for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>) streamed += Buffer.from(chunk).toString()
    assert.equal(Number(new Headers(init!.headers).get('content-length')), Buffer.byteLength(streamed))
    return new Response('{"ok":true}')
  }) as typeof fetch)
  await api.upload('session', 'operation', 'upload-only', { bytes: 6, async *open() { yield Buffer.from('zip'); yield Buffer.from('123') } }, z.object({ ok: z.boolean() }).strict(), new AbortController().signal)
  assert.match(streamed, /name="file"; filename="skill.zip"/)
  assert.match(streamed, /zip123/)
})

test('non-JSON errors retain HTTP retry information without retrying client errors', async () => {
  for (const status of [400, 429, 503]) {
    const api = new SkillImportApi('https://sep.example/api', (async () => new Response('<html>Temporarily unavailable</html>', {
      status, headers: { 'Retry-After': '2' },
    })) as typeof fetch)
    await assert.rejects(api.request('GET', 'pairings', z.unknown(), { signal: new AbortController().signal }), error => {
      assert.ok(error instanceof SkillImportApiError)
      assert.equal(error.status, status)
      assert.equal(error.retryable, status !== 400)
      assert.equal(error.retryAfterMs, 2000)
      assert.doesNotMatch(error.message, /html|Temporarily/)
      return true
    })
  }
})

test('malformed successful responses remain invalid even when the response schema accepts unknown', async () => {
  const api = new SkillImportApi('https://sep.example/api', (async () => new Response('<html>Invalid API response</html>', {
    headers: { 'Retry-After': '2' },
  })) as typeof fetch)
  await assert.rejects(api.request('GET', 'pairings', z.unknown(), { signal: new AbortController().signal }), error => {
    assert.ok(error instanceof SkillImportApiError)
    assert.equal(error.code, 'INVALID_RESPONSE')
    assert.equal(error.status, 200)
    assert.equal(error.retryable, false)
    assert.equal(error.retryAfterMs, 0)
    return true
  })
})

test('connector retains nested validation evidence, independent IDs and redacts grant/signature echoes', async () => {
  const api = new SkillImportApi('https://sep.example/api', async () => new Response(JSON.stringify({
    error: { code: 'PACKAGE_REJECTED', message: ['Invalid digest', 'grant-value proof-value'], retryable: false },
    signature: 'other-signature', sessionGrant: 'other-grant', uploadGrant: 'upload-secret',
  }), { status: 422, headers: { 'x-request-id': 'sep-1', 'x-compute-request-id': 'compute-2', 'x-upstream-request-id': 'upstream-3', 'x-sep-execution-id': 'exec-4' } }))
  await assert.rejects(api.request('POST', 'grants', z.unknown(), {
    token: 'grant-value', body: { signature: 'proof-value' }, signal: new AbortController().signal,
  }), error => {
    assert.ok(error instanceof SkillImportApiError)
    assert.equal(error.code, 'PACKAGE_REJECTED')
    assert.match(error.diagnostic!.message!, /Invalid digest/)
    assert.equal(error.diagnostic!.sepRequestId, 'sep-1')
    assert.equal(error.diagnostic!.computeRequestId, 'compute-2')
    assert.equal(error.diagnostic!.upstreamRequestId, 'upstream-3')
    assert.equal(error.diagnostic!.executionId, 'exec-4')
    assert.doesNotMatch(JSON.stringify(error), /grant-value|proof-value|other-signature|other-grant|upload-secret/)
    return true
  })
})

test('409 conflicts and unknown 410 errors cannot request infinite retry', async () => {
  for (const status of [409, 410]) {
    const api = new SkillImportApi('https://sep.example/api', async () => new Response(JSON.stringify({
      code: 'NEW_SERVER_CODE', message: 'Snapshot no longer matches', retryable: true,
    }), { status }))
    await assert.rejects(api.request('GET', 'sessions/id/commands', z.unknown(), { signal: new AbortController().signal }), error => {
      assert.ok(error instanceof SkillImportApiError)
      assert.equal(error.status, status)
      assert.equal(error.retryable, false)
      assert.equal(error.diagnostic!.message, 'Snapshot no longer matches')
      return true
    })
  }
})

test('202 pending confirmation is normal, and retry hints come from actual headers or body', async () => {
  const pending = { status: 'pending-web-confirmation', pairingId: 'pairing-1' }
  const api = new SkillImportApi('https://sep.example/api', async () => new Response(JSON.stringify(pending), { status: 202 }))
  assert.deepEqual(await api.request('POST', 'grants', z.unknown(), { signal: new AbortController().signal }), pending)
  for (const [body, headers, delay] of [
    [{ error: { retryAfterSeconds: 2.5 } }, {}, 2500],
    [{ retryAfterSeconds: 2 }, { 'retry-after': '0.5' }, 500],
    [{ code: 1234, message: 'Busy' }, {}, 0],
    [{ retryAfterSeconds: 1e308 }, {}, 0],
  ] as const) {
    const rate = new SkillImportApi('https://sep.example/api', async () => new Response(JSON.stringify(body), { status: 429, headers }))
    await assert.rejects(rate.request('POST', 'grants', z.unknown(), { signal: new AbortController().signal }), error => {
      assert.ok(error instanceof SkillImportApiError)
      assert.equal(error.retryAfterMs, delay)
      if ('code' in body) assert.equal(error.diagnostic!.code, 1234)
      return true
    })
  }
})

test('HTTP error evidence survives truncated or aborted bodies without waiting for cancellation', async () => {
  for (const truncated of [true, false]) {
    const abort = new AbortController()
    const api = new SkillImportApi('https://sep.example/api', async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(truncated ? 'x'.repeat(300000) : 'partial reason'))
        if (!truncated) setImmediate(() => abort.abort(new Error('read stopped')))
      },
      cancel() { return new Promise(() => {}) },
    }), { status: 503, headers: { 'x-request-id': 'partial-id' } }))
    await assert.rejects(api.request('GET', 'pairings', z.unknown(), { signal: abort.signal }), error => {
      assert.ok(error instanceof SkillImportApiError)
      assert.equal(error.status, 503)
      assert.equal(error.diagnostic!.sepRequestId, 'partial-id')
      if (truncated) assert.equal(error.diagnostic!.truncated, true)
      else assert.match(error.diagnostic!.readError!, /read stopped/)
      return true
    })
  }
})

test('connector connection failures retain transport evidence without an invented HTTP response', async () => {
  const api = new SkillImportApi('https://sep.example/api', async () => { throw new TypeError('grant-value', { cause: new Error('DNS unavailable') }) })
  await assert.rejects(api.request('GET', 'pairings', z.unknown(), { token: 'grant-value', signal: new AbortController().signal }), error => {
    assert.ok(error instanceof SkillImportApiError)
    assert.equal(error.diagnostic!.httpStatus, undefined)
    assert.match(JSON.stringify(error.diagnostic), /DNS unavailable/)
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /grant-value/)
    return true
  })
})

test('a successful HTTP header followed by body failure retains the received status and partial body', async () => {
  let reads = 0
  const api = new SkillImportApi('https://sep.example/api', async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(Buffer.from('{"partial":"kept"'))
      else controller.error(new TypeError('terminated'))
    },
  }, { highWaterMark: 0 }), { headers: { 'x-request-id': 'received-headers' } }))
  await assert.rejects(api.request('GET', 'pairings', z.unknown(), { signal: new AbortController().signal }), error => {
    assert.ok(error instanceof SkillImportApiError)
    assert.equal(error.status, 200)
    assert.equal(error.diagnostic!.httpStatus, 200)
    assert.match(String(error.diagnostic!.body), /partial/)
    assert.equal(error.diagnostic!.sepRequestId, 'received-headers')
    assert.match(JSON.stringify(error.diagnostic!.transportError), /terminated/)
    return true
  })
})
