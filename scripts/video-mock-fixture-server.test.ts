import * as assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { test, type TestContext } from 'node:test'
import * as fixture from '../src/shared/fixtures/media-video-v1.json'
import { videoRequestSchema, type VideoReceipt } from '../src/shared/video-media'
import { SEP_MEDIA_MOCK_PNG_BASE64, SEP_MEDIA_MOCK_PNG_SHA256 } from '../electron/common/platform/sep-media-gateway-contract'
import { SepMockVideoGateway } from '../electron/data/sep-video-media-gateway'
import { MOCK_VIDEO_BYTES } from '../electron/data/mock-video-media-gateway'
import {
  startVideoMockFixture, VIDEO_MOCK_FIXTURE_TOKEN, VIDEO_MOCK_FIXTURE_BODY_LIMIT,
  type VideoMockFixture, type VideoMockFixtureState,
} from './video-mock-fixture-server'

const signal = new AbortController().signal
const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
const headers = { Authorization: `Bearer ${VIDEO_MOCK_FIXTURE_TOKEN}` }
const path = '/gateway/v1/media/video'

async function setup(t: TestContext) {
  const server = await startVideoMockFixture()
  t.after(() => server.close())
  return { server, gateway: adapter(server) }
}

function adapter(server: VideoMockFixture) {
  return new SepMockVideoGateway({ mock: true, baseUrl: server.baseUrl,
    subscriptionId: 'synthetic-subscription', token: async () => VIDEO_MOCK_FIXTURE_TOKEN })
}

async function prepared(gateway: SepMockVideoGateway) {
  const reference = await gateway.uploadReference(png, signal)
  const body = videoRequestSchema.parse({ ...fixture.quoteRequest, referenceIds: [reference.referenceId] })
  const quote = await gateway.quote(body, signal)
  return { body, quote }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

interface Evidence {
  mock: true
  simulationOnly: true
  closed: boolean
  state: VideoMockFixtureState
  receipts: { scenario: VideoMockFixtureState['scenario']; receipt: VideoReceipt }[]
  markers: { phase: string; path: string; status: number | null; receiptStatus?: string }[]
  gatewayCalls: Record<VideoMockFixtureState['scenario'], { getReceipt: number; submit: number; quote: number }>
}

test('synthetic fixture roundtrips real HTTP adapter contracts and survives adapter restarts', async t => {
  const { server, gateway } = await setup(t)
  const url = new URL(server.baseUrl)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.pathname, '/api')
  assert.ok(Number(url.port) > 0)
  const profiles = await gateway.profiles(signal)
  assert.equal(profiles.mock, true)
  assert.equal(profiles.persistence, 'memory')
  assert.deepEqual(profiles.profiles, fixture.runtime.profiles)
  const reference = await gateway.uploadReference(png, signal)
  assert.equal(reference.sha256, SEP_MEDIA_MOCK_PNG_SHA256)
  assert.equal(reference.byteLength, png.length)
  assert.equal(reference.width, 1)
  assert.equal(reference.height, 1)
  const body = videoRequestSchema.parse({ ...fixture.quoteRequest, referenceIds: [reference.referenceId] })
  const quote = await gateway.quote(body, signal)
  assert.match(quote.requestHash, /^[a-f0-9]{64}$/)
  assert.equal(quote.amount, '0.000000')
  assert.equal(quote.currency, 'MOCK')
  assert.ok(quote.expiresAt > Date.now())
  const input = { ...body, clientRequestId: 'synthetic-restart', quoteId: quote.quoteId }
  const queued = await gateway.submit(input, signal)
  assert.equal(queued.status, 'QUEUED')
  assert.equal(queued.pollAfterMs, 300)
  assert.equal((await gateway.getReceipt(queued.receiptId, signal)).status, 'RUNNING')

  server.state.phase = 'after-electron-restart'
  const restarted = adapter(server)
  assert.equal((await restarted.findReceipt(input.clientRequestId, signal))?.status, 'RUNNING')
  const done = await restarted.getReceipt(queued.receiptId, signal)
  assert.equal(done.status, 'SUCCEEDED')
  assert.equal(done.pollAfterMs, null)
  assert.equal(done.billingStatus, 'MOCK_NOT_CHARGED')
  assert.deepEqual(await collect(await restarted.content(done.receiptId, done.outputs[0]!.outputId, signal)), MOCK_VIDEO_BYTES)
  assert.equal((await restarted.submit(input, signal)).receiptId, queued.receiptId)
  assert.equal((await adapter(server).findReceipt(input.clientRequestId, signal))?.status, 'SUCCEEDED')
  const evidence = server.evidence() as Evidence
  assert.equal(evidence.receipts.length, 1)
  assert.equal(evidence.state.counts.quotes, 1)
  assert.equal(evidence.state.counts.submit, 2)
  assert.equal(evidence.state.counts.receivedContent, 1)
  assert.equal(evidence.state.counts.content, 1)
  assert.equal(evidence.state.counts.denied, 0)
  assert.ok(evidence.markers.some(marker => marker.phase === 'after-electron-restart' && marker.receiptStatus === 'SUCCEEDED'))
  evidence.state.counts.submit = 999
  assert.equal(server.state.counts.submit, 2, 'evidence must be a detached snapshot')
  assert.equal(JSON.stringify(server.evidence()).includes(VIDEO_MOCK_FIXTURE_TOKEN), false)
  await server.close()
  await server.close()
  assert.equal((server.evidence() as Evidence).closed, true)
  await assert.rejects(fetch(`${server.baseUrl}${path}/profiles`, { headers }))
})

