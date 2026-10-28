import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fetchWithModelDiagnostics, type ModelTransportFailure } from './model-transport-diagnostics'

const url = 'http://gateway.invalid/v1/chat/completions'
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

it('forwards bytes and response metadata without reading ahead or logging successful responses', async () => {
  let reads = 0
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])]
  const source = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  }, { highWaterMark: 0 }), { status: 201, statusText: 'Created', headers: { 'x-request-id': 'platform-a' } })
  Object.defineProperties(source, { url: { value: url }, redirected: { value: true } })
  const failures: ModelTransportFailure[] = []
  const init = { method: 'POST', body: '{}' }
  const response = await fetchWithModelDiagnostics(url, init, failure => { failures.push(failure) }, {
    fetch: async (input, actualInit) => {
      assert.equal(input, url)
      assert.equal(actualInit, init)
      return source
    },
  })
  await tick()
  assert.equal(reads, 0)
  assert.equal(response.status, 201)
  assert.equal(response.statusText, 'Created')
  assert.equal(response.headers.get('x-request-id'), 'platform-a')
  assert.equal(response.url, url)
  assert.equal(response.redirected, true)
  assert.equal(response.type, source.type)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]))
  assert.equal(response.bodyUsed, true)
  assert.equal(source.body?.locked, false)
  assert.deepEqual(failures, [])
})

it('returns responses with no body unchanged and preserves non-success response bodies', async () => {
  const failures: ModelTransportFailure[] = []
  for (const source of [new Response(null, { status: 204 }), new Response('{"error":"denied"}', { status: 403 })]) {
    const response = await fetchWithModelDiagnostics(url, {}, failure => { failures.push(failure) }, { fetch: async () => source })
    assert.equal(response.status, source.status)
    if (source.status === 204) assert.equal(response, source)
    else assert.deepEqual(await response.json(), { error: 'denied' })
  }
  assert.deepEqual(failures, [])
})

it('captures connection errors before headers and rethrows the identical original error', async () => {
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
  const failures: ModelTransportFailure[] = []
  let time = 10
  await assert.rejects(fetchWithModelDiagnostics(url, {}, failure => { failures.push(failure) }, {
    fetch: async () => { time = 35; throw error }, now: () => time,
  }), actual => actual === error)
  assert.equal(failures.length, 1)
  assert.deepEqual(failures[0], {
    transportPhase: 'connect', errorName: 'TypeError', errorMessage: 'fetch failed',
    causes: [{ name: 'Error', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }],
    elapsedMs: 25, bytesReceived: 0, signalAborted: false,
  })
})

for (const code of ['UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT']) {
  it(`captures ${code} during body consumption with byte counts and timing`, async () => {
    const error = new TypeError('terminated', { cause: Object.assign(new Error('stream failure'), { code }) })
    const failures: ModelTransportFailure[] = []
    let time = 100
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const source = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), {
      headers: { 'x-request-id': 'platform-a', 'Content-Type': 'text/event-stream' },
    })
    const response = await fetchWithModelDiagnostics(url, {}, failure => { failures.push(failure) }, {
      fetch: async () => source, now: () => time,
    })
    const reader = response.body!.getReader()
    time = 120
    const bytes = new Uint8Array([1, 2, 3])
    controller.enqueue(bytes)
    assert.equal((await reader.read()).value, bytes)
    time = 180
    controller.error(error)
    await assert.rejects(reader.read(), actual => actual === error)
    assert.equal(failures.length, 1)
    assert.deepEqual(failures[0], {
      transportPhase: 'response-body', errorName: 'TypeError', errorMessage: 'terminated',
      causes: [{ name: 'Error', code, message: 'stream failure' }],
      providerStatus: 200, platformRequestId: 'platform-a',
      elapsedMs: 80, bytesReceived: 3, firstByteMs: 20, lastDataAgeMs: 60, signalAborted: false,
    })
    assert.equal(source.body?.locked, false)
  })
}

it('distinguishes a signal abort from transport failure without replacing the abort error', async () => {
  const abort = new AbortController()
  const error = new DOMException('The operation was aborted.', 'AbortError')
  const failures: ModelTransportFailure[] = []
  const source = new Response(new ReadableStream<Uint8Array>({
    start(controller) { abort.signal.addEventListener('abort', () => controller.error(error), { once: true }) },
  }))
  const response = await fetchWithModelDiagnostics(url, { signal: abort.signal }, failure => { failures.push(failure) }, {
    fetch: async () => source,
  })
  const read = response.body!.getReader().read()
  abort.abort()
  await assert.rejects(read, actual => actual === error)
  assert.equal(failures.length, 1)
  assert.equal(failures[0]!.signalAborted, true)
  assert.equal(failures[0]!.errorName, 'AbortError')
  assert.equal(failures[0]!.firstByteMs, undefined)
  assert.equal(failures[0]!.lastDataAgeMs, undefined)
})

