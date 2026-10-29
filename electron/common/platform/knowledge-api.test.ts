import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { KnowledgeApi, KnowledgeApiError } from './knowledge-api'
import { setLogSink, type LogRecord } from '../logger'

const requestId = 'c49b8f02-2143-4a61-9d62-459c2cb82193'
const noMatch = { status: 'NO_MATCH', results: [], actualStrategy: 'LEXICAL', degraded: false, partial: false, durationMs: 1 }
describe('knowledge platform adapter', () => {
  it('reads a versioned source through the authenticated source endpoint', async () => {
    let url = ''
    const source = { sourceId: 'source/a', knowledgeBaseId: 'kb/a', documentId: 'd', documentName: '制度.md', versionId: 'v1', content: '原文', location: {}, isCurrent: false }
    const api = new KnowledgeApi({ baseUrl: 'https://platform.test/api', getAccessToken: async () => 'token', fetch: async input => { url = String(input); return Response.json(source) } })
    assert.deepEqual(await api.execute({ requestId, action: 'source', kbId: 'kb/a', sourceId: 'source/a' }), source)
    assert.equal(url, 'https://platform.test/api/knowledge-bases/kb%2Fa/sources/source%2Fa')
  })
  it('returns cancellation for a pre-aborted call without looking up a token', async () => {
    let calls = 0
    const api = new KnowledgeApi({ getAccessToken: async () => { calls++; return 'token' } })
    await assert.rejects(api.execute({ requestId, action: 'search', query: 'policy', topK: 5 }, AbortSignal.abort()),
      (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 499)
    assert.equal(calls, 0)
  })
  it('does not wait indefinitely for an error stream to acknowledge cancellation', async () => {
    const controller = new AbortController()
    let reading!: () => void
    const started = new Promise<void>(resolve => { reading = resolve })
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => new Response(new ReadableStream({
      pull() { reading() }, cancel: () => new Promise(() => undefined),
    }), { status: 429 }) })
    const pending = api.execute({ requestId, action: 'search', query: 'policy', topK: 5 }, controller.signal)
    await started
    controller.abort()
    const outcome = await Promise.race([
      pending.then(() => 'success', error => error),
      new Promise(resolve => setTimeout(() => resolve('hung'), 100)),
    ])
    assert.ok(outcome instanceof KnowledgeApiError, 'cancelled error-body read must settle promptly')
    assert.equal(outcome.statusCode, 499)
  })
  it('times out a stalled 429 error body instead of sleeping and replaying it', async () => {
    let waits = 0
    const api = new KnowledgeApi({
      getAccessToken: async () => 'token', requestTimeoutMs: 10,
      fetch: async () => new Response(new ReadableStream(), { status: 429 }),
      sleep: async () => { waits++ },
    })
    const keepAlive = setTimeout(() => undefined, 1000)
    try {
      await assert.rejects(api.execute({ requestId, action: 'search', query: 'policy', topK: 5 }),
        (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 408)
      assert.equal(waits, 0)
    } finally { clearTimeout(keepAlive) }
  })
  it('bounds disposal of a 401 body before refreshing credentials', async () => {
    const controller = new AbortController()
    let cancelling!: () => void
    const started = new Promise<void>(resolve => { cancelling = resolve })
    let calls = 0
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => {
      calls++
      return new Response(new ReadableStream({ cancel: () => { cancelling(); return new Promise(() => undefined) } }), { status: 401 })
    } })
    const pending = api.execute({ requestId, action: 'search', query: 'policy', topK: 5 }, controller.signal)
    await started
    controller.abort()
    const outcome = await Promise.race([
      pending.then(() => 'success', error => error),
      new Promise(resolve => setTimeout(() => resolve('hung'), 100)),
    ])
    assert.ok(outcome instanceof KnowledgeApiError, '401 disposal must remain cancellable')
    assert.equal(outcome.statusCode, 499)
    assert.equal(calls, 1)
  })
  it('forces only one token refresh when a 401 is followed by a 429 retry', async () => {
    const refresh: boolean[] = []
    let calls = 0
    const api = new KnowledgeApi({
      getAccessToken: async force => { refresh.push(!!force); return 'token' }, sleep: async () => undefined,
      fetch: async () => {
        calls++
        return calls === 1 ? new Response('{}', { status: 401 }) : calls === 2 ? new Response('{}', { status: 429 }) : Response.json(noMatch)
      },
    })
    await api.execute({ requestId, action: 'search', query: 'policy', topK: 5 })
    assert.deepEqual(refresh, [false, true, false])
  })
  it('reads platform preview text as content and retains pagination and version lock', async () => {
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => Response.json({
      page: 2, pageSize: 20, total: 25, versionId: 'v1', documentName: 'guide.md',
      items: [{ chunkId: 'chunk', text: 'Preview body', location: { pageStart: null } }],
    }) })
    const result = await api.execute({ requestId, action: 'preview', kbId: 'kb', docId: 'doc', page: 2, pageSize: 20, versionId: 'v1' })
    assert.equal(result.items[0].content, 'Preview body')
    assert.equal(result.versionId, 'v1')
    assert.equal(result.page, 2)
    assert.equal(result.total, 25)
  })
  it('identifies invalid preview fields without logging document contents or credentials', async () => {
    const records: LogRecord[] = []
    const restore = setLogSink(record => records.push(record))
    try {
      const api = new KnowledgeApi({ getAccessToken: async () => 'private-token', fetch: async () => Response.json({
        page: 1, pageSize: 20, total: 1, versionId: 'v1', items: [{ text: 123, privateBody: 'private-document-body' }],
      }, { headers: { 'x-request-id': 'trace-preview' } }) })
      await assert.rejects(api.execute({ requestId, action: 'preview', kbId: 'kb', docId: 'doc', page: 1, pageSize: 20 }), (error: unknown) => {
        assert.ok(error instanceof KnowledgeApiError)
        assert.equal(error.platformCode, 'INVALID_RESPONSE')
        assert.equal(error.requestId, 'trace-preview')
        assert.match(error.message, /数据格式/)
        return true
      })
      const diagnostic = records.find(record => record.scope === 'sep' && record.message === 'knowledge response contract validation failed')
      assert.equal(diagnostic?.fields.action, 'preview')
      assert.equal(diagnostic?.fields.platformRequestId, 'trace-preview')
      assert.match(JSON.stringify(diagnostic?.fields), /items/)
      assert.doesNotMatch(JSON.stringify(records), /private-token|private-document-body/)
    } finally { restore() }
  })
  it('restores a Latin-1 decoded UTF-8 document name returned by the platform', async () => {
    const filename = '\u77e5\u8bc6\u5e93\u9a8c\u6536v1.md'
    const corrupted = Buffer.from(filename).toString('latin1')
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => Response.json([
      { id: 'doc', originalName: corrupted, status: 'READY', searchable: true },
    ]) })
    const result = await api.execute({ requestId, action: 'documents', kbId: 'kb' })
    assert.equal(result[0].originalName, filename)
  })
  for (const action of ['uploadDocument', 'replaceDocument'] as const) {
    for (const [filename, mimeType] of [
      ['guide.md', 'text/markdown'],
      ['\u77e5\u8bc6\u5e93\u9a8c\u6536.MD', 'text/markdown'],
      ['guide.txt', 'text/plain'],
      ['guide.pdf', 'application/pdf'],
      ['guide.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ]) {
      it(`${action} preserves ${filename} and sends ${mimeType} in the multipart file part`, async () => {
        const bytes = new TextEncoder().encode('# Test document\nTest content.')
        let uploaded: FormData | undefined
        let uploadUrl = ''
        let uploadInit: RequestInit | undefined
        const api = new KnowledgeApi({ baseUrl: 'https://platform.test/api', getAccessToken: async () => 'token',
          fetch: async (url, init) => {
            uploadUrl = String(url)
            uploadInit = init
            uploaded = await new Request(uploadUrl, init).formData()
            return Response.json({ id: 'doc', name: filename, status: 'PENDING', searchable: false }, { status: 202 })
          } })
        const file = { filename, bytes }
        const result = action === 'uploadDocument'
          ? await api.execute({ requestId, action, kbId: 'kb', idempotencyKey: requestId, file })
          : await api.execute({ requestId, action, kbId: 'kb', docId: 'doc', etag: '"version-1"', idempotencyKey: requestId, file })
        assert.equal(result.id, 'doc')
        const suffix = action === 'uploadDocument' ? '/documents/upload' : '/documents/doc/versions'
        assert.ok(uploadUrl.endsWith(suffix))
        assert.equal(new Headers(uploadInit?.headers).get('Content-Type'), null)
        assert.equal(new Headers(uploadInit?.headers).get('Idempotency-Key'), requestId)
        assert.equal(new Headers(uploadInit?.headers).get('If-Match'), action === 'replaceDocument' ? '"version-1"' : null)
        assert.ok(uploaded)
        assert.equal([...uploaded.keys()].length, 1)
        const uploadedFile = uploaded.get('file')
        assert.ok(uploadedFile && typeof uploadedFile !== 'string')
        assert.equal(uploadedFile.name, filename)
        assert.equal(uploadedFile.type, mimeType)
        assert.deepEqual(new Uint8Array(await uploadedFile.arrayBuffer()), bytes)
      })
    }
  }
  it('uses desktop credentials and trusted source, refreshes once on 401 and sends no subscription identity', async () => {
    const calls: RequestInit[] = []
    const refresh: boolean[] = []
    const api = new KnowledgeApi({ baseUrl: 'https://platform.test/api', webOrigin: 'https://platform.test',
      getAccessToken: async force => { refresh.push(!!force); return force ? 'new' : 'old' },
      fetch: async (_url, init) => { calls.push(init!); return calls.length === 1 ? new Response('{}', { status: 401 }) : Response.json(noMatch) } })
    assert.equal((await api.execute({ action: 'search', query: '差旅制度', requestId, topK: 5 })).status, 'NO_MATCH')
    assert.deepEqual(refresh, [false, true])
    const headers = new Headers(calls[1].headers)
    assert.equal(headers.get('Authorization'), 'Bearer new')
    assert.equal(headers.get('Origin'), 'https://platform.test')
    assert.equal(headers.get('Referer'), 'https://platform.test/')
    assert.deepEqual(JSON.parse(calls[1].body as string), { query: '差旅制度', topK: 5 })
  })
  it('accepts an empty successful authorization response', async () => {
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => new Response(null, { status: 204 }) })
    assert.equal(await api.execute({ requestId, action: 'grant', kbId: 'kb', memberIds: ['member-1'] }), undefined)
  })
  it('waits the full Retry-After with a cancellable signal and retains the same idempotency key', async () => {
    const calls: RequestInit[] = []; const delays: number[] = []
    const doc = { id: 'doc', name: 'a.md', status: 'PENDING', searchable: false }
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', sleep: async ms => { delays.push(ms) },
      fetch: async (_url, init) => { calls.push(init!); return calls.length === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '90' } }) : Response.json(doc, { status: 202 }) } })
    await api.execute({ requestId, action: 'uploadDocument', kbId: 'kb', idempotencyKey: requestId, file: { filename: 'a.md', bytes: new Uint8Array([65]) } })
    assert.deepEqual(delays, [90_000])
    for (const call of calls) {
      assert.equal(new Headers(call.headers).get('Idempotency-Key'), requestId)
      assert.equal(new Headers(call.headers).get('Content-Type'), null)
      assert.ok(call.body instanceof FormData)
    }
  })
  it('rejects an excessive server wait without shortening it or replaying creation', async () => {
    let count = 0
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => { count++; return new Response('{}', { status: 429, headers: { 'Retry-After': '301' } }) } })
    await assert.rejects(api.execute({ requestId, action: 'createBase', name: '制度' }), KnowledgeApiError)
    assert.equal(count, 1)
  })
  it('preserves opaque ETags and never parses 204 as JSON', async () => {
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async (url, init) => {
      assert.ok(String(url).endsWith('/knowledge-bases/kb/documents/doc'))
      assert.equal(new Headers(init?.headers).get('If-Match'), 'W/"original"')
      return new Response(null, { status: 204 })
    } })
    assert.equal(await api.execute({ requestId, action: 'deleteDocument', kbId: 'kb', docId: 'doc', etag: 'W/"original"', idempotencyKey: requestId }), undefined)
  })
  it('takes document ETag from headers and surfaces conflicts without retry or raw content', async () => {
    const api = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => Response.json({ id: 'doc', status: 'READY', searchable: true }, { headers: { ETag: '"opaque"' } }) })
    assert.equal((await api.execute({ requestId, action: 'getDocument', kbId: 'kb', docId: 'doc' })).etag, '"opaque"')
    const broken = new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => Response.json({ code: 'REVISION_CONFLICT', message: 'private document text', requestId: 'trace-1' }, { status: 412 }) })
    await assert.rejects(broken.execute({ requestId, action: 'getBase', kbId: 'kb' }), (error: unknown) => {
      assert.ok(error instanceof KnowledgeApiError)
      assert.equal(error.platformCode, 'REVISION_CONFLICT'); assert.equal(error.requestId, 'trace-1')
      assert.doesNotMatch(error.message, /private/)
      return true
    })
  })
  it('cancels token waits and prevents requests after identity changes', async () => {
    let calls = 0
    const controller = new AbortController()
    const api = new KnowledgeApi({ getAccessToken: () => new Promise(() => undefined), fetch: async () => { calls++; return Response.json(noMatch) } })
    const pending = api.execute({ requestId, action: 'search', query: '制度', topK: 5 }, controller.signal)
    controller.abort()
    await assert.rejects(pending)
    assert.equal(calls, 0)
  })
})
