import { test, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { SepMediaGateway, SepMediaGatewayError, type SepMediaGatewayErrorCode } from './sep-media-gateway'
import { AppError } from '../errors/app-error'
import type { MediaRequest } from '../domain/media'
import { mediaCapabilitiesSchema, mediaQuoteSchema } from '../common/platform/media-contract'
import {
  SEP_MEDIA_MOCK_PNG_BASE64, SEP_MEDIA_MOCK_PNG_SHA256, SEP_MEDIA_MOCK_PROFILE_IDS,
  SEP_MEDIA_CONTENT_BUDGET, SEP_MEDIA_JSON_BUDGET, sepMediaMockExecutionMode,
} from '../common/platform/sep-media-gateway-contract'

const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
const signal = () => new AbortController().signal
const employmentToken = 'fixture-employment-not-a-real-token'
const expiresAt = '2030-01-02T03:04:05.000Z'
const wireProfiles = () => ({
  mock: true, protocolVersion: 1, persistence: 'database', billingStatus: 'MOCK_NOT_CHARGED',
  referenceFixtureBase64: SEP_MEDIA_MOCK_PNG_BASE64, referenceFixtureSha256: SEP_MEDIA_MOCK_PNG_SHA256,
  profiles: SEP_MEDIA_MOCK_PROFILE_IDS.map(profileId => ({
    profileId, configVersion: 'mock-v1', executionMode: sepMediaMockExecutionMode(profileId), operations: ['generate', 'edit'],
    capabilities: { supportsReferenceImage: true, sizes: ['1x1'], maxOutputs: 4 },
  })),
})
const wireReference = () => ({
  mock: true, referenceId: 'ref-1', expiresAt, mimeType: 'image/png', byteLength: png.length,
  width: 1, height: 1, sha256: SEP_MEDIA_MOCK_PNG_SHA256,
})
const request = (changes: Partial<MediaRequest> = {}): MediaRequest => {
  const value: MediaRequest = {
    clientRequestId: 'client-1', requestHash: '', quoteId: 'quote-1', profileId: 'mock-async', configVersion: 'mock-v1',
    operation: 'edit', referenceIds: ['ref-1'], referenceHashes: [SEP_MEDIA_MOCK_PNG_SHA256],
    creativeBrief: 'Fixture creative brief', parameters: { aspectRatio: '1:1', size: '1x1', count: 2 }, ...changes,
  }
  value.requestHash = createHash('sha256').update(JSON.stringify({
    profileId: value.profileId, configVersion: value.configVersion, operation: value.operation,
    creativeBrief: value.creativeBrief.trim(), parameters: { size: value.parameters.size ?? '1x1', count: value.parameters.count },
    references: value.referenceHashes,
  })).digest('hex')
  return value
}
const wireQuote = (semanticSha256 = request().requestHash) => ({
  mock: true, quoteId: 'quote-1', expiresAt, semanticSha256, pricingStatus: 'quoted', amountCny: '0.010000',
  pricingVersion: 'mock-v1', billingStatus: 'MOCK_NOT_CHARGED',
})
const wireReceipt = () => ({
  mock: true, receiptId: 'receipt-1', clientRequestId: 'client-1', profileId: 'mock-async', configVersion: 'mock-v1',
  executionMode: 'async-query', status: 'PARTIAL_SUCCEEDED', pollAfterMs: null,
  outputs: [{ outputId: 'output-1', kind: 'image', mimeType: 'image/png', byteLength: png.length,
    width: 1, height: 1, sha256: SEP_MEDIA_MOCK_PNG_SHA256, expiresAt }],
  billingStatus: 'MOCK_NOT_CHARGED', errorCode: null, outputErrors: [{ index: 1, code: 'OUTPUT_FAILED' }],
  recovery: { canQuery: false, canCancel: false, canDownload: true },
})

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function pngHeaders(response: ServerResponse, headers: Record<string, string> = {}): void {
  response.writeHead(200, {
    'Content-Type': 'image/png', 'X-SHA256': SEP_MEDIA_MOCK_PNG_SHA256,
    'X-SEP-Media-Mock': 'true', ...headers,
  })
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
async function loopback(t: TestContext, handler: Handler) {
  const server = createServer((incoming, response) => {
    Promise.resolve(handler(incoming, response)).catch(() => { response.destroy() })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const tokenCalls: string[] = []
  const token = async (subscriptionId: string, abort: AbortSignal) => {
    abort.throwIfAborted()
    tokenCalls.push(subscriptionId)
    return employmentToken
  }
  return { baseUrl, token, tokenCalls, gateway: new SepMediaGateway({ baseUrl, token }) }
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function errorCode(code: SepMediaGatewayErrorCode, statusCode?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof SepMediaGatewayError)
    assert.ok(error instanceof AppError)
    assert.equal(error.gatewayCode, code)
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode)
    assert.equal('cause' in error, false)
    assert.equal(error.message.includes(employmentToken), false)
    assert.equal(error.message.includes('upstream-private'), false)
    return true
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

for (const prefix of ['', '/api']) {
  test(`real HTTP covers all paths, DTOs, Bearer and mappings at ${prefix || 'root'}`, async t => {
    const requests: { url: string; method: string; data: Buffer; type?: string; auth?: string }[] = []
    const fixture = await loopback(t, async (incoming, response) => {
      const data = await body(incoming)
      requests.push({ url: incoming.url!, method: incoming.method!, data, type: incoming.headers['content-type'], auth: incoming.headers.authorization })
      switch (incoming.url) {
        case `${prefix}/gateway/v1/media/profiles`: json(response, wireProfiles()); break
        case `${prefix}/gateway/v1/media/references`: json(response, wireReference(), 201); break
        case `${prefix}/gateway/v1/media/quotes`: json(response, wireQuote(), 201); break
        case `${prefix}/gateway/v1/media/requests`: json(response, wireReceipt(), 202); break
        case `${prefix}/gateway/v1/media/requests/by-client-id/client-1`:
        case `${prefix}/gateway/v1/media/requests/receipt-1`: json(response, wireReceipt()); break
        case `${prefix}/gateway/v1/media/requests/receipt-1/cancel`: json(response, { ...wireReceipt(), status: 'CANCELLED', outputs: [], outputErrors: [], recovery: { canQuery: false, canCancel: false, canDownload: false } }, 201); break
        case `${prefix}/gateway/v1/media/requests/receipt-1/outputs/output-1/content`:
          pngHeaders(response, { 'Content-Length': String(png.length) }); response.end(png); break
        default: response.writeHead(404); response.end()
      }
    })
    const gateway = new SepMediaGateway({ baseUrl: `${fixture.baseUrl}${prefix}/`, token: fixture.token })
    assert.equal(gateway.quoteRequiresUploadedReferences, true)
    const profiles = await gateway.profiles('subscription-1', signal())
    mediaCapabilitiesSchema.parse(profiles.capabilities)
    assert.equal(profiles.persistence, 'database')
    assert.equal(profiles.referenceFixtureBase64, SEP_MEDIA_MOCK_PNG_BASE64)
    assert.equal(profiles.referenceFixtureSha256, SEP_MEDIA_MOCK_PNG_SHA256)
    assert.equal(profiles.capabilities.profiles.length, 9)
    for (const profile of profiles.capabilities.profiles) {
      assert.deepEqual(profile.allowedAspectRatios, ['1:1'])
      assert.deepEqual(profile.allowedSizes, ['1x1'])
      assert.equal(profile.maxCount, 4)
      assert.equal(profile.capabilities.recoverByRequestId, true)
    }
    assert.equal(profiles.capabilities.profiles.find(p => p.profileId === 'mock-no-cancel')!.capabilities.cancel, false)
    assert.equal(profiles.capabilities.profiles.find(p => p.profileId === 'mock-sync')!.capabilities.cancel, false)
    const reference = await gateway.uploadReference('subscription-1', { bytes: png, mime: 'image/png', sha256: SEP_MEDIA_MOCK_PNG_SHA256 }, signal())
    assert.deepEqual(reference, { referenceId: 'ref-1', sha256: SEP_MEDIA_MOCK_PNG_SHA256, expiresAt: Date.parse(expiresAt) })
    const quoted = await gateway.quote('subscription-1', request(), signal())
    mediaQuoteSchema.parse(quoted)
    assert.equal(quoted.requestHash, request().requestHash)
    assert.equal(quoted.amount, '0.010000')
    assert.equal(quoted.currency, 'CNY')
    const submitted = await gateway.submit('subscription-1', request(), signal())
    assert.equal(submitted.pollAfterMs, null)
    assert.equal(submitted.outputs[0].expiresAt, Date.parse(expiresAt))
    assert.equal(submitted.outputs[0].mime, 'image/png')
    assert.equal(submitted.outputs[0].size, png.length)
    assert.deepEqual(submitted.recovery, wireReceipt().recovery)
    assert.deepEqual(submitted.outputErrors, wireReceipt().outputErrors)
    assert.equal(submitted.errorCode, null)
    assert.equal('mock' in submitted, false)
    assert.equal('executionMode' in submitted, false)
    assert.deepEqual(await gateway.findReceipt('subscription-1', 'client-1', signal()), submitted)
    assert.deepEqual(await gateway.getReceipt('subscription-1', 'receipt-1', signal()), submitted)
    assert.equal((await gateway.cancel('subscription-1', 'receipt-1', signal())).status, 'CANCELLED')
    assert.deepEqual(await collect(await gateway.content('subscription-1', 'receipt-1', 'output-1', signal())), png)
    assert.equal(requests.length, 8)
    assert.equal(fixture.tokenCalls.length, 8)
    assert.ok(fixture.tokenCalls.every(id => id === 'subscription-1'))
    assert.ok(requests.every(value => value.auth === `Bearer ${employmentToken}` && !value.url.includes('?')))
    assert.deepEqual(requests.map(value => value.method), ['GET', 'POST', 'POST', 'POST', 'GET', 'GET', 'POST', 'GET'])
    const quoteBody = { profileId: 'mock-async', configVersion: 'mock-v1', operation: 'edit', referenceIds: ['ref-1'],
      creativeBrief: 'Fixture creative brief', parameters: { size: '1x1', count: 2 } }
    assert.deepEqual(JSON.parse(requests[2].data.toString()), quoteBody)
    assert.deepEqual(JSON.parse(requests[3].data.toString()), { ...quoteBody, clientRequestId: 'client-1', quoteId: 'quote-1' })
    assert.deepEqual(JSON.parse(requests[6].data.toString()), {})
    assert.equal(requests[2].type, 'application/json')
    const multipart = await new Response(new Uint8Array(requests[1].data), { headers: { 'Content-Type': requests[1].type! } }).formData()
    assert.deepEqual(Array.from(multipart.keys()), ['file'])
    const file = multipart.get('file')
    assert.ok(file && typeof file !== 'string')
    assert.equal(file.type, 'image/png')
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png)
  })
}

test('rejects unsafe base URLs without disclosing their credentials', () => {
  for (const baseUrl of ['bad', 'file:///api', 'ftp://example.com', 'https://user:upstream-private@example.com',
    'http://example.com?token=upstream-private', 'http://example.com#upstream-private', 'http://example.com?', 'http://example.com#']) {
    assert.throws(() => new SepMediaGateway({ baseUrl, token: async () => employmentToken }), errorCode('MEDIA_INVALID_BASE_URL'))
  }
  assert.doesNotThrow(() => new SepMediaGateway({ baseUrl: 'https://example.com/api/', token: async () => employmentToken }))
})

test('profiles rejects envelopes, unknown fields, invalid mocks, duplicate scenarios and forged fixtures', async t => {
  let value: unknown
  const { gateway } = await loopback(t, (_incoming, response) => json(response, value))
  const valid = wireProfiles()
  const variants: unknown[] = [
    { data: valid }, { ...valid, upstreamKey: 'upstream-private' }, { ...valid, mock: false },
    { ...valid, persistence: 'memory' }, { ...valid, referenceFixtureBase64: png.subarray(1).toString('base64') },
    { ...valid, referenceFixtureSha256: '0'.repeat(64) }, { ...valid, protocolVersion: 2 },
    { ...valid, profiles: [valid.profiles[0], valid.profiles[0]] },
    { ...valid, profiles: [{ ...valid.profiles[0], profileId: 'production-model' }] },
    { ...valid, profiles: [{ ...valid.profiles[0], configVersion: 'cfg-1' }] },
    { ...valid, profiles: [{ ...valid.profiles[0], executionMode: 'async-query' }] },
    { ...valid, profiles: [{ ...valid.profiles[0], capabilities: { ...valid.profiles[0].capabilities, maxOutputs: 5 } }] },
    { ...valid, profiles: [{ ...valid.profiles[0], capabilities: { ...valid.profiles[0].capabilities, sizes: ['1024x1024'] } }] },
    { ...valid, profiles: [{ ...valid.profiles[0], operations: ['generate', 'generate'] }] },
  ]
  for (value of variants) await assert.rejects(gateway.profiles('subscription-1', signal()), errorCode('MEDIA_INVALID_RESPONSE'))
})

test('strict response schemas reject extra fields and invalid quotes, references and receipt metadata', async t => {
  let value: unknown
  const { gateway } = await loopback(t, (_incoming, response) => json(response, value))
  for (value of [
    { ...wireQuote(), debug: 'upstream-private' }, { ...wireQuote(), mock: false },
    { ...wireQuote(), amountCny: null }, { ...wireQuote(), pricingStatus: 'unavailable' },
    { ...wireQuote(), expiresAt: 'yesterday' }, { ...wireQuote(), amountCny: '0.01' },
  ]) await assert.rejects(gateway.quote('subscription-1', request(), signal()), errorCode('MEDIA_INVALID_RESPONSE'))
  value = { ...wireReference(), url: 'https://upstream-private' }
  await assert.rejects(gateway.uploadReference('subscription-1', { bytes: png, mime: 'image/png', sha256: SEP_MEDIA_MOCK_PNG_SHA256 }, signal()), errorCode('MEDIA_INVALID_RESPONSE'))
  for (value of [
    { ...wireReceipt(), debug: 'upstream-private' }, { ...wireReceipt(), mock: false },
    { ...wireReceipt(), pollAfterMs: -1 }, { ...wireReceipt(), pollAfterMs: 0.5 },
    { ...wireReceipt(), errorCode: 'upstream-private' },
    { ...wireReceipt(), recovery: { ...wireReceipt().recovery, token: employmentToken } },
    { ...wireReceipt(), outputErrors: [{ index: 4, code: 'OUTPUT_FAILED' }] },
    { ...wireReceipt(), outputs: [{ ...wireReceipt().outputs[0], downloadUrl: 'https://upstream-private' }] },
    { ...wireReceipt(), outputs: [{ ...wireReceipt().outputs[0], mimeType: 'image/jpeg' }] },
  ]) await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), errorCode('MEDIA_INVALID_RESPONSE'))
})

test('receipt maps offset dates and uppercase SHA256 and preserves failure/recovery fields', async t => {
  const value = { ...wireReceipt(), status: 'FAILED', pollAfterMs: 1000, errorCode: 'UPSTREAM_FAILED',
    outputs: [{ ...wireReceipt().outputs[0], expiresAt: '2030-01-02T11:04:05+08:00', sha256: SEP_MEDIA_MOCK_PNG_SHA256.toUpperCase() }] }
  const { gateway } = await loopback(t, (_incoming, response) => json(response, value))
  const result = await gateway.getReceipt('subscription-1', 'receipt-1', signal())
  assert.equal(result.errorCode, 'UPSTREAM_FAILED')
  assert.equal(result.pollAfterMs, 1000)
  assert.equal(result.outputs[0].expiresAt, Date.parse(expiresAt))
  assert.equal(result.outputs[0].sha256, SEP_MEDIA_MOCK_PNG_SHA256)
  assert.deepEqual(result.outputErrors, value.outputErrors)
  assert.deepEqual(result.recovery, value.recovery)
})

test('quote verifies semanticSha256 and unavailable prices never authorize unknown spending', async t => {
  let value: unknown = wireQuote('0'.repeat(64))
  const { gateway } = await loopback(t, (_incoming, response) => json(response, value))
  await assert.rejects(gateway.quote('subscription-1', request(), signal()), errorCode('MEDIA_INTEGRITY_MISMATCH'))
  value = { ...wireQuote(), semanticSha256: request().requestHash.toUpperCase(), pricingStatus: 'unavailable', amountCny: null }
  const result = await gateway.quote('subscription-1', request(), signal())
  assert.equal(result.status, 'unavailable')
  assert.equal(result.amount, null)
  assert.equal(result.allowUnknownCost, false)
  assert.equal(result.requestHash, request().requestHash)
})

test('upload rejects anything except the fixed PNG/hash before acquiring a token', async t => {
  let requests = 0
  const fixture = await loopback(t, (_incoming, response) => { requests++; json(response, wireReference()) })
  for (const input of [
    { bytes: png, mime: 'image/jpeg' as const, sha256: SEP_MEDIA_MOCK_PNG_SHA256 },
    { bytes: png, mime: 'image/png' as const, sha256: '0'.repeat(64) },
    { bytes: png.subarray(1), mime: 'image/png' as const, sha256: SEP_MEDIA_MOCK_PNG_SHA256 },
    { bytes: Buffer.alloc(png.length), mime: 'image/png' as const, sha256: SEP_MEDIA_MOCK_PNG_SHA256 },
  ]) await assert.rejects(fixture.gateway.uploadReference('subscription-1', input, signal()), errorCode('INVALID_REFERENCE'))
  assert.equal(requests, 0)
  assert.equal(fixture.tokenCalls.length, 0)
})

test('upload verifies the returned reference hash, length and dimensions', async t => {
  let value: unknown
  const { gateway } = await loopback(t, (_incoming, response) => json(response, value))
  for (value of [{ ...wireReference(), sha256: '0'.repeat(64) }, { ...wireReference(), byteLength: 70 }, { ...wireReference(), width: 2 }]) {
    await assert.rejects(gateway.uploadReference('subscription-1', { bytes: png, mime: 'image/png', sha256: SEP_MEDIA_MOCK_PNG_SHA256 }, signal()), errorCode('MEDIA_INTEGRITY_MISMATCH'))
  }
})

test('request validation refuses path injection, unsupported parameters and duplicate/missing references', async t => {
  let requests = 0
  const fixture = await loopback(t, (_incoming, response) => { requests++; json(response, wireQuote()) })
  for (const parameters of [
    { aspectRatio: '16:9', count: 1 }, { aspectRatio: '1:1', size: '1024x1024', count: 1 },
    { aspectRatio: '1:1', quality: 'high', count: 1 }, { aspectRatio: '1:1', count: 5 },
  ]) await assert.rejects(fixture.gateway.quote('subscription-1', request({ parameters }), signal()), errorCode('UNSUPPORTED_MEDIA_PARAMETERS'))
  for (const input of [request({ profileId: 'production-model' }), request({ referenceIds: [] }), request({ referenceIds: ['ref-1', 'ref-1'] })]) {
    await assert.rejects(fixture.gateway.quote('subscription-1', input, signal()), errorCode('MEDIA_INVALID_REQUEST'))
  }
  await assert.rejects(fixture.gateway.quote('subscription-1', { ...request(), requestHash: 'upstream-private' }, signal()), errorCode('MEDIA_INVALID_REQUEST'))
  await assert.rejects(fixture.gateway.getReceipt('subscription-1', '../outside?token=upstream-private', signal()), errorCode('MEDIA_INVALID_REQUEST'))
  await assert.rejects(fixture.gateway.findReceipt('subscription-1', 'client/1', signal()), errorCode('MEDIA_INVALID_REQUEST'))
  await assert.rejects(fixture.gateway.content('subscription-1', 'receipt-1', '../output', signal()), errorCode('MEDIA_INVALID_REQUEST'))
  assert.equal(requests, 0)
  assert.equal(fixture.tokenCalls.length, 0)
})

test('default size and creativeBrief normalization send only the strict server DTO', async t => {
  const input = request({ operation: 'generate', referenceIds: [], referenceHashes: [], creativeBrief: '  Fixture creative brief  ', parameters: { aspectRatio: '1:1', count: 1 } })
  let sent: unknown
  const { gateway } = await loopback(t, async (incoming, response) => { sent = JSON.parse((await body(incoming)).toString()); json(response, wireQuote(input.requestHash)) })
  await gateway.quote('subscription-1', input, signal())
  assert.deepEqual(sent, { profileId: 'mock-async', configVersion: 'mock-v1', operation: 'generate', referenceIds: [],
    creativeBrief: 'Fixture creative brief', parameters: { size: '1x1', count: 1 } })
})

test('only 404 MEDIA_NOT_FOUND becomes null; other HTTP errors retain known codes but no upstream text', async t => {
  let status = 404
  let code: unknown = 'MEDIA_NOT_FOUND'
  const { gateway } = await loopback(t, (_incoming, response) => json(response, {
    message: `upstream-private ${employmentToken}`, error: { code, message: `upstream-private ${employmentToken}`, token: employmentToken },
  }, status))
  assert.equal(await gateway.findReceipt('subscription-1', 'client-1', signal()), null)
  for (const [nextStatus, nextCode, expected] of [
    [403, 'MEDIA_FORBIDDEN', 'MEDIA_FORBIDDEN'], [409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'],
    [503, 'MEDIA_STORAGE_UNAVAILABLE', 'MEDIA_STORAGE_UNAVAILABLE'], [503, 'MEDIA_MOCK_DISABLED', 'MEDIA_MOCK_DISABLED'],
    [429, 'MEDIA_RATE_LIMITED', 'MEDIA_RATE_LIMITED'], [404, 'MEDIA_FORBIDDEN', 'MEDIA_FORBIDDEN'],
    [503, 'MEDIA_NOT_FOUND', 'MEDIA_NOT_FOUND'], [401, null, 'AUTH_REQUIRED'],
    [404, 'upstream-private', 'MEDIA_HTTP_ERROR'], [404, null, 'MEDIA_HTTP_ERROR'],
  ] as const) {
    status = nextStatus; code = nextCode
    await assert.rejects(gateway.findReceipt('subscription-1', 'client-1', signal()), errorCode(expected, status))
  }
  status = 404; code = 'MEDIA_NOT_FOUND'
  await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), errorCode('MEDIA_NOT_FOUND', 404))
})

