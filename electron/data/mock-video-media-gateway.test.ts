import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoRequestSchema } from '../../src/shared/video-media'
import { MockVideoMediaGateway, MOCK_VIDEO_BYTES, MOCK_VIDEO_SHA256, type MockVideoScenario } from './mock-video-media-gateway'

const signal = new AbortController().signal
async function prepared(gateway: MockVideoMediaGateway) {
  const body = videoRequestSchema.parse(fixture.quoteRequest)
  const quote = await gateway.quote(body, signal)
  return { ...body, clientRequestId: fixture.request.clientRequestId, quoteId: quote.quoteId }
}

test('mock video advances an async task and rejects a conflicting replay', async () => {
  const gateway = new MockVideoMediaGateway()
  const request = await prepared(gateway)
  const first = await gateway.submit(request, signal)
  assert.equal((await gateway.submit(request, signal)).receiptId, first.receiptId)
  await assert.rejects(gateway.submit({ ...request, creativeBrief: 'different brief' }, signal), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal((await gateway.getReceipt(first.receiptId, signal)).status, 'RUNNING')
  const done = await gateway.getReceipt(first.receiptId, signal)
  assert.equal(done.status, 'SUCCEEDED')
  assert.equal(done.outputs[0]?.durationSeconds, 5)
  assert.equal(done.recovery.canDownload, true)
})

test('mock video recovers the original receipt and downloads the playable fixture', async () => {
  const gateway = new MockVideoMediaGateway()
  const request = await prepared(gateway)
  const submitted = await gateway.submit(request, signal)
  await gateway.getReceipt(submitted.receiptId, signal)
  const done = await gateway.getReceipt(submitted.receiptId, signal)
  const recovered = await gateway.findReceipt(request.clientRequestId, signal)
  assert.equal(recovered?.receiptId, submitted.receiptId)
  const chunks: Uint8Array[] = []
  for await (const chunk of await gateway.content(submitted.receiptId, done.outputs[0]!.outputId, signal)) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), MOCK_VIDEO_BYTES)
  assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), MOCK_VIDEO_SHA256)
  assert.equal(MOCK_VIDEO_BYTES.toString('ascii', 4, 8), 'ftyp')
  assert.equal(gateway.calls.submit, 1)
})

test('mock video enforces quote expiry, specification and quoted semantics', async () => {
  let now = 1_800_000_000_000
  const gateway = new MockVideoMediaGateway('success', () => now)
  const request = await prepared(gateway)
  await assert.rejects(gateway.submit({ ...request, creativeBrief: 'changed after quote' }, signal), { code: 'QUOTE_MISMATCH' })
  now += 60_001
  await assert.rejects(gateway.submit(request, signal), { code: 'QUOTE_EXPIRED' })
  const body = videoRequestSchema.parse(fixture.quoteRequest)
  await assert.rejects(gateway.quote({ ...body, parameters: { ...body.parameters, audio: true } }, signal), { code: 'UNSUPPORTED_VIDEO_PARAMETERS' })
})

for (const [scenario, expected] of [['failed', 'FAILED'], ['partial', 'PARTIAL_SUCCEEDED'], ['expired', 'RESULT_EXPIRED']] as const) {
  test(`mock video simulates ${scenario} without charging or resubmitting`, async () => {
    const gateway = new MockVideoMediaGateway(scenario)
    const request = await prepared(gateway)
    const submitted = await gateway.submit(request, signal)
    await gateway.getReceipt(submitted.receiptId, signal)
    const done = await gateway.getReceipt(submitted.receiptId, signal)
    assert.equal(done.status, expected)
    assert.equal(done.billingStatus, 'MOCK_NOT_CHARGED')
    if (scenario === 'expired') await assert.rejects(gateway.content(done.receiptId, done.outputs[0]!.outputId, signal), { code: 'OUTPUT_UNAVAILABLE' })
    assert.equal(gateway.calls.submit, 1)
  })
}

test('ambiguous submission is recovered by original client id', async () => {
  const gateway = new MockVideoMediaGateway('submission-unknown')
  const request = await prepared(gateway)
  await assert.rejects(gateway.submit(request, signal), { code: 'MOCK_SUBMISSION_UNKNOWN' })
  const found = await gateway.findReceipt(request.clientRequestId, signal)
  assert.equal(found?.status, 'SUBMISSION_UNKNOWN')
  assert.equal((await gateway.getReceipt(found!.receiptId, signal)).status, 'RUNNING')
  assert.equal(gateway.calls.submit, 1)
})

test('one expired output does not block a still available sibling', async () => {
  const gateway = new MockVideoMediaGateway('partial-expired')
  const request = await prepared(gateway)
  const submitted = await gateway.submit(request, signal)
  await gateway.getReceipt(submitted.receiptId, signal)
  const done = await gateway.getReceipt(submitted.receiptId, signal)
  assert.equal(done.status, 'PARTIAL_SUCCEEDED')
  assert.equal(done.recovery.canDownload, true)
  await assert.rejects(gateway.content(done.receiptId, done.outputs[0]!.outputId, signal), { code: 'OUTPUT_UNAVAILABLE' })
  const chunks: Uint8Array[] = []
  for await (const chunk of await gateway.content(done.receiptId, done.outputs[1]!.outputId, signal)) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), MOCK_VIDEO_BYTES)
})

test('mock rejection never creates a receipt; corrupted download preserves advertised hash', async () => {
  for (const scenario of ['rejected', 'corrupt-download'] as MockVideoScenario[]) {
    const gateway = new MockVideoMediaGateway(scenario)
    const request = await prepared(gateway)
    if (scenario === 'rejected') {
      await assert.rejects(gateway.submit(request, signal), { code: 'MOCK_VIDEO_REJECTED' })
      assert.equal(await gateway.findReceipt(request.clientRequestId, signal), null)
    } else {
      const submitted = await gateway.submit(request, signal)
      await gateway.getReceipt(submitted.receiptId, signal)
      const done = await gateway.getReceipt(submitted.receiptId, signal)
      const chunks: Uint8Array[] = []
      for await (const chunk of await gateway.content(done.receiptId, done.outputs[0]!.outputId, signal)) chunks.push(chunk)
      assert.notEqual(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), done.outputs[0]!.sha256)
    }
  }
})
