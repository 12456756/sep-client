import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AppError } from '../errors/app-error'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoReceiptSchema, videoRequestSchema, videoRequestWithIdentitySchema } from '../../src/shared/video-media'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../common/platform/sep-media-gateway-contract'
import { config } from '../common/config'
import { SepMockVideoGateway, SepRealVideoGateway, SepVideoGatewayError } from './sep-video-media-gateway'
import { referenceImages } from './media-reference.test-helper'

const signal = new AbortController().signal
const bytes = Buffer.from('non-fixture video output')
const hash = createHash('sha256').update(bytes).digest('hex')
const output = { ...fixture.output, byteLength: bytes.length, sha256: hash, expiresAt: null }
const receipt = videoReceiptSchema.parse({ ...fixture.receipts.succeeded, mock: false, billingStatus: 'SETTLED',
  amountCny: '0.900000', actualCostCny: '0.800000', amountUsd: '0.12', outputs: [output] })
const quote = { ...fixture.quote, mock: false, billingStatus: 'NOT_RESERVED', amountCny: '0.900000', amountUsd: '0.12',
  pricingVersion: 'real-v1', usdToCnyRate: 7.5, funding: { creditCny: '0.500000', memberWalletCny: '0.400000', personalCny: '0.000000' } }
const requestedSpecV3 = { durationSeconds: 720, aspectRatio: '9:16', resolution: '8k', audio: false }
const billingDimensionsV3 = { model: 'provider-video-v1', operation: 'image-to-video' as const, durationSeconds: 720, resolution: '8k' }
const quoteV3 = { ...quote, protocolVersion: 3, semanticHashVersion: 3, specRevision: 2, effectiveSpec: requestedSpecV3, billingDimensions: billingDimensionsV3 }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function gateway(fetcher: typeof fetch) {
  return new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: 'sub-1', token: async () => 'employment-token', fetch: fetcher })
}

test('uploads one original video as authenticated multipart with profile/version and verified receipt', async () => {
  const original = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' })
  const sha256 = createHash('sha256').update(new Uint8Array(await original.arrayBuffer())).digest('hex')
  const progress: number[] = []
  const adapter = gateway(async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/api/gateway/v1/media/video-real/video-references')
    assert.equal(new URL(String(url)).searchParams.get('profileId'), 'video-profile')
    assert.equal(new URL(String(url)).searchParams.get('configVersion'), 'cfg-v3')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer employment-token')
    const form = await new Response(init?.body, { headers: init?.headers }).formData()
    assert.deepEqual([...form.keys()], ['file'])
    const file = form.get('file')
    assert.ok(file && typeof file !== 'string')
    assert.equal(file.type, 'video/mp4')
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3, 4]))
    return json({ mock: false, kind: 'video', referenceId: 'sep-video', profileId: 'video-profile', configVersion: 'cfg-v3',
      mimeType: 'video/mp4', byteLength: 4, sha256, expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201)
  })
  const result = await adapter.uploadVideoReference({ file: original, sha256, profileId: 'video-profile', configVersion: 'cfg-v3' }, signal, value => progress.push(value))
  assert.equal(result.referenceId, 'sep-video')
  assert.equal(progress.at(-1), 100)
})

test('rejects mismatched video reference receipts and preserves upstream upload errors', async () => {
  const input = { file: new Blob(['video'], { type: 'video/mp4' }), sha256: createHash('sha256').update('video').digest('hex'), profileId: 'video-profile', configVersion: 'cfg' }
  const adapter = gateway(async () => json({ mock: false, kind: 'video', referenceId: 'sep-video', profileId: 'other-profile', configVersion: 'cfg',
    mimeType: 'video/mp4', byteLength: 5, sha256: input.sha256, expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201))
  await assert.rejects(adapter.uploadVideoReference(input, signal), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
  const upstream = gateway(async () => new Response(JSON.stringify({ error: { code: 'VIDEO_REFERENCE_UPLOAD_FAILED', message: 'Channel unavailable' } }),
    { status: 401, headers: { 'Content-Type': 'application/json', 'X-SEP-Error-Source': 'upstream' } }))
  await assert.rejects(upstream.uploadVideoReference(input, signal), error => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'SERVICE_UNAVAILABLE'); assert.equal(error.diagnostic?.httpStatus, 401); return true
  })
})