test('HTTP auth failures are AppErrors that pause service authorization while retaining safe gatewayCode', async t => {
  let status = 401
  let wireCode: unknown = 'AUTH_REQUIRED'
  let malformed = false
  const { gateway } = await loopback(t, (_incoming, response) => {
    if (malformed) { response.writeHead(status, { 'Content-Type': 'text/plain' }); response.end(`upstream-private ${employmentToken}`); return }
    json(response, { error: { code: wireCode, message: `upstream-private ${employmentToken}` } }, status)
  })
  for (const [nextStatus, nextCode, expectedAppCode, expectedGatewayCode] of [
    [401, 'AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED'],
    [401, 'UNAUTHORIZED', 'AUTH_REQUIRED', 'UNAUTHORIZED'],
    [401, 'upstream-private', 'AUTH_REQUIRED', 'AUTH_REQUIRED'],
    [403, 'MEDIA_FORBIDDEN', 'PERMISSION_DENIED', 'MEDIA_FORBIDDEN'],
    [403, 'FORBIDDEN', 'PERMISSION_DENIED', 'FORBIDDEN'],
    [403, 'PERMISSION_DENIED', 'PERMISSION_DENIED', 'PERMISSION_DENIED'],
    [403, 'upstream-private', 'PERMISSION_DENIED', 'PERMISSION_DENIED'],
  ] as const) {
    status = nextStatus; wireCode = nextCode
    const inspect = (error: unknown) => {
      errorCode(expectedGatewayCode, status)(error)
      assert.ok(error instanceof AppError)
      assert.equal(error.code, expectedAppCode)
      assert.equal(error.userMessage, error.message)
      assert.equal(error.details, undefined)
      return true
    }
    await assert.rejects(gateway.getReceipt('subscription-1', 'receipt-1', signal()), inspect)
    await assert.rejects(gateway.content('subscription-1', 'receipt-1', 'output-1', signal()), inspect)
  }
  malformed = true
  for (status of [401, 403]) {
    await assert.rejects(gateway.content('subscription-1', 'receipt-1', 'output-1', signal()), error => {
      errorCode('MEDIA_INVALID_RESPONSE', status)(error)
      assert.ok(error instanceof AppError)
      assert.equal(error.code, status === 401 ? 'AUTH_REQUIRED' : 'PERMISSION_DENIED')
      return true
    })
  }
})