test('scenario is selected at submission, with globally unique quote/receipt/output IDs and stable replay routing', async t => {
  const { server, gateway } = await setup(t)
  const ids = new Set<string>()
  for (const [index, scenario] of (['success', 'partial', 'partial-expired', 'success', 'partial', 'partial-expired'] as const).entries()) {
    server.state.scenario = scenario === 'success' ? 'partial' : 'success'
    const { body, quote } = await prepared(gateway)
    assert.ok(!ids.has(quote.quoteId))
    ids.add(quote.quoteId)
    server.state.scenario = scenario
    const input = { ...body, clientRequestId: `scenario-${index}`, quoteId: quote.quoteId }
    const receipt = await gateway.submit(input, signal)
    assert.ok(!ids.has(receipt.receiptId))
    ids.add(receipt.receiptId)
    server.state.scenario = scenario === 'success' ? 'partial' : 'success'
    assert.equal((await gateway.submit(input, signal)).receiptId, receipt.receiptId)
    await gateway.getReceipt(receipt.receiptId, signal)
    const done = await gateway.getReceipt(receipt.receiptId, signal)
    assert.equal(done.status, scenario === 'success' ? 'SUCCEEDED' : 'PARTIAL_SUCCEEDED')
    assert.equal(done.errorCode, scenario === 'partial' ? 'MOCK_PARTIAL_OUTPUT' : null)
    for (const output of done.outputs) {
      assert.ok(!ids.has(output.outputId))
      ids.add(output.outputId)
    }
    assert.deepEqual(await collect(await gateway.content(done.receiptId, done.outputs.at(-1)!.outputId, signal)), MOCK_VIDEO_BYTES)
    await assert.rejects(gateway.submit({ ...input, creativeBrief: 'conflicting replay' }, signal), { statusCode: 409 })
  }
  const other = await setup(t)
  const { body, quote } = await prepared(other.gateway)
  const receipt = await other.gateway.submit({ ...body, clientRequestId: 'scenario-0', quoteId: quote.quoteId }, signal)
  assert.ok(!ids.has(quote.quoteId))
  assert.ok(!ids.has(receipt.receiptId))
  assert.equal((server.evidence() as Evidence).receipts.length, 6)
})

