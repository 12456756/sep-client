import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoReceiptSchema, videoRequestSchema, videoRequestWithIdentitySchema } from '../../src/shared/video-media'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../common/platform/sep-media-gateway-contract'
import { config } from '../common/config'
import { SepMockVideoGateway, SepRealVideoGateway } from './sep-video-media-gateway'

const signal = new AbortController().signal
const bytes = Buffer.from('non-fixture video output')
const hash = createHash('sha256').update(bytes).digest('hex')
const output = { ...fixture.output, byteLength: bytes.length, sha256: hash, expiresAt: null }
const receipt = videoReceiptSchema.parse({ ...fixture.receipts.succeeded, mock: false, billingStatus: 'SETTLED',
  amountCny: '0.900000', actualCostCny: '0.800000', amountUsd: '0.12', outputs: [output] })
const quote = { ...fixture.quote, mock: false, billingStatus: 'NOT_RESERVED', amountCny: '0.900000', amountUsd: '0.12',
  pricingVersion: 'real-v1', usdToCnyRate: 7.5, funding: { creditCny: '0.500000', memberWalletCny: '0.400000', personalCny: '0.000000' } }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function gateway(fetcher: typeof fetch) {
  return new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: 'sub-1', token: async () => 'employment-token', fetch: fetcher })
}
async function collect(source: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}
function content(value = bytes, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(value), { headers: { 'Content-Type': 'video/mp4', ...headers } })
}

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
    details: { resource: 'video', stage: 'video-quote' },
  })
  assert.equal(calls, 1)
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