test('token provider authorization failures are rebuilt as sanitized AppErrors', async t => {
  const { baseUrl } = await loopback(t, (_incoming, response) => json(response, wireProfiles()))
  for (const code of ['AUTH_REQUIRED', 'PERMISSION_DENIED'] as const) {
    const gateway = new SepMediaGateway({ baseUrl, token: async () => {
      throw new AppError(code, { message: `upstream-private ${employmentToken}`, cause: new Error(employmentToken), details: { private: employmentToken } })
    } })
    await assert.rejects(gateway.profiles('subscription-1', signal()), error => {
      errorCode(code)(error)
      assert.ok(error instanceof AppError)
      assert.equal(error.code, code)
      assert.equal(error.details, undefined)
      return true
    })
  }
})

test('business errors retain distinct gateway codes with existing AppError classifications', () => {
  for (const [gatewayCode, code] of [
    ['MEDIA_RATE_LIMITED', 'RATE_LIMITED'], ['MEDIA_NOT_FOUND', 'NOT_FOUND'],
    ['MEDIA_NETWORK_ERROR', 'NETWORK_ERROR'], ['INVALID_REFERENCE', 'INVALID_ARGUMENT'],
    ['IDEMPOTENCY_CONFLICT', 'INVALID_STATE'], ['RESULT_EXPIRED', 'INVALID_STATE'],
    ['MEDIA_STORAGE_UNAVAILABLE', 'SERVICE_UNAVAILABLE'], ['BUDGET_EXCEEDED', 'PERMISSION_DENIED'],
  ] as const) {
    const error = new SepMediaGatewayError(gatewayCode)
    assert.ok(error instanceof AppError)
    assert.equal(error.code, code)
    assert.equal(error.gatewayCode, gatewayCode)
    assert.equal(error.details, undefined)
    assert.equal('cause' in error, false)
  }
})

