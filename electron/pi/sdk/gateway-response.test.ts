import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { guardGatewayResponse, type GatewayResponseFailure } from './gateway-response'
import { RUNTIME_FAILURE_MESSAGES } from '../../../src/shared/runtime-feedback'

const headers = { 'content-type': 'text/event-stream', 'x-request-id': 'sep-1', 'x-compute-request-id': 'compute-2',
  'x-upstream-request-id': 'upstream-3', 'x-sep-execution-id': 'execution-4' }
const text = 'data: {"choices":[{"delta":{"content":"partial text"},"finish_reason":null}]}\n\n'

for (const event of ['error', 'response.failed', 'response.error', 'data-error', 'nested-response'] as const) {
  for (const ending of ['data: [DONE]\n\n', '']) {
    it(`keeps ${event} failed after ${ending ? 'DONE' : 'EOF'}, retaining text and actual diagnostic IDs`, async () => {
      const failures: GatewayResponseFailure[] = []
      const error = { code: 'UPSTREAM_BUSY', message: 'Capacity exhausted grant-secret', source: 'upstream' }
      const frame = event === 'data-error' ? `data: ${JSON.stringify({ error })}\n\n`
        : event === 'nested-response' ? `event: response.failed\ndata: ${JSON.stringify({ response: { error } })}\n\n`
        : `event: ${event}\ndata: ${JSON.stringify({ error })}\n\n`
      const response = await guardGatewayResponse(new Response(text + frame + ending, { headers }), {
        secrets: ['grant-secret'], onFailure: failure => failures.push(failure),
      })
      const reader = response.body!.getReader()
      assert.match(new TextDecoder().decode((await reader.read()).value), /partial text/)
      await assert.rejects(reader.read(), { message: RUNTIME_FAILURE_MESSAGES.SERVICE_UNAVAILABLE })
      assert.equal(failures.length, 1)
      const diagnostic = failures[0].diagnostic
      assert.equal(failures[0].kind, 'sse')
      assert.equal(diagnostic.code, 'UPSTREAM_BUSY')
      assert.match(diagnostic.message!, /Capacity exhausted/)
      assert.equal(diagnostic.httpStatus, 200)
      assert.equal(diagnostic.sepRequestId, 'sep-1')
      assert.equal(diagnostic.computeRequestId, 'compute-2')
      assert.equal(diagnostic.upstreamRequestId, 'upstream-3')
      assert.equal(diagnostic.executionId, 'execution-4')
      assert.doesNotMatch(JSON.stringify(failures), /grant-secret/)
    })
  }
}

it('detects EOF without inventing an upstream cause and keeps prior text', async () => {
  const failures: GatewayResponseFailure[] = []
  const response = await guardGatewayResponse(new Response(text, { headers }), { onFailure: failure => failures.push(failure) })
  const reader = response.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /partial text/)
  await assert.rejects(reader.read(), { message: RUNTIME_FAILURE_MESSAGES.MODEL_RESPONSE_INTERRUPTED })
  assert.equal(failures[0].kind, 'incomplete')
  assert.equal(failures[0].diagnostic.source, undefined)
  assert.equal(failures[0].diagnostic.code, undefined)
  assert.equal(failures[0].diagnostic.upstreamRequestId, 'upstream-3')
})

it('does not treat a finish_reason followed by EOF without DONE as a complete transport', async () => {
  const failures: GatewayResponseFailure[] = []
  const response = await guardGatewayResponse(new Response(text + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', { headers }), {
    onFailure: failure => failures.push(failure),
  })
  const reader = response.body!.getReader()
  await reader.read()
  await reader.read()
  await assert.rejects(reader.read(), { message: RUNTIME_FAILURE_MESSAGES.MODEL_RESPONSE_INTERRUPTED })
  assert.equal(failures[0].kind, 'incomplete')
})

it('parses fragmented UTF-8 and CRLF/multiline SSE with a successful DONE', async () => {
  const failures: GatewayResponseFailure[] = []
  const bytes = Buffer.from('data: {"choices":\r\ndata: [{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n')
  let index = 0
  const response = await guardGatewayResponse(new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (index < bytes.length) controller.enqueue(bytes.subarray(index, ++index)); else controller.close() },
  }), { headers }), { onFailure: failure => failures.push(failure) })
  assert.match(await response.text(), /你好/)
  assert.deepEqual(failures, [])
})

it('bounds oversized frames and cancellation never waits for a remote cancel acknowledgement', { timeout: 1000 }, async () => {
  let cancelled = false
  const failures: GatewayResponseFailure[] = []
  const response = await guardGatewayResponse(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 1))) },
    cancel() { cancelled = true; return new Promise(() => {}) },
  }), { headers }), { onFailure: failure => failures.push(failure) })
  await assert.rejects(response.text(), { message: RUNTIME_FAILURE_MESSAGES.MODEL_RESPONSE_INTERRUPTED })
  assert.equal(cancelled, true)
  assert.equal(failures[0].kind, 'incomplete')
})

it('aborts a stalled read and suppresses later diagnostics after consumer cancellation', { timeout: 1000 }, async () => {
  const abort = new AbortController()
  const failures: GatewayResponseFailure[] = []
  let cancelled = 0
  const source = () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++ } }), { headers })
  const response = await guardGatewayResponse(source(), { signal: abort.signal, onFailure: failure => failures.push(failure) })
  const read = response.body!.getReader().read()
  abort.abort(new Error('cancelled by user'))
  await assert.rejects(read, /cancelled by user/)
  assert.equal(cancelled, 1)
  const next = await guardGatewayResponse(source(), { onFailure: failure => failures.push(failure) })
  const reader = next.body!.getReader()
  const pending = reader.read()
  await reader.cancel()
  assert.equal((await pending).done, true)
  assert.equal(cancelled, 2)
  assert.deepEqual(failures, [])
})

it('records HTTP failures separately and returns controlled SDK copy without clearing upstream credentials', async () => {
  for (const [body, expected] of [
    [{ error: { message: 'Invalid provider key key-secret', source: 'upstream', code: 7001 } }, RUNTIME_FAILURE_MESSAGES.SERVICE_UNAVAILABLE],
    [{ message: 'Expired desktop token' }, RUNTIME_FAILURE_MESSAGES.AUTH_REQUIRED],
  ] as const) {
    const failures: GatewayResponseFailure[] = []
    const response = await guardGatewayResponse(new Response(JSON.stringify(body), { status: 401, headers }), {
      secrets: ['key-secret'], onFailure: failure => failures.push(failure),
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: { message: expected } })
    assert.equal(failures[0].kind, 'http')
    assert.equal(failures[0].diagnostic.httpStatus, 401)
    assert.doesNotMatch(JSON.stringify(failures), /key-secret/)
  }
})

it('retains malformed HTTP and non-SSE 200 bodies as evidence', async () => {
  for (const status of [200, 503]) {
    const failures: GatewayResponseFailure[] = []
    const response = await guardGatewayResponse(new Response('Gateway unavailable', { status }), { onFailure: failure => failures.push(failure) })
    if (status === 200) await assert.rejects(response.text())
    else assert.deepEqual(await response.json(), { error: { message: 'Gateway unavailable' } })
    assert.equal(failures[0].diagnostic.body, 'Gateway unavailable')
    assert.equal(failures[0].diagnostic.httpStatus, status)
  }
})
