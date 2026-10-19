import { describe, it, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SepRealMediaGateway } from './sep-real-media-gateway'
import { AppError } from '../errors/app-error'
import { toLocalMediaCapabilities } from '../common/platform/sep-media-runtime-contract'

const token = 'fixture-employment-token-not-real'
const request = { profileId: 'image-prod', configVersion: 'cfg-v1', operation: 'generate' as const, referenceIds: [], referenceHashes: [],
  requestHash: 'a'.repeat(64), creativeBrief: 'a red kite', parameters: { aspectRatio: '1:1', size: '1024x1024', count: 1, quality: 'high' } }
const receipt = { mock: false, receiptId: 'receipt-1', clientRequestId: 'request-1', profileId: 'image-prod', configVersion: 'cfg-v1',
  executionMode: 'sync-response', status: 'SUBMISSION_UNKNOWN', pollAfterMs: 1000, outputs: [], billingStatus: 'RECONCILING', errorCode: 'SUBMISSION_UNKNOWN',
  outputErrors: [], recovery: { canQuery: true, canCancel: false, canDownload: false } }

function create(fetcher: typeof fetch) {
  const calls: { url: string; method: string; auth: string | null; body: string }[] = []
  const gateway = new SepRealMediaGateway({ baseUrl: 'https://sep.example/api/', token: async () => token,
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('Authorization'), body: typeof init?.body === 'string' ? init.body : '' })
      return fetcher(input, init)
    } })
  return { gateway, calls }
}
const signal = () => new AbortController().signal
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const jsonBudget = 64 * 1024
const contentBudget = 25 * 1024 * 1024
const privateDetail = `${token} https://private.example/storage?credential=private-secret`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64')
const pngHeaders = { 'Content-Type': 'image/png', 'Content-Length': String(png.length),
  'X-SHA256': createHash('sha256').update(png).digest('hex'), 'X-SEP-Media-Mock': 'false' }

function safeError(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, expected)
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /fixture-employment-token|private\.example|private-secret/)
    return true
  }
}

function streamed(context: TestContext, parts: (Uint8Array | Error)[], init: ResponseInit, cancelFails = false) {
  const events: string[] = []
  let reads = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[reads++]
      if (part instanceof Error) controller.error(part)
      else if (part) controller.enqueue(part)
      else controller.close()
    },
    cancel() {
      events.push('body.cancel')
      if (cancelFails) throw new Error(privateDetail)
    },
  }, { highWaterMark: 0 })
  const response = new Response(body, init)
  const getReader = body.getReader.bind(body)
  context.mock.method(body, 'getReader', () => {
    const reader = getReader()
    const cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader)
    context.mock.method(reader, 'cancel', async () => { events.push('reader.cancel'); await cancel() })
    context.mock.method(reader, 'releaseLock', () => { events.push('reader.release'); release() })
    return reader
  })
  return { response, events, reads: () => reads, body }
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) { /* verify the entire stream */ }
}

