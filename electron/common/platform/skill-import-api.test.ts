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

test('response validation, escaped JSON budgets, and Retry-After remain bounded', async () => {
  const signal = new AbortController().signal
  const limited = new SkillImportApi('https://sep.example/api', (async () => new Response('{"ok":true}', { headers: { 'content-length': '20000000' } })) as typeof fetch)
  await assert.rejects(limited.request('GET', 'pairings', z.unknown(), { signal }), /RESPONSE_TOO_LARGE/)
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