test('redirects are never followed, including same-origin redirects', async t => {
  let targetCalls = 0
  const destination = await loopback(t, (_incoming, response) => { targetCalls++; json(response, wireProfiles()) })
  let location = `${destination.baseUrl}/target`
  let status = 302
  const source = await loopback(t, (incoming, response) => {
    if (incoming.url === '/target') { targetCalls++; json(response, wireProfiles()); return }
    response.writeHead(status, { Location: location }); response.end()
  })
  for (status of [301, 302, 303, 307, 308]) {
    await assert.rejects(source.gateway.profiles('subscription-1', signal()), errorCode('MEDIA_REDIRECT_BLOCKED', status))
  }
  location = '/target'
  await assert.rejects(source.gateway.profiles('subscription-1', signal()), errorCode('MEDIA_REDIRECT_BLOCKED', 308))
  assert.equal(targetCalls, 0)
})

test('JSON requires content type, bare DTO, valid UTF-8 and a bounded declared or streamed body', async t => {
  let mode = ''
  const { gateway } = await loopback(t, (_incoming, response) => {
    if (mode === 'mime') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('upstream-private'); return }
    if (mode === 'length') { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(SEP_MEDIA_JSON_BUDGET + 1) }); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    if (mode === 'stream') { response.write(' '.repeat(SEP_MEDIA_JSON_BUDGET / 2)); response.end(' '.repeat(SEP_MEDIA_JSON_BUDGET / 2 + 1)); return }
    response.end(mode === 'utf8' ? Buffer.from([0xff]) : '{upstream-private')
  })
  for (const [nextMode, expected] of [['mime', 'MEDIA_INVALID_RESPONSE'], ['length', 'MEDIA_RESPONSE_TOO_LARGE'],
    ['stream', 'MEDIA_RESPONSE_TOO_LARGE'], ['utf8', 'MEDIA_INVALID_RESPONSE'], ['invalid', 'MEDIA_INVALID_RESPONSE']] as const) {
    mode = nextMode
    await assert.rejects(gateway.profiles('subscription-1', signal()), errorCode(expected))
  }
})