test('partial-expired receipt exposes two remapped outputs: first expired, second downloadable through the real Sep adapter', async t => {
  const { server, gateway } = await setup(t)
  const { body, quote } = await prepared(gateway)
  server.state.scenario = 'partial-expired'
  const input = { ...body, quoteId: quote.quoteId, clientRequestId: 'partial-expired-client' }
  const queued = await gateway.submit(input, signal)
  assert.equal(queued.status, 'QUEUED')
  server.state.scenario = 'success'
  assert.equal((await gateway.getReceipt(queued.receiptId, signal)).status, 'RUNNING')
  const done = await gateway.getReceipt(queued.receiptId, signal)
  assert.equal(done.receiptId, queued.receiptId)
  assert.equal(done.status, 'PARTIAL_SUCCEEDED')
  assert.equal(done.outputs.length, 2)
  assert.equal(done.recovery.canDownload, true)
  const [expired, available] = done.outputs
  assert.match(done.receiptId, /^synthetic-.*-partial-expired-video-receipt-/)
  assert.equal(expired!.outputId, `${done.receiptId}-output-1`)
  assert.equal(available!.outputId, `${done.receiptId}-output-2`)
  assert.ok(Date.parse(expired!.expiresAt!) < Date.now())
  assert.ok(Date.parse(available!.expiresAt!) > Date.now())
  await assert.rejects(gateway.content(done.receiptId, expired!.outputId, signal), { statusCode: 404 })

  const restarted = adapter(server)
  assert.deepEqual(await restarted.findReceipt(input.clientRequestId, signal), done)
  assert.deepEqual(await restarted.submit(input, signal), done)
  assert.deepEqual(await collect(await restarted.content(done.receiptId, available!.outputId, signal)), MOCK_VIDEO_BYTES)
  const evidence = server.evidence() as Evidence
  assert.equal(evidence.receipts.length, 1)
  assert.equal(evidence.receipts[0]!.scenario, 'partial-expired')
  assert.equal(evidence.gatewayCalls.success.submit, 0)
  assert.equal(evidence.gatewayCalls['partial-expired'].getReceipt, 2)
  assert.equal(server.state.counts.receivedContent, 2)
  assert.equal(server.state.counts.content, 1)
  assert.equal(server.state.counts.denied, 1)
  assert.ok(evidence.markers.some(marker => marker.path.endsWith(`/outputs/${available!.outputId}/content`) && marker.status === 200))
})

test('concurrent submissions of one client ID share a receipt and enforce quoted semantics', async t => {
  const { server, gateway } = await setup(t)
  const { body, quote } = await prepared(gateway)
  const input = { ...body, clientRequestId: 'concurrent-client', quoteId: quote.quoteId }
  const receipts = await Promise.all(Array.from({ length: 8 }, () => gateway.submit(input, signal)))
  assert.equal(new Set(receipts.map(receipt => receipt.receiptId)).size, 1)
  assert.equal((server.evidence() as Evidence).receipts.length, 1)
  await assert.rejects(gateway.submit({ ...input, clientRequestId: 'bad-quote', creativeBrief: 'not what was quoted' }, signal), { statusCode: 409 })
  await assert.rejects(gateway.submit({ ...input, clientRequestId: 'missing-quote', quoteId: 'unknown-quote' }, signal), { statusCode: 409 })
  await assert.rejects(gateway.quote({ ...body, referenceIds: ['unknown-reference'] }, signal), { statusCode: 400 })
  await assert.rejects(gateway.quote({ ...body, parameters: { ...body.parameters, audio: true } }, signal), { statusCode: 400 })
})