test('uses the shared explicit non-submission contract beyond the legacy rejection whitelist', async () => {
  const request = videoRequestWithIdentitySchema.parse(fixture.request)
  for (const status of [400, 401, 402, 403, 404, 409, 410, 422, 429, 500, 502, 503, 504]) {
    const adapter = gateway(async () => json({ error: { code: 'NEW_PLATFORM_REJECTION', source: 'platform', requestId: 'sep-rejected',
      submissionState: 'not_submitted', billingState: 'unknown' } }, status))
    await assert.rejects(adapter.submit(request, signal), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.details?.submissionState, 'not_submitted')
      assert.equal(error.details?.billingState, 'unknown')
      assert.equal(error.details?.statusCode, status)
      return true
    })
  }
})

test('does not let legacy rejection codes override an explicit submitted or unknown result', async () => {
  for (const submissionState of ['submitted', 'unknown']) {
    const adapter = gateway(async () => json({ error: { code: 'INSUFFICIENT_FUNDS', source: 'platform', requestId: 'sep-1',
      submissionState, billingState: 'unknown' } }, 402))
    await assert.rejects(adapter.submit(videoRequestWithIdentitySchema.parse(fixture.request), signal), error => {
      assert.ok(error instanceof SepVideoGatewayError)
      assert.equal(error.definitelyRejected, false)
      assert.notEqual(error.details?.submissionConfirmedNotSent, true)
      return true
    })
  }
})

test('does not trust inconsistent submission evidence or apply it to query credential failures', async () => {
  const request = videoRequestWithIdentitySchema.parse(fixture.request)
  for (const source of ['upstream', 'provider']) {
    const adapter = gateway(async () => json({ error: { code: 'NEW_REJECTION', source, requestId: 'sep-rejected',
      submissionState: 'not_submitted', billingState: 'not_reserved' } }, 422))
    await assert.rejects(adapter.submit(request, signal), error => {
      assert.ok(error instanceof AppError); assert.equal(error.details?.submissionState, undefined); return true
    })
  }
  const adapter = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: 'sub-1',
    token: async () => { throw new AppError('AUTH_REQUIRED') }, fetch: async () => assert.fail('Must not fetch') })
  await assert.rejects(adapter.submit(request, signal), error => {
    assert.ok(error instanceof AppError); assert.equal(error.details?.submissionState, 'not_submitted'); return true
  })
  await assert.rejects(adapter.getReceipt('receipt-1', signal), error => {
    assert.ok(error instanceof AppError); assert.equal(error.details?.submissionState, undefined); return true
  })
})

test('accepts a recovered protocol-error receipt and redacts all original failure diagnostics', async () => {
  const value = { ...receipt, status: 'FAILED', outputs: [], receiptVersion: 2, fileStatus: 'unavailable',
    pollAfterMs: null, billingStatus: 'RELEASED', recovery: { canQuery: false, canDownload: false, canCancel: false },
    execution: { requestId: 'original-request', taskId: 'diagnostic-task', operation: 'query', submissionStatus: 'protocol_error',
      generationStatus: null, isFinal: null, observedAt: null, statusSource: 'cached', billing: { status: 'not_charged', actualCostUsd: '0' },
      submissionError: { message: 'Model mismatch employment-token', api_key: 'secret-creation-key' }, submissionHttpStatus: 502,
      submissionRecordError: { message: 'Record failed employment-token', token: 'secret-record-token' }, diagnosticTruncated: true },
    clientActions: { submissionFinished: true, generationFinished: true, shouldPoll: false,
      pollPurpose: 'none', canStartNewRequest: true, canRetryDownload: false } }
  const result = await gateway(async () => json(value)).getReceipt(receipt.receiptId, signal)
  assert.equal(result.execution?.submissionStatus, 'protocol_error')
  assert.equal(result.execution?.submissionHttpStatus, 502)
  assert.equal(result.clientActions?.generationFinished, true)
  assert.doesNotMatch(JSON.stringify(result), /employment-token|secret-creation-key|secret-record-token/)
})