test('content rejects JSON, missing/forged headers and oversized declared bodies', async t => {
  let headers: Record<string, string> = {}
  let bytes = png
  const { gateway } = await loopback(t, (_incoming, response) => { pngHeaders(response, headers); response.end(bytes) })
  const badHeaders: Record<string, string>[] = [
    { 'Content-Type': 'application/json' }, { 'X-SHA256': '0'.repeat(64) },
    { 'X-SEP-Media-Mock': 'false' }, { 'X-SHA256': '' }, { 'X-SEP-Media-Mock': '' },
  ]
  for (const next of badHeaders) {
    headers = next
    await assert.rejects(gateway.content('subscription-1', 'receipt-1', 'output-1', signal()), errorCode('MEDIA_INVALID_RESPONSE'))
  }
  headers = { 'Content-Length': String(SEP_MEDIA_CONTENT_BUDGET + 1) }
  await assert.rejects(gateway.content('subscription-1', 'receipt-1', 'output-1', signal()), errorCode('MEDIA_RESPONSE_TOO_LARGE'))
  headers = {}
  bytes = Buffer.from('{"mock":true,"token":"upstream-private"}')
  await assert.rejects(collect(await gateway.content('subscription-1', 'receipt-1', 'output-1', signal())), errorCode('MEDIA_INTEGRITY_MISMATCH'))
})