describe('SepRealMediaGateway response lifecycle', () => {
  for (const [status, expected] of [[401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [500, 'SERVICE_UNAVAILABLE']] as const) {
    for (const cancelFails of [false, true]) {
      it(`maps content HTTP ${status} and cancels its body even if cancellation ${cancelFails ? 'fails' : 'succeeds'}`, async context => {
        const source = streamed(context, [Buffer.from(privateDetail)], { status }, cancelFails)
        const { gateway } = create(async () => source.response)
        await assert.rejects(gateway.content('subscription-1', 'receipt-1', 'output-1', signal()), safeError(expected))
        assert.deepEqual(source.events, ['body.cancel'])
        assert.equal(source.reads(), 0)
        assert.equal(source.body.locked, false)
      })
    }
  }

  for (const headers of [{ ...pngHeaders, 'Content-Type': 'text/html' }, { ...pngHeaders, 'Content-Length': String(contentBudget + 1) },
    { ...pngHeaders, 'X-SHA256': 'invalid' }, { ...pngHeaders, 'X-SEP-Media-Mock': 'true' }]) {
    it(`cancels invalid content headers ${JSON.stringify(headers)} before consuming bytes`, async context => {
      const source = streamed(context, [png], { headers }, true)
      const { gateway } = create(async () => source.response)
      await assert.rejects(gateway.content('subscription-1', 'receipt-1', 'output-1', signal()), safeError('SERVICE_UNAVAILABLE'))
      assert.deepEqual(source.events, ['body.cancel'])
      assert.equal(source.reads(), 0)
    })
  }

  for (const failure of ['read', 'length', 'budget', 'hash'] as const) {
    it(`cancels then releases content reader after ${failure} failure`, async context => {
      const parts = failure === 'read' ? [new Error(privateDetail)] : failure === 'budget'
        ? [Buffer.alloc(contentBudget + 1)] : [png]
      const headers = { ...pngHeaders, ...(failure === 'length' ? { 'Content-Length': String(png.length - 1) } : {}),
        ...(failure === 'budget' ? { 'Content-Length': String(contentBudget) } : {}), ...(failure === 'hash' ? { 'X-SHA256': '0'.repeat(64) } : {}) }
      const source = streamed(context, parts, { headers }, true)
      const { gateway } = create(async () => source.response)
      await assert.rejects(async () => drain(await gateway.content('subscription-1', 'receipt-1', 'output-1', signal())), safeError('SERVICE_UNAVAILABLE'))
      assert.ok(source.events.includes('reader.cancel'))
      assert.ok(source.events.indexOf('reader.cancel') < source.events.indexOf('reader.release'))
      assert.equal(source.body.locked, false)
      if (failure === 'budget' || failure === 'length') assert.equal(source.reads(), 1)
    })
  }

  it('cancels and unlocks content when its consumer stops early', async context => {
    const source = streamed(context, [png, Buffer.from(privateDetail)], { headers: pngHeaders }, true)
    const { gateway } = create(async () => source.response)
    for await (const chunk of await gateway.content('subscription-1', 'receipt-1', 'output-1', signal())) {
      assert.deepEqual(chunk, png)
      break
    }
    assert.deepEqual(source.events, ['reader.cancel', 'body.cancel', 'reader.release'])
    assert.equal(source.reads(), 1)
    assert.equal(source.body.locked, false)
  })

  for (const length of [undefined, '1']) {
    it(`enforces actual JSON bytes with ${length ? 'a false' : 'no'} Content-Length`, async context => {
      const source = streamed(context, [Buffer.alloc(jsonBudget, 0x20), Buffer.from('x'), Buffer.from(privateDetail)], {
        headers: { 'Content-Type': 'application/json', ...(length ? { 'Content-Length': length } : {}) },
      }, true)
      const { gateway } = create(async () => source.response)
      await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), safeError('SERVICE_UNAVAILABLE'))
      assert.equal(source.reads(), 2, 'Stop at the first byte over budget without reading the rest.')
      assert.deepEqual(source.events, ['reader.cancel', 'body.cancel', 'reader.release'])
      assert.equal(source.body.locked, false)
    })
  }

  for (const contentType of [undefined, 'text/html', 'text/plain', 'application/octet-stream']) {
    it(`rejects JSON Content-Type ${contentType ?? 'missing'} without reading the response`, async context => {
      const source = streamed(context, [Buffer.from(privateDetail)], { headers: contentType ? { 'Content-Type': contentType } : {} }, true)
      const { gateway } = create(async () => source.response)
      await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), safeError('SERVICE_UNAVAILABLE'))
      assert.equal(source.reads(), 0)
      assert.deepEqual(source.events, ['body.cancel'])
    })
  }

  it('cancels oversized advertised JSON before reading its body', async context => {
    const source = streamed(context, [Buffer.from(privateDetail)], {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(jsonBudget + 1) },
    }, true)
    const { gateway } = create(async () => source.response)
    await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), safeError('SERVICE_UNAVAILABLE'))
    assert.equal(source.reads(), 0)
    assert.deepEqual(source.events, ['body.cancel'])
  })

  it('accepts exactly 64KiB of chunked JSON without calling response.text()', async context => {
    const encoded = Buffer.from(JSON.stringify(receipt))
    const source = streamed(context, [encoded.subarray(0, 3), encoded.subarray(3), Buffer.alloc(jsonBudget - encoded.length, 0x20)], {
      headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
    })
    context.mock.method(source.response, 'text', async () => { assert.fail('JSON must be read with a bounded reader.') })
    const { gateway } = create(async () => source.response)
    assert.equal((await gateway.getReceipt('subscription-1', 'receipt-1', signal())).receiptId, receipt.receiptId)
    assert.deepEqual(source.events, ['reader.release'])
    assert.equal(source.body.locked, false)
  })

  for (const failure of ['read', 'parse', 'schema'] as const) {
    it(`sanitizes JSON ${failure} failure and cancels before unlocking`, async context => {
      const source = streamed(context, [failure === 'read' ? new Error(privateDetail)
        : Buffer.from(failure === 'parse' ? privateDetail : JSON.stringify({ secret: privateDetail }))], { headers: { 'Content-Type': 'application/json' } })
      const { gateway } = create(async () => source.response)
      await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), safeError('SERVICE_UNAVAILABLE'))
      assert.ok(source.events.indexOf('reader.cancel') >= 0)
      assert.ok(source.events.indexOf('reader.cancel') < source.events.indexOf('reader.release'))
      assert.equal(source.body.locked, false)
    })
  }

  for (const [status, expected] of [[401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [404, 'NOT_FOUND']] as const) {
    it(`retains JSON HTTP ${status} mapping without parsing its error body`, async context => {
      const source = streamed(context, [Buffer.from(privateDetail)], { status }, true)
      const { gateway } = create(async () => source.response)
      await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), safeError(expected))
      assert.deepEqual(source.events, ['body.cancel'])
      assert.equal(source.reads(), 0)
    })
  }
})

