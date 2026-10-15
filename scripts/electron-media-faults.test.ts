import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { MediaFaultInjector, type MediaFaultKind } from './electron-media-faults'

const root = 'http://127.0.0.1:4321/api'
const requests = `${root}/gateway/v1/media/requests`
const receiptId = 'receipt-first'
const clientRequestId = 'client-first'
const query = `${requests}/${receiptId}`
const byClient = `${requests}/by-client-id/${clientRequestId}`
const content = (outputId = 'output-first'): string => `${query}/outputs/${outputId}/content`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64')
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const faultKinds: MediaFaultKind[] = ['AUTH_QUERY', 'AUTH_DOWNLOAD', 'CORRUPT_DOWNLOAD', 'PARTIAL_DOWNLOAD']

function receipt(overrides: Record<string, unknown> = {}, status = 202): Response {
  return Response.json({
    mock: true, receiptId, clientRequestId, profileId: 'mock-async', configVersion: 'mock-v1',
    executionMode: 'async-query', status: 'QUEUED', pollAfterMs: 1, outputs: [],
    billingStatus: 'MOCK_NOT_CHARGED', errorCode: null, outputErrors: [],
    recovery: { canQuery: true, canCancel: true, canDownload: false }, ...overrides,
  }, { status })
}

function download(status = 200, mime = 'image/png'): Response {
  return new Response(png, { status, statusText: 'Mock response', headers: {
    'Content-Type': mime, 'Content-Length': String(png.length), 'X-SHA256': hash(png),
    'X-SEP-Media-Mock': 'true', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="output.png"',
  } })
}

async function armed(kind: MediaFaultKind): Promise<MediaFaultInjector> {
  const injector = new MediaFaultInjector(root)
  injector.configure(kind)
  const response = receipt()
  assert.equal(await injector.after(new URL(requests), 'POST', response), response)
  assert.equal(injector.audit.targetReceiptId, receiptId)
  assert.equal(injector.audit.targetClientRequestId, clientRequestId)
  assert.equal(response.bodyUsed, false)
  const body: unknown = await response.json()
  assert.ok(body !== null && typeof body === 'object' && 'receiptId' in body)
  assert.equal(body.receiptId, receiptId)
  return injector
}

async function fetchThrough(injector: MediaFaultInjector, url: string, nativeResponse: Response, method = 'GET'): Promise<Response> {
  return injector.before(new URL(url), method) ?? injector.after(new URL(url), method, nativeResponse)
}