test('chunked PNG content has a streaming budget and fixed-byte integrity verification', async t => {
  let mode = 'valid'
  const { gateway } = await loopback(t, (_incoming, response) => {
    pngHeaders(response)
    if (mode === 'large') { response.end(Buffer.alloc(SEP_MEDIA_CONTENT_BUDGET + 1)); return }
    if (mode === 'truncated') { response.end(png.subarray(0, -1)); return }
    if (mode === 'extra') { response.end(Buffer.concat([png, Buffer.from([0])])); return }
    response.write(png.subarray(0, 8))
    setTimeout(() => response.end(png.subarray(8)), 10)
  })
  assert.deepEqual(await collect(await gateway.content('subscription-1', 'receipt-1', 'output-1', signal())), png)
  for (mode of ['truncated', 'extra', 'large']) {
    await assert.rejects(collect(await gateway.content('subscription-1', 'receipt-1', 'output-1', signal())), error => {
      assert.ok(error instanceof SepMediaGatewayError)
      assert.ok(['MEDIA_RESPONSE_TOO_LARGE', 'MEDIA_INTEGRITY_MISMATCH'].includes(error.gatewayCode))
      return true
    })
  }
})

test('token and fetch failures are generalized, injected fetch receives secure request options', async t => {
  const { baseUrl } = await loopback(t, (_incoming, response) => json(response, wireProfiles()))
  for (const token of [async () => { throw new Error(`upstream-private ${employmentToken}`) }, async () => '', async () => 'bad\r\nheader']) {
    const gateway = new SepMediaGateway({ baseUrl, token })
    await assert.rejects(gateway.profiles('subscription-1', signal()), errorCode('MEDIA_AUTH_FAILED'))
  }
  const failing = new SepMediaGateway({ baseUrl, token: async () => employmentToken,
    fetch: async () => { throw new Error(`upstream-private ${employmentToken}`) } })
  await assert.rejects(failing.profiles('subscription-1', signal()), errorCode('MEDIA_NETWORK_ERROR'))
  const calls: RequestInit[] = []
  const gateway = new SepMediaGateway({ baseUrl, token: async () => employmentToken,
    fetch: (url, options) => { calls.push(options!); return fetch(url, options) } })
  await gateway.profiles('subscription-1', signal())
  assert.equal(calls[0].redirect, 'manual')
  assert.equal(calls[0].credentials, 'omit')
  assert.equal(calls[0].referrerPolicy, 'no-referrer')
})