test('receipt v2 preserves completed generation through delivery recovery and redacts new diagnostics', async () => {
  const value = { ...receipt, status: 'RUNNING', outputs: [], receiptVersion: 2, fileStatus: 'download_failed',
    pollAfterMs: 3000, billingStatus: 'RECONCILING', recovery: { canQuery: true, canDownload: false, canCancel: false },
    execution: { requestId: 'original-request', taskId: 'original-task', submissionStatus: 'accepted', generationStatus: 'completed',
      isFinal: true, observedAt: 100, statusSource: 'upstream', billing: { status: 'unknown', actualCostUsd: null },
      operationError: { status: 503, body: { message: 'download failed employment-token', api_key: 'private-secret' } } },
    clientActions: { submissionFinished: true, generationFinished: true, shouldPoll: true, pollPurpose: 'delivery', canStartNewRequest: true, canRetryDownload: true } }
  const result = await gateway(async () => json(value)).getReceipt(receipt.receiptId, signal)
  assert.equal(result.execution?.generationStatus, 'completed')
  assert.equal(result.fileStatus, 'download_failed')
  assert.equal(result.execution?.billing.actualCostUsd, null)
  assert.doesNotMatch(JSON.stringify(result), /employment-token|private-secret/)
})
async function collect(source: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}
function content(value = bytes, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(value), { headers: { 'Content-Type': 'video/mp4', ...headers } })
}

test('V3 video quote transmits requested specification without legacy parameters or injected defaults', async () => {
  const requestedSpec = { durationSeconds: 720, aspectRatio: '9:16', resolution: '8k', audio: false }
  const request = videoRequestSchema.parse({ ...fixture.quoteRequest, protocolVersion: 3, specRevision: 2,
    parameterSources: { durationSeconds: 'model', aspectRatio: 'user', resolution: 'model', audio: 'user' }, parameters: requestedSpec, requestedSpec })
  let calls = 0
  const adapter = gateway(async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    assert.equal('parameters' in body, false)
    assert.deepEqual(body.requestedSpec, requestedSpec)
    return json({ ...quoteV3, effectiveSpec: requestedSpec, billingDimensions: { ...billingDimensionsV3, durationSeconds: requestedSpec.durationSeconds, resolution: requestedSpec.resolution } })
  })
  const acceptedQuote = await adapter.quote(request, signal)
  assert.deepEqual(acceptedQuote.effectiveSpec, requestedSpec)
  assert.equal(acceptedQuote.protocolVersion, 3)
  assert.equal(acceptedQuote.specRevision, 2)
  assert.equal(calls, 1)
  const changed = gateway(async () => json({ ...quoteV3, effectiveSpec: { ...requestedSpec, durationSeconds: 4 } }))
  await assert.rejects(changed.quote(request, signal), { code: 'SPEC_CONFLICT' })
  await assert.rejects(gateway(async () => json(quote)).quote(request, signal), { code: 'SPEC_CONFLICT' })
  await assert.rejects(gateway(async () => json({ ...quoteV3, semanticHashVersion: undefined })).quote(request, signal), { code: 'SPEC_CONFLICT' })
  await assert.rejects(gateway(async () => json({ ...quoteV3, billingDimensions: { ...billingDimensionsV3, durationSeconds: 4 } })).quote(request, signal), { code: 'SPEC_CONFLICT' })
})

