import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { SepRealMediaGateway } from './sep-real-media-gateway'
import { SepRealVideoGateway } from './sep-video-media-gateway'
import { AppError } from '../errors/app-error'
import { mediaToolFailureFrom } from '../errors/media-tool-error'
import { videoToolFailureFrom } from '../errors/video-tool-error'
import { mediaIssueMessage } from '../../src/shared/media-feedback'
import { videoReceiptSchema } from '../../src/shared/video-media'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { mediaUpstreamErrorSchema } from '../../src/shared/media-upstream-error'
import { safeMediaUpstreamError } from '../common/media-upstream-error'
import { mediaJobFailure } from '../errors/media-job-error'
import { AuthApiError } from '../common/platform/platform-api'
import { redactValue } from '../common/redact'

const signal = new AbortController().signal
for (const kind of ['image', 'video'] as const) {
  for (const body of ['Supplier account disabled', { error: { code: 'supplier_denied', message: 'Supplier account disabled' } }]) {
    test(`${kind} retains upstream 401 ${typeof body} errors without treating them as SEP authentication`, async () => {
      let calls = 0
      const fetcher: typeof fetch = async () => {
        calls++
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 401,
          headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'X-SEP-Error-Source': 'upstream' } })
      }
      const options = { baseUrl: 'https://sep.invalid/api', token: async () => 'fixture-token', fetch: fetcher }
      try {
        if (kind === 'image') await new SepRealMediaGateway(options).getReceipt('sub', 'receipt', signal)
        else await new SepRealVideoGateway({ ...options, mock: false, subscriptionId: 'sub' }).getReceipt('receipt', signal)
        assert.fail('expected upstream error')
      } catch (error) {
        assert.ok(error instanceof AppError)
        assert.notEqual(error.code, 'AUTH_REQUIRED')
        assert.equal(error.details?.source, 'upstream')
        const failure = kind === 'image' ? mediaToolFailureFrom(error) : videoToolFailureFrom(error)
        assert.match(failure.error.message, /生成供应商账号已停用/)
        assert.doesNotMatch(failure.error.message, /Supplier account disabled|重新登录|余额不足/)
      }
      assert.equal(calls, 1)
    })
  }
}
test('asynchronous upstream errors survive receipt validation and become visible task errors', () => {
  const upstreamError = { status: 200, body: { error: { code: 'supplier_failed', message: 'Reference subject rejected' } } }
  const receipt = videoReceiptSchema.parse({ ...fixture.receipts.failed, upstreamError })
  assert.deepEqual(receipt.upstreamError, upstreamError)
  assert.match(mediaIssueMessage({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', saveStatus: 'PENDING', error: null, upstreamError }, 'video')!, /参考内容被生成服务拒绝/)
})

test('receipt errors retain arbitrary JSON and sanitize arrays, headers and reconciliation details', () => {
  for (const body of [null, false, 123, ['First reason', { message: 'Second reason', details: [{ count: 2 }] }]]) {
    assert.deepEqual(mediaUpstreamErrorSchema.parse({ status: 200, body }).body, body)
    assert.deepEqual(safeMediaUpstreamError({ status: 200, body })?.body, body)
  }
  const result = safeMediaUpstreamError({ status: 422, body: { error: { code: 123, message: 'Unsupported image dimensions',
    details: [{ apiKey: 'hidden-key', observed: { width: 1300, height: 700 } }] },
    sepDiagnostics: [{ stage: 'billing', body: { message: 'Billing lookup failed', refreshToken: 'hidden-refresh' } }] },
    headers: { 'X-Upstream-Request-ID': 'provider-id', Authorization: 'Bearer hidden-token', 'Set-Cookie': 'hidden-cookie' } })!
  const body = result.body as { error: { code: number; details: { observed: { width: number } }[] }; sepDiagnostics: unknown[] }
  assert.equal(body.error.code, 123)
  assert.equal(body.error.details[0].observed.width, 1300)
  assert.ok(Array.isArray(body.sepDiagnostics))
  assert.deepEqual(result.headers, { 'x-upstream-request-id': 'provider-id' })
  assert.doesNotMatch(JSON.stringify(result), /hidden-key|hidden-refresh|hidden-token|hidden-cookie/)
})

for (const kind of ['image', 'video'] as const) {
  const load = (fetcher: typeof fetch, abort = signal) => {
    const options = { baseUrl: 'https://sep.invalid/api', token: async () => 'fixture-token', fetch: fetcher }
    return kind === 'image' ? new SepRealMediaGateway(options).getReceipt('sub', 'receipt', abort)
      : new SepRealVideoGateway({ ...options, mock: false, subscriptionId: 'sub' }).getReceipt('receipt', abort)
  }

  for (const body of ['Stale client run', { code: 123, message: 'Unsupported image dimensions', details: { width: 1300 } },
    { message: 'Invalid parameters', errors: [{ field: 'requestedSpec.count', message: 'Expected number' }] }]) {
    test(`${kind} keeps HTTP body, numeric codes and independent IDs through jobs and tools: ${typeof body}`, async () => {
      let calls = 0
      await assert.rejects(load(async () => {
        calls++
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 409, headers: {
          'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json',
          'X-Request-ID': 'sep-id', 'X-Compute-Request-ID': 'compute-id', 'X-Upstream-Request-ID': 'provider-id', 'Retry-After': '7',
        } })
      }), error => {
        assert.ok(error instanceof AppError)
        for (const diagnostic of [error.diagnostic, mediaJobFailure(error, `${kind}-query`).diagnostic,
          (kind === 'image' ? mediaToolFailureFrom(error) : videoToolFailureFrom(error)).error.diagnostic]) {
          assert.deepEqual(diagnostic?.body, body)
          assert.equal(diagnostic?.httpStatus, 409)
          assert.equal(diagnostic?.sepRequestId, 'sep-id')
          assert.equal(diagnostic?.computeRequestId, 'compute-id')
          assert.equal(diagnostic?.upstreamRequestId, 'provider-id')
          assert.equal(diagnostic?.headers?.['retry-after'], '7')
        }
        return true
      })
      assert.equal(calls, 1)
    })
  }

  test(`${kind} redacts the actual employment token echoed in an unfamiliar error`, async () => {
    await assert.rejects(load(async () => Response.json({ message: 'Denied fixture-token', apiKey: 'private-key',
      details: [{ message: 'Cookie: session=private-cookie' }], url: 'https://storage.invalid/?Signature=private-signature' }, { status: 502 })), error => {
      assert.ok(error instanceof AppError)
      assert.match(error.diagnostic?.message ?? '', /Denied/)
      assert.doesNotMatch(JSON.stringify(error), /fixture-token|private-key|private-cookie|private-signature|storage.invalid/)
      return true
    })
  })

  test(`${kind} treats HTTP 200/202 failed receipts as failed while retaining numeric errors and later diagnostics`, async () => {
    const upstreamError = { status: 200, body: { error: { code: 123, message: 'Unsupported image dimensions', details: [{ width: 1300 }] },
      sepDiagnostics: [{ stage: 'billing', body: { message: 'Lookup failed' } }] }, headers: { 'x-compute-request-id': 'compute-id' } }
    const common = { mock: false, receiptId: 'receipt', clientRequestId: 'client-id', profileId: 'profile', configVersion: 'config',
      status: 'FAILED', pollAfterMs: null, outputs: [], errorCode: null, billingStatus: 'RELEASED', upstreamError,
      recovery: { canQuery: false, canCancel: false, canDownload: false } }
    for (const status of [200, 202]) {
      const receipt = await load(async () => Response.json(kind === 'image' ? { ...common, executionMode: 'sync-response', outputErrors: [] }
        : { ...common, operation: 'text-to-video' }, { status }))
      assert.equal(receipt?.status, 'FAILED')
      assert.deepEqual(receipt?.upstreamError, upstreamError)
      assert.equal(receipt?.billingStatus, 'RELEASED')
    }
  })

  test(`${kind} redacts echoed credentials in successful receipt errors before storing them`, async () => {
    const common = { mock: false, receiptId: 'receipt', clientRequestId: 'client-id', profileId: 'profile', configVersion: 'config',
      status: 'FAILED', pollAfterMs: null, outputs: [], errorCode: null, billingStatus: 'RELEASED',
      upstreamError: { status: 200, body: { message: 'Image edit denied', details: [{ 'echo-fixture-token': 'fixture-token' }] },
        headers: { 'x-upstream-request-id': 'echo-fixture-token' } },
      recovery: { canQuery: false, canCancel: false, canDownload: false } }
    const receipt = await load(async () => Response.json(kind === 'image' ? { ...common, executionMode: 'sync-response', outputErrors: [] }
      : { ...common, operation: 'text-to-video' }))
    assert.match(JSON.stringify(receipt?.upstreamError), /Image edit denied/)
    assert.doesNotMatch(JSON.stringify(receipt?.upstreamError), /fixture-token/)
  })

  test(`${kind} preserves partial evidence when error reading fails or exceeds the byte budget`, async () => {
    let reads = 0
    const responses = [new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (++reads === 1) controller.enqueue(Buffer.from('Original failure reason'))
      else controller.error(new Error('connection reset'))
    } }), { status: 502 }), new Response('Failure '.repeat(12_000), { status: 502 })]
    for (const [index, response] of responses.entries()) {
      await assert.rejects(load(async () => response), error => {
        assert.ok(error instanceof AppError)
        assert.ok(typeof error.diagnostic?.body === 'string')
        if (index === 0) {
          assert.equal(error.diagnostic.body, 'Original failure reason')
          assert.match(error.diagnostic.readError ?? '', /connection reset/)
        } else assert.equal(error.diagnostic.truncated, true)
        return true
      })
    }
  })

  test(`${kind} retains network causes without fabricating an HTTP response`, async () => {
    await assert.rejects(load(async () => { throw new TypeError('fetch failed fixture-token', { cause: Object.assign(new Error('TLS connection reset fixture-token'), { code: 'ECONNRESET' }) }) }), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.diagnostic?.httpStatus, undefined)
      assert.match(JSON.stringify(error.diagnostic?.transportError), /TLS connection reset|ECONNRESET/)
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /fixture-token/)
      assert.doesNotMatch(JSON.stringify(redactValue(error)), /fixture-token/)
      return true
    })
  })

  test(`${kind} keeps upstream authorization distinct even when optional request metadata is malformed`, async () => {
    await assert.rejects(load(async () => Response.json({ error: { code: 'INVALID_API_KEY', source: 'upstream', requestId: [], message: 'Invalid API key' } }, { status: 401 })), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(error.diagnostic?.source, 'upstream')
      return true
    })
  })

  test(`${kind} cancels stalled error bodies without waiting for cancellation acknowledgement`, async () => {
    const abort = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let cancelled = false
    const pending = load(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('Partial reason')) },
      pull() { started() },
      cancel() { cancelled = true; return new Promise(() => {}) },
    }), { status: 502 }), abort.signal)
    const rejected = assert.rejects(pending)
    await ready
    abort.abort()
    await rejected
    assert.equal(cancelled, true)
  })

  test(`${kind} keeps token-acquisition upstream errors separate from desktop session expiry`, async () => {
    let calls = 0
    const options = { baseUrl: 'https://sep.invalid/api', token: async () => {
      throw new AuthApiError({ statusCode: 401, message: 'Invalid API key', diagnostic: { httpStatus: 401, source: 'upstream', body: { message: 'Invalid API key' } } })
    }, fetch: async () => { calls++; return Response.json({}) } }
    await assert.rejects(kind === 'image' ? new SepRealMediaGateway(options).getReceipt('sub', 'receipt', signal)
      : new SepRealVideoGateway({ ...options, mock: false, subscriptionId: 'sub' }).getReceipt('receipt', signal), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(error.diagnostic?.httpStatus, 401)
      return true
    })
    assert.equal(calls, 0)
  })
}