test('holdQueries freezes queued/running jobs; revocation/disconnection count denied attempts without advancing jobs', async t => {
  const { server, gateway } = await setup(t)
  const { body, quote } = await prepared(gateway)
  const queued = await gateway.submit({ ...body, quoteId: quote.quoteId, clientRequestId: 'held-client' }, signal)
  server.state.holdQueries = true
  for (let i = 0; i < 3; i++) assert.equal((await gateway.getReceipt(queued.receiptId, signal)).status, 'QUEUED')
  assert.equal((server.evidence() as Evidence).gatewayCalls.success.getReceipt, 0)
  server.state.holdQueries = false
  assert.equal((await gateway.getReceipt(queued.receiptId, signal)).status, 'RUNNING')
  server.state.holdQueries = true
  assert.equal((await adapter(server).getReceipt(queued.receiptId, signal)).status, 'RUNNING')
  assert.equal((await gateway.findReceipt('held-client', signal))?.status, 'RUNNING')
  assert.equal(server.state.counts.heldQueries, 5)
  server.state.disconnected = true
  await assert.rejects(gateway.getReceipt(queued.receiptId, signal), { statusCode: 503 })
  await assert.rejects(gateway.submit({ ...body, quoteId: quote.quoteId, clientRequestId: 'denied-client' }, signal), { statusCode: 503 })
  await assert.rejects(gateway.content(queued.receiptId, 'unknown-output', signal), { statusCode: 503 })
  server.state.revoked = true
  await assert.rejects(gateway.findReceipt('held-client', signal), { statusCode: 403 })
  server.state.disconnected = false
  await assert.rejects(gateway.profiles(signal), { statusCode: 403 })
  assert.equal(server.state.counts.denied, 5)
  assert.equal(server.state.counts.receivedContent, 1)
  assert.equal(server.state.counts.content, 0)
  assert.equal(server.state.counts.submit, 2, 'denied submissions are still received attempts')
  assert.equal((server.evidence() as Evidence).gatewayCalls.success.getReceipt, 1)
  assert.equal((server.evidence() as Evidence).gatewayCalls.success.submit, 1)
  server.state.revoked = false
  server.state.holdQueries = false
  assert.equal((await adapter(server).getReceipt(queued.receiptId, signal)).status, 'SUCCEEDED')
})

test('corruptDownload changes only content bytes while preserving advertised integrity metadata', async t => {
  const { server, gateway } = await setup(t)
  const { body, quote } = await prepared(gateway)
  const queued = await gateway.submit({ ...body, quoteId: quote.quoteId, clientRequestId: 'corrupt-client' }, signal)
  await gateway.getReceipt(queued.receiptId, signal)
  const done = await gateway.getReceipt(queued.receiptId, signal)
  server.state.corruptDownload = true
  await assert.rejects(collect(await gateway.content(done.receiptId, done.outputs[0]!.outputId, signal)), { gatewayCode: 'VIDEO_INTEGRITY_MISMATCH' })
  server.state.corruptDownload = false
  assert.deepEqual(await collect(await gateway.content(done.receiptId, done.outputs[0]!.outputId, signal)), MOCK_VIDEO_BYTES)
  assert.equal(server.state.counts.corruptDownloads, 1)
  assert.equal(server.state.counts.receivedContent, 2)
  assert.equal(server.state.counts.content, 2)
})

test('fixture accepts only the fixed PNG multipart, fixed fake bearer, bounded bodies and exact routes', async t => {
  const { server, gateway } = await setup(t)
  assert.equal((await fetch(`${server.baseUrl}${path}/profiles`)).status, 401)
  assert.equal((await fetch(`${server.baseUrl}${path}/profiles`, { headers: { Authorization: 'Bearer other-fake-token' } })).status, 401)
  assert.equal(await gateway.findReceipt('missing-client', signal), null)
  await assert.rejects(gateway.cancel('missing-receipt', signal), { statusCode: 409 })
  assert.equal((await fetch(`${server.baseUrl}${path}/profiles?unexpected=true`, { headers })).status, 404)
  for (const [bytes, mime, extra] of [[Buffer.from([1, 2]), 'image/png', false], [png, 'image/jpeg', false], [png, 'image/png', true]] as const) {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'mock.png')
    if (extra) form.append('extra', 'forbidden')
    const response = await fetch(`${server.baseUrl}${path}/references`, { method: 'POST', headers, body: form })
    assert.equal(response.status, 400)
  }
  const malformed = await fetch(`${server.baseUrl}${path}/quotes`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400)
  const oversized = await fetch(`${server.baseUrl}${path}/quotes`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: 'x'.repeat(VIDEO_MOCK_FIXTURE_BODY_LIMIT + 1) })
  assert.equal(oversized.status, 413)
  // Omitted Content-Length exercises the streaming limit rather than the precheck.
  const chunked = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${server.baseUrl}${path}/quotes`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    request.write(Buffer.alloc(VIDEO_MOCK_FIXTURE_BODY_LIMIT, 120))
    request.end('x')
  })
  assert.equal(chunked, 413)
  assert.equal(server.state.counts.denied, 11)
})