test('V3 receipt preserves SEP measured delivery evidence and rejects incomplete bindings', async () => {
  const request = videoRequestWithIdentitySchema.parse({ ...fixture.request, protocolVersion: 3, specRevision: 2,
    parameterSources: { durationSeconds: 'model', aspectRatio: 'user', resolution: 'model', audio: 'user' },
    parameters: requestedSpecV3, requestedSpec: requestedSpecV3 })
  const v3Receipt = { ...receipt, protocolVersion: 3, semanticHashVersion: 3, specRevision: 2,
    effectiveSpec: requestedSpecV3, billingDimensions: billingDimensionsV3, deliveryStatus: 'matched',
    actualSpec: { durationSeconds: 720, width: 1080, height: 1920, frameRate: 30, mimeType: 'video/mp4', hasAudio: false, source: 'measured' } }
  const adapter = gateway(async () => json(v3Receipt))
  const accepted = await adapter.submit(request, signal)
  assert.deepEqual(accepted.actualSpec, v3Receipt.actualSpec)
  assert.equal(accepted.deliveryStatus, 'matched')
  assert.equal(accepted.acceptance, 'matched')
  for (const invalid of [
    { ...v3Receipt, semanticHashVersion: undefined },
    { ...v3Receipt, billingDimensions: { ...billingDimensionsV3, resolution: '720p' } },
    { ...v3Receipt, deliveryStatus: 'unknown', acceptance: 'matched' },
    { ...v3Receipt, actualSpec: undefined },
  ]) {
    await assert.rejects(gateway(async () => json(invalid)).submit(request, signal))
  }
})

test('real adapter uses only SEP video-real paths and preserves actual quote metadata', async () => {
  const urls: string[] = []
  const adapter = gateway(async (url, init) => {
    urls.push(String(url))
    assert.equal(init?.redirect, 'manual')
    assert.equal(init?.credentials, 'omit')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer employment-token')
    assert.equal(new Headers(init?.headers).get('Origin'), config.SEP_WEB_ORIGIN)
    assert.equal(new Headers(init?.headers).get('Referer'), `${config.SEP_WEB_ORIGIN}/`)
    if (String(url).endsWith('/profiles')) return json({ mock: false, protocolVersion: 1, persistence: 'database', billingStatus: 'NOT_RESERVED', profiles: fixture.runtime.profiles })
    if (String(url).endsWith('/quotes')) return json(quote)
    return json(receipt)
  })
  assert.equal((await adapter.profiles(signal)).mock, false)
  const mapped = await adapter.quote(videoRequestSchema.parse(fixture.quoteRequest), signal)
  assert.equal(mapped.amount, '0.900000'); assert.equal(mapped.currency, 'CNY')
  assert.equal(mapped.amountUsd, '0.12'); assert.deepEqual(mapped.funding, quote.funding)
  assert.equal(mapped.usdToCnyRate, 7.5)
  await adapter.submit(videoRequestWithIdentitySchema.parse(fixture.request), signal)
  await adapter.findReceipt(receipt.clientRequestId, signal)
  await adapter.getReceipt(receipt.receiptId, signal)
  await adapter.cancel(receipt.receiptId, signal)
  assert.ok(urls.every(url => url.startsWith('https://sep.invalid/api/gateway/v1/media/video-real/')))
})

test('real output integrity uses the original receipt, never fixed fixture bytes or untrusted headers', async () => {
  for (const headers of [{}, { 'Content-Length': String(bytes.length), 'X-SHA256': hash }] as Record<string, string>[]) {
    const adapter = gateway(async url => String(url).endsWith('/content') ? content(bytes, headers) : json(receipt))
    assert.deepEqual(await collect(await adapter.content(receipt.receiptId, output.outputId, signal)), bytes)
  }
  for (const corrupt of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('x')]), Buffer.alloc(bytes.length)]) {
    const adapter = gateway(async url => String(url).endsWith('/content') ? content(corrupt) : json(receipt))
    await assert.rejects(async () => collect(await adapter.content(receipt.receiptId, output.outputId, signal)), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
  }
  for (const headers of [{ 'X-SHA256': '0'.repeat(64) }, { 'X-SEP-Media-Mock': 'true' }, { 'Content-Length': '268435457' }] as Record<string, string>[]) {
    const adapter = gateway(async url => String(url).endsWith('/content') ? content(bytes, headers) : json(receipt))
    await assert.rejects(adapter.content(receipt.receiptId, output.outputId, signal))
  }
})