test('abort before dispatch and during pending token never leaks custom abort reasons', async t => {
  let requests = 0
  const fixture = await loopback(t, (_incoming, response) => { requests++; json(response, wireProfiles()) })
  const controller = new AbortController()
  controller.abort(new Error(`upstream-private ${employmentToken}`))
  await assert.rejects(fixture.gateway.profiles('subscription-1', controller.signal), errorCode('MEDIA_ABORTED'))
  assert.equal(fixture.tokenCalls.length, 0)
  const pending = new SepMediaGateway({ baseUrl: fixture.baseUrl, token: () => new Promise<string>(() => undefined) })
  const next = new AbortController()
  const result = pending.profiles('subscription-1', next.signal)
  next.abort(`upstream-private ${employmentToken}`)
  await assert.rejects(result, errorCode('MEDIA_ABORTED'))
  assert.equal(requests, 0)
})

test('abort interrupts real HTTP waiting for response headers', async t => {
  const { gateway } = await loopback(t, () => undefined)
  const controller = new AbortController()
  const result = gateway.profiles('subscription-1', controller.signal)
  const timer = setTimeout(() => controller.abort(`upstream-private ${employmentToken}`), 30)
  t.after(() => clearTimeout(timer))
  await assert.rejects(result, errorCode('MEDIA_ABORTED'))
})