describe('pure local media fault injector', () => {
  it('accepts only loopback HTTP roots with the exact /api path', () => {
    for (const url of [root, 'http://localhost/api', 'http://127.0.0.2:4321/api', 'http://[::1]:4321/api']) {
      assert.doesNotThrow(() => new MediaFaultInjector(url))
    }
    for (const url of [
      '', 'not a url', 'https://127.0.0.1/api', 'http://example.com/api', 'http://localhost.example.com/api',
      'http://0.0.0.0/api', 'http://192.168.1.1/api', `${root}/`, `${root}/extra`,
      'http://127.0.0.1:4321/', 'http://user:secret@127.0.0.1:4321/api', 'http://@127.0.0.1:4321/api',
      `${root}?token=secret`, `${root}#private`, `${root}?`, `${root}#`, ` ${root}`,
    ]) assert.throws(() => new MediaFaultInjector(url), /loopback HTTP \/api/)
  })

  it('rejects invalid configuration without altering existing audit', async () => {
    const injector = await armed('AUTH_QUERY')
    const audit = injector.audit
    for (const kind of ['AUTH', '', undefined, false, 1, {}]) {
      assert.throws(() => injector.configure(kind as MediaFaultKind), /Invalid media fault kind/)
      assert.deepEqual(injector.audit, audit)
    }
  })

  it('starts disabled and resets all evidence on every non-null configuration, even the same kind', async () => {
    const passive = new MediaFaultInjector(root)
    assert.equal(passive.audit.enabled, false)
    assert.equal(passive.audit.kind, null)
    await passive.after(new URL(requests), 'POST', receipt())
    assert.equal(passive.audit.targetReceiptId, null)
    const injector = await armed('AUTH_DOWNLOAD')
    injector.before(new URL(content()), 'GET')
    injector.configure('AUTH_DOWNLOAD')
    assert.deepEqual(injector.audit, {
      kind: 'AUTH_DOWNLOAD', enabled: true, targetReceiptId: null, targetClientRequestId: null,
      injected: 0, allowedOutputId: null, downloadAttempts: {},
    })
  })

  it('does not inject or count downloads before a successful submission', async () => {
    for (const kind of faultKinds) {
      const injector = new MediaFaultInjector(root)
      injector.configure(kind)
      for (const url of [query, byClient, content()]) {
        const native = download()
        assert.equal(await fetchThrough(injector, url, native), native)
      }
      assert.equal(injector.audit.injected, 0)
      assert.equal(injector.audit.targetReceiptId, null)
      assert.deepEqual(injector.audit.downloadAttempts, {})
      for (const status of [400, 403, 500]) {
        const failed = receipt({}, status)
        assert.equal(await injector.after(new URL(requests), 'POST', failed), failed)
        assert.equal(failed.bodyUsed, false)
        assert.equal(injector.audit.targetReceiptId, null)
      }
    }
  })

  it('captures only the first successful top-level DTO and keeps no private payload', async () => {
    const injector = new MediaFaultInjector(root)
    injector.configure('AUTH_QUERY')
    const first = receipt({ creativeBrief: 'private prompt', token: 'private-token', reference: 'private-image' })
    await injector.after(new URL(requests), 'post', first)
    const second = receipt({ receiptId: 'receipt-second', clientRequestId: 'client-second' }, 200)
    await injector.after(new URL(requests), 'POST', second)
    assert.equal(injector.audit.targetReceiptId, receiptId)
    assert.equal(second.bodyUsed, false)
    assert.doesNotMatch(JSON.stringify(injector.audit), /private|creativeBrief|token|reference/)
    const snapshot = injector.audit
    snapshot.targetReceiptId = 'changed'
    snapshot.downloadAttempts.changed = 99
    assert.equal(injector.audit.targetReceiptId, receiptId)
    assert.deepEqual(injector.audit.downloadAttempts, {})
  })

  it('does not arm from malformed, wrapped, invalid-ID, oversized or non-JSON responses', async () => {
    const injector = new MediaFaultInjector(root)
    injector.configure('AUTH_QUERY')
    const invalid = [
      Response.json({ data: { receiptId, clientRequestId } }), Response.json(null), Response.json([]),
      receipt({ receiptId: 'private/path' }), receipt({ receiptId: 'a'.repeat(129) }), receipt({ clientRequestId: null }),
      new Response('{ invalid', { headers: { 'Content-Type': 'application/json' } }),
      new Response(JSON.stringify({ receiptId, clientRequestId }), { headers: { 'Content-Type': 'text/plain' } }),
      receipt({ padding: 'x'.repeat(65 * 1024) }),
      new Response(JSON.stringify({ receiptId, clientRequestId }), { headers: {
        'Content-Type': 'application/json', 'Content-Length': String(65 * 1024),
      } }),
      new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    ]
    for (const response of invalid) {
      assert.equal(await injector.after(new URL(requests), 'POST', response), response)
      assert.equal(response.bodyUsed, false)
      assert.equal(injector.audit.targetReceiptId, null)
    }
    await injector.after(new URL(requests), 'POST', receipt())
    assert.equal(injector.audit.targetReceiptId, receiptId)
  })

  it('bounds stalled clone reading and leaves the native body available', async () => {
    const injector = new MediaFaultInjector(root)
    injector.configure('AUTH_QUERY')
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"receiptId":'))
    } }), { headers: { 'Content-Type': 'application/json' } })
    assert.equal(await injector.after(new URL(requests), 'POST', response), response)
    assert.equal(response.bodyUsed, false)
    assert.equal(injector.audit.targetReceiptId, null)
    void response.body?.cancel()
  })

  it('blocks only target receipt queries and original by-client-id queries before native fetch', async () => {
    const injector = await armed('AUTH_QUERY')
    let nativeCalls = 0
    for (const url of [query, byClient, query]) {
      const denied = injector.before(new URL(url), 'get')
      if (!denied) nativeCalls++
      assert.ok(denied)
      assert.equal(denied.status, 403)
      assert.equal(denied.headers.get('content-type'), 'application/json')
      assert.deepEqual(await denied.json(), { error: { code: 'MEDIA_FORBIDDEN', message: 'Mock authorization revoked' } })
    }
    assert.equal(nativeCalls, 0)
    assert.equal(injector.audit.injected, 3)
    for (const url of [content(), `${requests}/receipt-other`, `${requests}/by-client-id/client-other`]) {
      assert.equal(injector.before(new URL(url), 'GET'), undefined)
    }
  })

  it('blocks only target downloads in AUTH_DOWNLOAD and counts each denied attempt', async () => {
    const injector = await armed('AUTH_DOWNLOAD')
    assert.equal(injector.before(new URL(query), 'GET'), undefined)
    assert.equal(injector.before(new URL(byClient), 'GET'), undefined)
    for (const id of ['output-first', 'output-first', 'output-second']) {
      assert.equal(injector.before(new URL(content(id)), 'GET')?.status, 403)
    }
    assert.equal(injector.audit.injected, 3)
    assert.deepEqual(injector.audit.downloadAttempts, { 'output-first': 2, 'output-second': 1 })
  })

  it('never touches unrelated origins, paths, methods, quotes, submissions or cancellation', async () => {
    const unrelated = [
      requests.replace(':4321', ':4322'), requests.replace('127.0.0.1', 'localhost'), requests.replace('http:', 'https:'),
      requests.replace('/api/', '/other/'), `${requests}-extra`, `${requests}/`, `${root}/gateway/v1/media/quotes`,
      `${query}/cancel`, `${query}/extra`, `${query}/`, `${byClient}/extra`,
      `${query}/outputs/output-first/content/extra`, `${query}/outputs/output-first/content/`,
      `${requests}/receipt-other/outputs/output-first/content`,
      content().replace('output-first', 'output%2Ffirst'), `${content()}?token=private`, `${content()}#private`,
      `${content()}?`, `${content()}#`, content().replace('127.0.0.1', 'user:private@127.0.0.1'),
    ]
    for (const kind of faultKinds) {
      const injector = await armed(kind)
      for (const url of unrelated) {
        assert.equal(injector.before(new URL(url), 'GET'), undefined)
        const native = download()
        assert.equal(await injector.after(new URL(url), 'GET', native), native)
      }
      for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'POST']) {
        for (const url of [query, byClient, content()]) {
          const native = download()
          assert.equal(await fetchThrough(injector, url, native, method), native)
        }
      }
      const submit = receipt({ receiptId: 'receipt-other', clientRequestId: 'client-other' })
      assert.equal(injector.before(new URL(requests), 'POST'), undefined)
      assert.equal(await injector.after(new URL(requests), 'POST', submit), submit)
      assert.equal(injector.audit.injected, 0)
      assert.equal(injector.audit.targetReceiptId, receiptId)
      assert.deepEqual(injector.audit.downloadAttempts, {})
    }
  })

  it('does not arm from another origin, path or method', async () => {
    const injector = new MediaFaultInjector(root)
    injector.configure('AUTH_QUERY')
    for (const [url, method] of [
      [requests.replace(':4321', ':4322'), 'POST'], [`${requests}/`, 'POST'],
      [`${root}/gateway/v1/media/quotes`, 'POST'], [requests, 'GET'], [requests, 'PUT'],
      [`${requests}?secret=value`, 'POST'], [`${requests}/receipt-other/cancel`, 'POST'],
    ]) {
      const response = receipt()
      assert.equal(await injector.after(new URL(url), method, response), response)
      assert.equal(response.bodyUsed, false)
      assert.equal(injector.audit.targetReceiptId, null)
    }
  })

  it('corrupts equal-length PNG bytes repeatedly while preserving all original headers', async () => {
    const injector = await armed('CORRUPT_DOWNLOAD')
    for (const id of ['output-first', 'output-first', 'output-second']) {
      const native = download()
      const result = await fetchThrough(injector, content(id), native)
      assert.notEqual(result, native)
      assert.equal(result.status, native.status)
      assert.equal(result.statusText, native.statusText)
      assert.deepEqual([...result.headers], [...native.headers])
      const bytes = new Uint8Array(await result.arrayBuffer())
      assert.equal(bytes.length, png.length)
      assert.equal(result.headers.get('content-length'), String(bytes.length))
      assert.equal(result.headers.get('x-sha256'), hash(png))
      assert.notEqual(hash(bytes), hash(png))
      assert.deepEqual(bytes.slice(0, 8), new Uint8Array(png.subarray(0, 8)))
    }
    assert.equal(injector.audit.injected, 3)
    assert.deepEqual(injector.audit.downloadAttempts, { 'output-first': 2, 'output-second': 1 })
  })

  it('corrupts a chunked stream without buffering or changing chunk lengths', async () => {
    const injector = await armed('CORRUPT_DOWNLOAD')
    const originalHash = hash(png)
    const native = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array())
      controller.enqueue(png.subarray(0, 20))
      controller.enqueue(png.subarray(20))
      controller.close()
    } }), { headers: { 'Content-Type': 'image/png; charset=binary', 'X-SHA256': hash(png), 'Content-Length': String(png.length) } })
    const result = await fetchThrough(injector, content(), native)
    const reader = result.body!.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunks.push(chunk.value)
    }
    assert.deepEqual(chunks.map(chunk => chunk.length), [0, 20, png.length - 20])
    assert.notEqual(hash(Buffer.concat(chunks)), hash(png))
    assert.equal(Buffer.concat(chunks).length, png.length)
    assert.equal(hash(png), originalHash)
  })

  it('leaves failed, non-PNG and bodyless downloads untouched and does not select partial output', async () => {
    for (const kind of ['CORRUPT_DOWNLOAD', 'PARTIAL_DOWNLOAD'] as const) {
      const injector = await armed(kind)
      for (const native of [download(403), download(404), download(500), download(200, 'application/json'), new Response(null, { status: 204 })]) {
        assert.equal(await fetchThrough(injector, content('failed-output'), native), native)
        assert.equal(native.bodyUsed, false)
      }
      assert.equal(injector.audit.injected, 0)
      assert.equal(injector.audit.allowedOutputId, null)
      assert.deepEqual(injector.audit.downloadAttempts, { 'failed-output': 5 })
    }
  })

  it('always allows the first successful output ID and corrupts every other ID, including retries', async () => {
    const injector = await armed('PARTIAL_DOWNLOAD')
    for (const id of ['output-first', 'output-first', 'output-second', 'output-first', 'output-second', 'output-third']) {
      const native = download()
      const result = await fetchThrough(injector, content(id), native)
      const bytes = new Uint8Array(await result.arrayBuffer())
      assert.equal(hash(bytes) === hash(png), id === 'output-first')
      assert.equal(injector.audit.allowedOutputId, 'output-first')
    }
    assert.equal(injector.audit.injected, 3)
    assert.deepEqual(injector.audit.downloadAttempts, { 'output-first': 3, 'output-second': 2, 'output-third': 1 })
  })

  it('clears permission or integrity faults for recovery while retaining evidence, then resets on non-null configure', async () => {
    for (const kind of faultKinds) {
      const injector = await armed(kind)
      const failing = kind === 'AUTH_QUERY' ? query : content('output-second')
      if (kind === 'PARTIAL_DOWNLOAD') await (await fetchThrough(injector, content(), download())).arrayBuffer()
      await (await fetchThrough(injector, failing, download())).arrayBuffer()
      const previous = injector.audit
      injector.configure(null)
      assert.deepEqual(injector.audit, { ...previous, enabled: false })
      await injector.after(new URL(requests), 'POST', receipt({ receiptId: 'recovery-other', clientRequestId: 'client-other' }))
      assert.equal(injector.audit.targetReceiptId, receiptId)
      const native = download()
      assert.equal(await fetchThrough(injector, failing, native), native)
      assert.equal(hash(new Uint8Array(await native.arrayBuffer())), hash(png))
      assert.equal(injector.audit.injected, previous.injected)
      assert.equal(injector.audit.targetReceiptId, receiptId)
      if (kind !== 'AUTH_QUERY') {
        assert.equal(injector.audit.downloadAttempts['output-second'], previous.downloadAttempts['output-second'] + 1)
      }
      injector.configure(null)
      injector.configure(kind)
      assert.deepEqual(injector.audit, {
        kind, enabled: true, targetReceiptId: null, targetClientRequestId: null,
        injected: 0, allowedOutputId: null, downloadAttempts: {},
      })
    }
  })

  it('does not capture a stale submission after clear or reconfigure during clone reading', async () => {
    for (const nextKind of [null, 'AUTH_DOWNLOAD'] as const) {
      const injector = new MediaFaultInjector(root)
      injector.configure('AUTH_QUERY')
      let complete!: () => void
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
        complete = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ receiptId, clientRequestId })))
          controller.close()
        }
      } }), { headers: { 'Content-Type': 'application/json' } })
      const pending = injector.after(new URL(requests), 'POST', response)
      injector.configure(nextKind)
      complete()
      assert.equal(await pending, response)
      assert.equal(injector.audit.targetReceiptId, null)
      assert.equal(injector.audit.enabled, nextKind !== null)
    }
  })

  it('keeps the first successful submission as the target while concurrent clone reads finish', async () => {
    const injector = new MediaFaultInjector(root)
    injector.configure('AUTH_QUERY')
    let complete!: () => void
    const first = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      complete = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ receiptId, clientRequestId })))
        controller.close()
      }
    } }), { headers: { 'Content-Type': 'application/json' } })
    const pending = injector.after(new URL(requests), 'POST', first)
    const second = receipt({ receiptId: 'receipt-other', clientRequestId: 'client-other' })
    assert.equal(await injector.after(new URL(requests), 'POST', second), second)
    complete()
    assert.equal(await pending, first)
    assert.equal(injector.audit.targetReceiptId, receiptId)
    assert.equal(injector.audit.targetClientRequestId, clientRequestId)
  })

  it('retains safe counts for IDs that coincide with Object prototype properties', async () => {
    const injector = await armed('AUTH_DOWNLOAD')
    for (const id of ['__proto__', 'constructor', 'toString', '__proto__']) injector.before(new URL(content(id)), 'GET')
    assert.equal(Object.getPrototypeOf(injector.audit.downloadAttempts), Object.prototype)
    assert.equal(injector.audit.downloadAttempts.__proto__, 2)
    assert.equal(injector.audit.downloadAttempts.constructor, 1)
    assert.equal(injector.audit.downloadAttempts.toString, 1)
  })
})