it('propagates reader cancellation to the underlying stream without reporting a connection failure', async () => {
  let cancelled: unknown
  const failures: ModelTransportFailure[] = []
  const source = new Response(new ReadableStream<Uint8Array>({ cancel(reason) { cancelled = reason } }))
  const response = await fetchWithModelDiagnostics(url, {}, failure => { failures.push(failure) }, { fetch: async () => source })
  const reader = response.body!.getReader()
  const pending = reader.read()
  await tick()
  await reader.cancel('consumer stopped')
  assert.deepEqual(await pending, { done: true, value: undefined })
  assert.equal(cancelled, 'consumer stopped')
  assert.equal(source.body?.locked, false)
  assert.deepEqual(failures, [])
})

it('bounds and redacts error causes without logging headers, socket objects or arbitrary properties', async () => {
  const cause = Object.assign(new Error('Bearer private-value token="saved-secret" https://host/?api_key=query-secret'), {
    code: 'UND_ERR_SOCKET', authorization: 'header-secret', socket: { remoteAddress: 'private-address' },
  })
  Object.assign(cause, { cause })
  const error = new TypeError('terminated', { cause })
  const failures: ModelTransportFailure[] = []
  await assert.rejects(fetchWithModelDiagnostics(url, { headers: { authorization: 'Bearer request-secret' } }, failure => { failures.push(failure) }, {
    fetch: async () => { throw error },
  }), actual => actual === error)
  assert.equal(failures[0]!.causes.length, 1)
  assert.equal(failures[0]!.causes[0]!.code, 'UND_ERR_SOCKET')
  assert.doesNotMatch(JSON.stringify(failures), /private-value|saved-secret|query-secret|header-secret|private-address|request-secret/)

  const longError = new Error('x'.repeat(10000))
  Object.assign(longError, { cause: new Error('y'.repeat(10000), { cause: new Error('z'.repeat(10000), { cause: new Error('hidden') }) }) })
  await assert.rejects(fetchWithModelDiagnostics(url, {}, failure => { failures.push(failure) }, { fetch: async () => { throw longError } }))
  assert.ok(failures[1]!.errorMessage.length < 600)
  assert.ok(failures[1]!.causes.every(item => item.message.length < 600))
  assert.ok(failures[1]!.causes.length <= 3)
})

it('does not replace transport failures when diagnostic sinks throw or reject', async () => {
  const error = new Error('original failure')
  for (const sink of [() => { throw new Error('sink failed') }, async () => { throw new Error('sink rejected') }, () => new Promise<void>(() => {})]) {
    await assert.rejects(fetchWithModelDiagnostics(url, {}, sink, { fetch: async () => { throw error } }), actual => actual === error)
    const source = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(error) } }))
    const response = await fetchWithModelDiagnostics(url, {}, sink, { fetch: async () => source })
    await assert.rejects(response.text(), actual => actual === error)
  }
  await tick()
})

it('keeps overlapping request diagnostics and byte counts independent', async () => {
  const failures: ModelTransportFailure[][] = [[], []]
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const sources = [0, 1].map(index => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controllers[index] = controller },
  }), { headers: { 'x-request-id': `platform-${index}` } }))
  const responses = await Promise.all(sources.map((source, index) => fetchWithModelDiagnostics(url, {}, failure => {
    failures[index]!.push(failure)
  }, { fetch: async () => source })))
  const readers = responses.map(response => response.body!.getReader())
  for (const [index, controller] of controllers.entries()) controller.enqueue(new Uint8Array(index + 1))
  await Promise.all(readers.map(reader => reader.read()))
  for (const [index, controller] of controllers.entries()) {
    controller.error(new TypeError('terminated', { cause: Object.assign(new Error(`failure-${index}`), { code: 'UND_ERR_SOCKET' }) }))
  }
  await Promise.all(readers.map(reader => assert.rejects(reader.read(), /terminated/)))
  for (const [index, records] of failures.entries()) {
    assert.equal(records.length, 1)
    assert.equal(records[0]!.bytesReceived, index + 1)
    assert.equal(records[0]!.platformRequestId, `platform-${index}`)
    assert.equal(records[0]!.causes[0]!.message, `failure-${index}`)
  }
})

it('captures a real HTTP 200 socket interruption before Pi flattens the error', { timeout: 5000 }, async () => {
  const failures: ModelTransportFailure[] = []
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'platform-real' })
    response.write('data: {}\n\n')
    setTimeout(() => response.destroy(), 30)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetchWithModelDiagnostics(`http://127.0.0.1:${address.port}`, {}, failure => { failures.push(failure) })
    await assert.rejects(response.text(), /terminated/)
    assert.equal(failures.length, 1)
    assert.equal(failures[0]!.providerStatus, 200)
    assert.equal(failures[0]!.platformRequestId, 'platform-real')
    assert.equal(failures[0]!.causes[0]!.code, 'UND_ERR_SOCKET')
    assert.ok(failures[0]!.bytesReceived > 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