test('real PNG upload is bounded and verifies the returned byte hash and dimensions', async () => {
  const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
  let calls = 0, wrongHash = false
  const adapter = gateway(async (_url, init) => {
    calls++
    assert.ok(init?.body instanceof FormData)
    assert.equal(new Headers(init.headers).get('Origin'), config.SEP_WEB_ORIGIN)
    assert.equal(new Headers(init.headers).get('Referer'), `${config.SEP_WEB_ORIGIN}/`)
    assert.equal(new Headers(init.headers).get('Content-Type'), null)
    return json({ mock: false, referenceId: 'ref-real', mimeType: 'image/png', byteLength: png.length,
      sha256: wrongHash ? '0'.repeat(64) : createHash('sha256').update(png).digest('hex'), width: 1, height: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString() })
  })
  for (const invalid of [Buffer.from('not PNG'), png.subarray(0, 30), Buffer.alloc(10 * 1024 * 1024 + 1)]) await assert.rejects(adapter.uploadReference(invalid, signal))
  assert.equal(calls, 0)
  assert.equal((await adapter.uploadReference(png, signal)).mock, false)
  wrongHash = true
  await assert.rejects(adapter.uploadReference(png, signal), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
})

for (const image of referenceImages) test(`video reference upload preserves ${image.mime} and rejects inconsistent MIME metadata`, async () => {
  let wrongMime = false
  const adapter = gateway(async (_url, init) => {
    assert.ok(init?.body instanceof FormData)
    const file = init.body.get('file') as Blob & { name: string }
    assert.equal(file.type, image.mime)
    assert.equal(file.name, `video-reference.${image.extension}`)
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), image.bytes)
    return json({ mock: false, referenceId: 'reference-real', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      mimeType: wrongMime ? (image.mime === 'image/png' ? 'image/jpeg' : 'image/png') : image.mime,
      byteLength: image.bytes.length, sha256: createHash('sha256').update(image.bytes).digest('hex'), width: 1, height: 1 })
  })
  assert.equal((await adapter.uploadReference(image.bytes, signal)).mimeType, image.mime)
  wrongMime = true
  await assert.rejects(adapter.uploadReference(image.bytes, signal), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
})

test('real video quote supplies the configured web origin independently of the API origin', async () => {
  let calls = 0
  const adapter = new SepRealVideoGateway({ mock: false, baseUrl: 'https://api.sep.invalid/api',
    webOrigin: 'https://web.sep.invalid/workspace', subscriptionId: 'sub-1', token: async () => 'offline-token',
    fetch: async (url, init) => {
      calls++
      assert.equal(String(url), 'https://api.sep.invalid/api/gateway/v1/media/video-real/quotes')
      const headers = new Headers(init?.headers)
      if (headers.get('Origin') !== 'https://web.sep.invalid' || headers.get('Referer') !== 'https://web.sep.invalid/') {
        return json({ message: 'Missing Origin or Referer header' }, 403)
      }
      return json(quote)
    } })
  assert.equal((await adapter.quote(videoRequestSchema.parse(fixture.quoteRequest), signal)).amount, '0.900000')
  assert.equal(calls, 1)
})

test('video transport rejects invalid web origins before token lookup or network access', () => {
  for (const webOrigin of ['not-a-url', 'file:///tmp/sep', 'https://user:password@web.sep.invalid']) {
    assert.throws(() => new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', webOrigin,
      subscriptionId: 'sub-1', token: async () => assert.fail('Must not acquire a token'),
      fetch: async () => assert.fail('Must not send a request') }), { gatewayCode: 'VIDEO_INVALID_REQUEST' })
  }
})