describe('SepRealMediaGateway', () => {
  it('sends the configured Web origin on JSON writes, uploads and recovery requests', async () => {
    const calls: string[] = []
    const gateway = new SepRealMediaGateway({ baseUrl: 'https://api.example/api/',
      webOrigin: 'https://WEB.example:443/workspace', token: async () => token,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('Origin'), 'https://web.example')
        assert.equal(headers.get('Referer'), 'https://web.example/')
        assert.equal(headers.get('Authorization'), `Bearer ${token}`)
        calls.push(`${init?.method} ${new URL(String(input)).pathname}`)
        return json({}, 403)
      } })
    await assert.rejects(gateway.quote('subscription-1', request, signal()), safeError('PERMISSION_DENIED'))
    await assert.rejects(gateway.submit('subscription-1', { ...request, clientRequestId: 'request-1', quoteId: 'quote-1' }, signal()), safeError('PERMISSION_DENIED'))
    await assert.rejects(gateway.uploadReference('subscription-1', { bytes: png, mime: 'image/png', sha256: pngHeaders['X-SHA256'] }, signal()), safeError('PERMISSION_DENIED'))
    await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), safeError('PERMISSION_DENIED'))
    await assert.rejects(gateway.cancel('subscription-1', 'receipt-1', signal()), safeError('PERMISSION_DENIED'))
    await assert.rejects(gateway.content('subscription-1', 'receipt-1', 'output-1', signal()), safeError('PERMISSION_DENIED'))
    assert.equal(calls.length, 6)
  })

  it('posts once and queries the original client request ID after an unknown result', async () => {
    const { gateway, calls } = create(async (_input, init) => init?.method === 'POST' ? json(receipt, 202) : json(receipt))
    const result = await gateway.submit('subscription-1', { ...request, clientRequestId: 'request-1', quoteId: 'quote-1' }, signal())
    assert.equal(result.status, 'SUBMISSION_UNKNOWN')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'https://sep.example/api/gateway/v1/media/real/requests')
    assert.equal(calls[0]?.auth, `Bearer ${token}`)
    const found = await gateway.findReceipt('subscription-1', 'request-1', signal())
    assert.equal(found?.clientRequestId, 'request-1')
    assert.equal(calls[1]?.url, 'https://sep.example/api/gateway/v1/media/real/requests/by-client-id/request-1')
    assert.equal(calls[1]?.method, 'GET')
  })

  it('rejects fake, unavailable, malformed and expired quote responses', async () => {
    const valid = { mock: false, quoteId: 'quote-1', expiresAt: new Date(Date.now() + 60_000).toISOString(), semanticSha256: 'a'.repeat(64),
      pricingStatus: 'quoted', amountCny: '0.120000', pricingVersion: 'price-v1', billingStatus: 'NOT_RESERVED',
      funding: { creditCny: '1.000000', memberWalletCny: '2.000000', personalCny: '3.000000' } }
    const good = create(async () => json(valid))
    const quote = await good.gateway.quote('subscription-1', request, signal())
    assert.equal(quote.amount, '0.120000')
    assert.equal(quote.currency, 'CNY')
    for (const invalid of [{ ...valid, mock: true }, { ...valid, pricingStatus: 'unavailable' }, { ...valid, amountCny: 'unknown' },
      { ...valid, expiresAt: 'not-a-date' }]) {
      const { gateway } = create(async () => json(invalid))
      await assert.rejects(gateway.quote('subscription-1', request, signal()), error => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE')
    }
  })

  it('maps real runtime tools onto the local media tool contract without changing mock capabilities', () => {
    const mapped = toLocalMediaCapabilities({ mock: false, protocolVersion: 1, persistence: 'database', tools: ['image_generate', 'image_edit'], profiles: [{
      profileId: 'image-prod', kind: 'image', displayName: 'Production image', configVersion: 'cfg-v1', operations: ['generate', 'edit'], executionMode: 'sync-response',
      capabilities: { supportsReferenceImage: true, maxOutputs: 4, sizes: ['1024x1024', '1536x1024'], maxWidth: 1536, maxHeight: 1024 },
    }] })
    assert.ok(mapped.tools.includes('media_generate_image'))
    assert.deepEqual(mapped.profiles[0]?.allowedAspectRatios, ['1:1', '3:2'])
    assert.deepEqual(toLocalMediaCapabilities({ protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles: [] }),
      { protocolVersion: 1, tools: [], profiles: [] })
  })

  it('returns a verified output stream and sanitizes malformed storage responses', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64')
    const hash = createHash('sha256').update(png).digest('hex')
    const { gateway } = create(async () => new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length),
      'X-SHA256': hash, 'X-SEP-Media-Mock': 'false' } }))
    const chunks: Buffer[] = []
    for await (const chunk of await gateway.content('subscription-1', 'receipt-1', 'output-1', signal())) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), png)
    const { gateway: bad } = create(async () => new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length),
      'X-SHA256': '0'.repeat(64), 'X-SEP-Media-Mock': 'false' } }))
    await assert.rejects(async () => { for await (const _chunk of await bad.content('subscription-1', 'receipt-1', 'output-1', signal())) { /* drain */ } },
      error => error instanceof AppError && !error.message.includes(token))
  })
})
