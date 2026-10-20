import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoRequestSchema, videoRequestWithIdentitySchema } from '../../src/shared/video-media'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../common/platform/sep-media-gateway-contract'
import { SepMockVideoGateway, SepVideoGatewayError } from './sep-video-media-gateway'
import { AppError } from '../errors/app-error'

const signal = new AbortController().signal
const video = Buffer.from(fixture.mediaFixture.base64, 'base64')
const request = videoRequestWithIdentitySchema.parse(fixture.request)
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}
function content(bytes = video): Response {
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length), 'X-SEP-Media-Mock': 'true', 'X-SHA256': fixture.output.sha256 } })
}
function gateway(fetcher: typeof fetch) {
  return new SepMockVideoGateway({ mock: true, baseUrl: 'http://127.0.0.1:3001/api/', subscriptionId: 'sub-1', token: async subscriptionId => {
    assert.equal(subscriptionId, 'sub-1')
    return 'test-employment-token'
  }, fetch: fetcher })
}
async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('mock video HTTP maps the shared profile, quote, submit and receipt contracts', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const adapter = gateway(async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    assert.equal(init?.redirect, 'manual')
    assert.equal(init?.credentials, 'omit')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-employment-token')
    if (url.endsWith('/profiles')) return json({ mock: true, protocolVersion: 1, persistence: 'database', billingStatus: 'MOCK_NOT_CHARGED', profiles: fixture.runtime.profiles })
    if (url.endsWith('/quotes')) return json(fixture.quote)
    if (url.endsWith('/requests')) return json(fixture.receipt, 202)
    return json(fixture.receipt)
  })
  assert.equal((await adapter.profiles(signal)).persistence, 'database')
  assert.equal((await adapter.quote(videoRequestSchema.parse(fixture.quoteRequest), signal)).requestHash, fixture.quote.semanticSha256)
  assert.equal((await adapter.submit(request, signal)).receiptId, fixture.receipt.receiptId)
  assert.equal((await adapter.findReceipt(request.clientRequestId, signal))?.receiptId, fixture.receipt.receiptId)
  assert.equal((await adapter.getReceipt(fixture.receipt.receiptId, signal)).status, 'QUEUED')
  assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:3001/api/gateway/v1/media/video/')))
  assert.deepEqual(JSON.parse(calls[2]!.init!.body as string), request)
})