test('quote rejection is identified before approval and never exposes or retries the response body', async () => {
  let calls = 0
  const adapter = gateway(async () => { calls++; return json({ message: 'private-response-body' }, 403) })
  await assert.rejects(adapter.quote(videoRequestSchema.parse(fixture.quoteRequest), signal), {
    gatewayCode: 'VIDEO_HTTP_ERROR', code: 'PERMISSION_DENIED', statusCode: 403,
    details: { resource: 'video', stage: 'video-quote', gatewayCode: 'VIDEO_HTTP_ERROR', statusCode: 403 },
  })
  assert.equal(calls, 1)
})

test('video submission keeps safe business errors and only marks proven pre-reserve rejection', async () => {
  const adapter = gateway(async () => json({ error: { code: 'VIDEO_BUDGET_EXCEEDED', source: 'platform', requestId: 'req_safe-1', message: 'private' } }, 402))
  let error: unknown
  try { await adapter.submit(videoRequestWithIdentitySchema.parse(fixture.request), signal) } catch (caught) { error = caught }
  assert.ok(error instanceof SepVideoGatewayError)
  assert.equal(error.businessCode, 'VIDEO_BUDGET_EXCEEDED')
  assert.equal(error.definitelyRejected, true)
  assert.equal(error.requestId, 'req_safe-1')
  assert.equal(error.message, '已超过企业视频预算。')

  const uncertain = gateway(async () => json({ error: { code: 'VIDEO_BUDGET_EXCEEDED', requestId: 'bad id' } }, 402))
  let uncertainError: unknown
  try { await uncertain.submit(videoRequestWithIdentitySchema.parse(fixture.request), signal) } catch (caught) { uncertainError = caught }
  assert.ok(uncertainError instanceof SepVideoGatewayError)
  assert.equal(uncertainError.businessCode, null)
  assert.equal(uncertainError.definitelyRejected, false)
  assert.equal(uncertainError.requestId, null)
})

test('submit parses only a trusted platform rejection into a definitive business error', async () => {
  const trusted = gateway(async () => json({ error: { code: 'INSUFFICIENT_FUNDS', source: 'platform', requestId: 'platform-request-1', message: 'private details' } }, 402))
  const request = videoRequestWithIdentitySchema.parse(fixture.request)
  await assert.rejects(trusted.submit(request, signal), error => error instanceof SepVideoGatewayError &&
    error.code === 'INSUFFICIENT_FUNDS' && error.definitelyRejected === true && error.requestId === 'platform-request-1' &&
    !error.message.includes('private details'))

  const untrusted = gateway(async () => json({ error: { code: 'INSUFFICIENT_FUNDS', source: 'upstream' } }, 402))
  await assert.rejects(untrusted.submit(request, signal), error => error instanceof SepVideoGatewayError &&
    error.code === 'SERVICE_UNAVAILABLE' && error.definitelyRejected === false)
})

test('unknown, malformed or non-json submit errors remain uncertain while retaining safe codes', async () => {
  const request = videoRequestWithIdentitySchema.parse(fixture.request)
  const cases = [
    { response: json({ error: { code: 'INSUFFICIENT_FUNDS', source: 'platform' } }, 400), businessCode: 'INSUFFICIENT_FUNDS' },
    { response: json({ error: { code: 'UNKNOWN_INTERNAL', source: 'platform' } }, 402), businessCode: 'UNKNOWN_INTERNAL' },
    { response: new Response('<html>gateway failure</html>', { status: 402, headers: { 'Content-Type': 'text/html' } }), businessCode: null },
  ] as const
  for (const { response, businessCode } of cases) {
    const adapter = gateway(async () => response)
    await assert.rejects(adapter.submit(request, signal), error => error instanceof SepVideoGatewayError &&
      error.definitelyRejected === false && error.businessCode === businessCode)
  }
})

test('aborting while reading a non-success body remains an abort and releases the reader', async () => {
  const controller = new AbortController()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"error":')) },
    pull() { return new Promise<void>(() => undefined) },
    cancel() { cancelled = true },
  })
  const adapter = gateway(async () => new Response(body, { status: 402, headers: { 'Content-Type': 'application/json' } }))
  const pending = adapter.submit(videoRequestWithIdentitySchema.parse(fixture.request), controller.signal)
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, { gatewayCode: 'VIDEO_ABORTED' })
  assert.equal(cancelled, true)
})