test('abort interrupts real HTTP JSON body and PNG streaming, and partial streams close safely', async t => {
  let mode = 'json'
  const { gateway } = await loopback(t, (_incoming, response) => {
    if (mode === 'json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); return }
    pngHeaders(response)
    response.write(png.subarray(0, 8))
  })
  const controller = new AbortController()
  const jsonResult = gateway.profiles('subscription-1', controller.signal)
  const timer = setTimeout(() => controller.abort(`upstream-private ${employmentToken}`), 30)
  t.after(() => clearTimeout(timer))
  await assert.rejects(jsonResult, errorCode('MEDIA_ABORTED'))
  mode = 'png'
  const next = new AbortController()
  const stream = await gateway.content('subscription-1', 'receipt-1', 'output-1', next.signal)
  const iterator = stream[Symbol.asyncIterator]()
  assert.deepEqual((await iterator.next()).value, new Uint8Array(png.subarray(0, 8)))
  const pending = iterator.next()
  next.abort(`upstream-private ${employmentToken}`)
  await assert.rejects(pending, errorCode('MEDIA_ABORTED'))
  const partial = (await gateway.content('subscription-1', 'receipt-1', 'output-1', signal()))[Symbol.asyncIterator]()
  await partial.next()
  await partial.return?.()
})