test('mock video reference upload accepts only the fixture and verifies returned hash', async () => {
  let calls = 0
  const adapter = gateway(async (_input, init) => {
    calls++
    assert.ok(init?.body instanceof FormData)
    return json({ mock: true, referenceId: 'reference-image-1', expiresAt: '2026-10-20T00:00:00Z', mimeType: 'image/png', byteLength: 1, sha256: 'a'.repeat(64), width: 1, height: 1 })
  })
  await assert.rejects(adapter.uploadReference(new Uint8Array([1, 2]), signal), { gatewayCode: 'VIDEO_INVALID_REQUEST' })
  assert.equal(calls, 0)
  await assert.rejects(adapter.uploadReference(Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64'), signal), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
})

test('mock video HTTP streams only the fixture with complete hash and byte budget checks', async () => {
  const adapter = gateway(async () => content())
  assert.deepEqual(await collect(await adapter.content('video-receipt-1', 'video-output-1', signal)), video)
  const corrupt = Buffer.from(video)
  corrupt[corrupt.length - 1] ^= 0xff
  const corrupted = gateway(async () => content(corrupt))
  await assert.rejects(collect(await corrupted.content('video-receipt-1', 'video-output-1', signal)), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
  const truncated = gateway(async () => content(video.subarray(0, 100)))
  await assert.rejects(collect(await truncated.content('video-receipt-1', 'video-output-1', signal)), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
})

test('mock video HTTP blocks redirects and invalid paths before provider access', async () => {
  let calls = 0
  const adapter = gateway(async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://supplier.invalid/private' } }) })
  await assert.rejects(adapter.getReceipt('../other', signal), { gatewayCode: 'VIDEO_INVALID_REQUEST' })
  assert.equal(calls, 0)
  await assert.rejects(adapter.getReceipt('receipt-1', signal), { gatewayCode: 'VIDEO_REDIRECT_BLOCKED' })
  assert.equal(calls, 1)
  assert.throws(() => new SepMockVideoGateway({ mock: true, baseUrl: 'https://secret:password@example.invalid', subscriptionId: 'sub-1', token: async () => '' }), { gatewayCode: 'VIDEO_INVALID_REQUEST' })
})

test('HTTP submission has no automatic retry and never surfaces upstream error bodies', async () => {
  let calls = 0
  const adapter = gateway(async () => { calls++; return json({ apiKey: 'secret-provider-key', url: 'https://private.invalid' }, 503) })
  await assert.rejects(adapter.submit(request, signal), error => error instanceof SepVideoGatewayError && error.statusCode === 503 && !error.message.includes('secret-provider-key'))
  assert.equal(calls, 1)
})

test('mock video HTTP preserves authorization, rate and cancel errors without resubmission', async () => {
  for (const [status, code] of [[400, 'INVALID_ARGUMENT'], [401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [409, 'INVALID_STATE'], [410, 'INVALID_STATE'], [429, 'RATE_LIMITED']] as const) {
    const adapter = gateway(async () => json({}, status))
    await assert.rejects(adapter.cancel('video-receipt-1', signal), { code, statusCode: status })
  }
  const missing = gateway(async () => json({}, 404))
  assert.equal(await missing.findReceipt('video-request-1', signal), null)
  const unavailable = gateway(async () => json({}, 503))
  await assert.rejects(unavailable.findReceipt('video-request-1', signal), { statusCode: 503 })
})

test('authentication failure preserves safe error categories and redacts token provider messages', async () => {
  const adapter = new SepMockVideoGateway({ mock: true, baseUrl: 'http://localhost/api', subscriptionId: 'sub-1', token: async () => {
    throw new AppError('NETWORK_ERROR', { message: 'private-token-provider-secret' })
  } })
  await assert.rejects(adapter.getReceipt('receipt-1', signal), error => error instanceof SepVideoGatewayError && error.code === 'NETWORK_ERROR' && !error.message.includes('private-token-provider-secret'))
})

test('mock video HTTP validates the returned request and receipt identity', async () => {
  const adapter = gateway(async () => json({ ...fixture.receipt, clientRequestId: 'foreign-request' }))
  await assert.rejects(adapter.submit(request, signal), { gatewayCode: 'VIDEO_RECEIPT_MISMATCH' })
  await assert.rejects(adapter.findReceipt(request.clientRequestId, signal), { gatewayCode: 'VIDEO_RECEIPT_MISMATCH' })
  await assert.rejects(adapter.getReceipt('foreign-receipt', signal), { gatewayCode: 'VIDEO_RECEIPT_MISMATCH' })
})

test('mock video HTTP bounds JSON and content before reading bodies', async () => {
  const hugeJson = gateway(async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024) } }))
  await assert.rejects(hugeJson.getReceipt('receipt-1', signal), { gatewayCode: 'VIDEO_RESPONSE_TOO_LARGE' })
  const hugeVideo = gateway(async () => new Response('x', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(1024 * 1024) } }))
  await assert.rejects(hugeVideo.content('receipt-1', 'out-1', signal), { gatewayCode: 'VIDEO_RESPONSE_TOO_LARGE' })
  const badJson = gateway(async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(badJson.getReceipt('receipt-1', signal), { gatewayCode: 'VIDEO_INVALID_RESPONSE' })
})

test('aborting stalled authentication and stalled output stops without retrying submit', async () => {
  const authAbort = new AbortController()
  const adapter = new SepMockVideoGateway({ mock: true, baseUrl: 'http://localhost/api', subscriptionId: 'sub-1', token: async () => new Promise<string>(() => undefined) })
  const pending = adapter.submit(request, authAbort.signal)
  authAbort.abort()
  await assert.rejects(pending)
  let cancelled = false
  const streaming = gateway(async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'Content-Type': 'video/mp4', 'X-SEP-Media-Mock': 'true', 'X-SHA256': fixture.output.sha256 } }))
  const abort = new AbortController()
  const reading = collect(await streaming.content('receipt-1', 'output-1', abort.signal))
  abort.abort()
  await assert.rejects(reading)
  assert.equal(cancelled, true)
})