test('definitive rejection requires matching status, platform source, submit stage and a safe request ID', async () => {
  const request = videoRequestWithIdentitySchema.parse(fixture.request)
  const valid = { code: 'INSUFFICIENT_FUNDS', source: 'platform', requestId: 'req-verified-1' }
  for (const [status, error] of [
    [402, { ...valid, requestId: undefined }],
    [402, { ...valid, requestId: 'bad id' }],
    [402, { ...valid, requestId: 123 }],
    [402, { ...valid, requestId: 'x'.repeat(129) }],
    [402, { ...valid, source: undefined }],
    [402, { ...valid, source: 'upstream' }],
    [402, { ...valid, source: { value: 'platform' } }],
    [402, { ...valid, code: undefined }],
    [402, { ...valid, code: 'UNKNOWN_INTERNAL' }],
    [403, valid], [409, valid], [500, valid],
  ] as const) {
    let calls = 0
    const adapter = gateway(async () => { calls++; return json({ error }, status) })
    await assert.rejects(adapter.submit(request, signal), caught => caught instanceof SepVideoGatewayError && !caught.definitelyRejected)
    assert.equal(calls, 1)
  }
  const adapter = gateway(async () => json({ error: valid }, 402))
  await assert.rejects(adapter.quote(videoRequestSchema.parse(fixture.quoteRequest), signal), error =>
    error instanceof SepVideoGatewayError && !error.definitelyRejected && error.stage === 'video-quote')
  await assert.rejects(adapter.getReceipt(receipt.receiptId, signal), error => error instanceof SepVideoGatewayError && !error.definitelyRejected)

  const headerOnly = gateway(async () => new Response(JSON.stringify({ error: { ...valid, requestId: undefined } }), {
    status: 402, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-header-1' },
  }))
  await assert.rejects(headerOnly.submit(request, signal), error => error instanceof SepVideoGatewayError && error.definitelyRejected && error.requestId === 'req-header-1')
})

test('invalid, oversized or conflicting evidence remains diagnostic and never proves submission rejection', async () => {
  const request = videoRequestWithIdentitySchema.parse(fixture.request)
  const valid = { code: 'INSUFFICIENT_FUNDS', source: 'platform', requestId: 'req-safe-1' }
  const bodies: Array<{ body: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string> }> = [
    { body: JSON.stringify({ error: valid }), headers: { 'Content-Type': 'text/html' } },
    { body: JSON.stringify({ error: [] }) },
    { body: JSON.stringify([{ error: valid }]) },
    { body: '{"error":' },
    { body: new Uint8Array([0xff, 0xfe]) },
    { body: JSON.stringify({ error: { ...valid, message: 'private'.repeat(1500) } }) },
    { body: JSON.stringify({ error: valid }), headers: { 'Content-Length': '9000' } },
    { body: JSON.stringify({ error: valid }), headers: { 'Content-Length': '1' } },
    { body: JSON.stringify({ error: valid }), headers: { 'x-request-id': 'conflicting-safe-id' } },
    { body: JSON.stringify({ error: valid }), headers: { 'x-request-id': 'bad id' } },
    { body: JSON.stringify({ error: { ...valid, requestId: 'bad id' } }), headers: { 'x-request-id': 'req-safe-1' } },
  ]
  for (const { body, headers } of bodies) {
    const adapter = gateway(async () => new Response(body, { status: 402, headers: { 'Content-Type': 'application/json', ...headers } }))
    await assert.rejects(adapter.submit(request, signal), error => error instanceof SepVideoGatewayError &&
      !error.definitelyRejected && error.businessCode === null && !error.message.includes('private') && error.diagnostic !== undefined)
  }
})

test('real and mock responses cannot cross modes, and POST failures are never retried', async () => {
  const adapter = gateway(async () => json(fixture.receipt))
  await assert.rejects(adapter.getReceipt(fixture.receipt.receiptId, signal), { gatewayCode: 'VIDEO_MODE_MISMATCH' })
  const mock = new SepMockVideoGateway({ mock: true, baseUrl: 'https://sep.invalid/api', subscriptionId: 'sub-1', token: async () => 'token', fetch: async () => json(receipt) })
  await assert.rejects(mock.getReceipt(receipt.receiptId, signal), { gatewayCode: 'VIDEO_MODE_MISMATCH' })
  let calls = 0
  const failed = gateway(async () => { calls++; return json({ secret: 'must-not-leak' }, 503) })
  await assert.rejects(failed.submit(videoRequestWithIdentitySchema.parse(fixture.request), signal), error => error instanceof Error && !error.message.includes('must-not-leak'))
  assert.equal(calls, 1)
  const redirect = gateway(async () => new Response(null, { status: 302, headers: { Location: 'https://provider.invalid' } }))
  await assert.rejects(redirect.getReceipt(receipt.receiptId, signal), { gatewayCode: 'VIDEO_REDIRECT_BLOCKED' })
})

test('real response rejects oversized output and unverified mock pricing', async () => {
  const oversized = gateway(async () => json({ ...receipt, outputs: [{ ...output, byteLength: 256 * 1024 * 1024 + 1 }] }))
  await assert.rejects(oversized.getReceipt(receipt.receiptId, signal), { gatewayCode: 'VIDEO_INVALID_RESPONSE' })
  await assert.rejects(gateway(async () => json(fixture.quote)).quote(videoRequestSchema.parse(fixture.quoteRequest), signal), { gatewayCode: 'VIDEO_MODE_MISMATCH' })
})

test('video specification errors retain safe diagnostics and discard raw upstream secrets', async () => {
  const adapter = gateway(async () => json({ error: { code: 'UPSTREAM_SPEC_UNSUPPORTED', source: 'provider', field: 'resolution', requestedValue: '8k',
    reasonCode: 'UNSUPPORTED_RESOLUTION', alternatives: [{ resolution: '1080p' }], submissionState: 'not_submitted', billingState: 'not_reserved', retryable: false,
    message: 'Bearer upstream-secret https://private.invalid', reason: 'token=private-secret', body: { apiKey: 'hidden-secret' } } }, 422))
  await assert.rejects(adapter.quote(videoRequestSchema.parse(fixture.quoteRequest), signal), (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'UPSTREAM_SPEC_UNSUPPORTED')
    assert.deepEqual(error.details, { source: 'provider', field: 'resolution', requestedValue: '8k', reasonCode: 'UNSUPPORTED_RESOLUTION', alternatives: [{ resolution: '1080p' }], submissionState: 'not_submitted', billingState: 'not_reserved', retryable: false,
      stage: 'video-quote', statusCode: 422, businessCode: 'UPSTREAM_SPEC_UNSUPPORTED' })
    assert.doesNotMatch(JSON.stringify(error), /secret|private\.invalid/)
    assert.match(JSON.stringify(error.diagnostic), /\[redacted\]/)
    return true
  })
})

test('malformed specification diagnostic types cannot crash error parsing or reflect upstream values', async () => {
  const adapter = gateway(async () => json({ error: { code: 'UPSTREAM_SPEC_UNSUPPORTED', field: { token: 'private-secret' },
    requestedValue: { raw: 'unexpected specification payload' }, source: ['provider'], reasonCode: 'https://private.invalid', alternatives: [{ resolution: '1080p' }] } }, 422))
  await assert.rejects(adapter.quote(videoRequestSchema.parse(fixture.quoteRequest), signal), (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'UPSTREAM_SPEC_UNSUPPORTED')
    assert.deepEqual(error.details, { alternatives: [{ resolution: '1080p' }], stage: 'video-quote', statusCode: 422, businessCode: 'UPSTREAM_SPEC_UNSUPPORTED' })
    assert.doesNotMatch(JSON.stringify(error), /private-secret|private\.invalid/)
    return true
  })
})
