import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoOutputSchema, videoReceiptSchema, videoRequestWithIdentitySchema } from '../../src/shared/video-media'
import { videoSpecAcceptance } from './video-media'

const output = videoOutputSchema.parse(fixture.output)

function job(requestedSpec: Record<string, unknown>, actualSpec?: Record<string, unknown>) {
  return { request: videoRequestWithIdentitySchema.parse({ ...fixture.request, protocolVersion: 3, specRevision: 1,
    parameters: requestedSpec, requestedSpec, parameterSources: {} }),
  receipt: videoReceiptSchema.parse({ ...fixture.receipts.succeeded, outputs: [fixture.output], ...(actualSpec ? { actualSpec } : {}) }) }
}

test('measured video metadata is retained without comparing against requested dimensions', () => {
  const value = job({ width: fixture.output.width + 1 }, { width: fixture.output.width + 1 })
  const original = structuredClone(value.receipt)
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'unknown')
  assert.equal(result.actualSpec?.width, fixture.output.width)
  assert.deepEqual(value.receipt, original)
})

test('supplier mismatch labels do not re-enable client-side video specification validation', () => {
  const value = job({ durationSeconds: 2 })
  value.receipt = videoReceiptSchema.parse({ ...value.receipt, acceptance: 'mismatched', deliveryStatus: 'mismatched' })
  assert.equal(videoSpecAcceptance(value).acceptance, 'unknown')
})

test('video output comparison is disabled whether measurements match or differ', () => {
  assert.equal(videoSpecAcceptance(job({ audio: false })).acceptance, 'unknown')
  assert.equal(videoSpecAcceptance(job({ aspectRatio: `${fixture.output.width * 2}:${fixture.output.height * 2}` })).acceptance, 'unknown')
})

test('fractional delivered duration is retained without marking a successful job mismatched', () => {
  const value = job({ durationSeconds: 4 }, {
    durationSeconds: 4.458333, width: 1344, height: 768, frameRate: 24,
    mimeType: 'video/mp4', hasAudio: true, source: 'measured',
  })
  value.receipt.outputs = [{ ...output, durationSeconds: 4.458333, width: 1344, height: 768 }]
  const original = structuredClone(value)
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'unknown')
  assert.equal(result.actualSpec?.durationSeconds, 4.458333)
  assert.equal(result.actualSpec?.audio, true)
  assert.equal(value.receipt.status, 'SUCCEEDED')
  assert.deepEqual(value, original)
})

test('SEP measured audio is mapped without treating unknown audio as verified', () => {
  for (const hasAudio of [true, false, null]) {
    const value = job({ audio: false }, {
      durationSeconds: fixture.output.durationSeconds, width: fixture.output.width,
      height: fixture.output.height, frameRate: fixture.output.frameRate,
      mimeType: 'video/mp4', hasAudio, source: 'measured',
    })
    const original = structuredClone(value.receipt)
    const result = videoSpecAcceptance(value)
    assert.equal(result.acceptance, 'unknown')
    assert.equal(result.actualSpec?.audio, hasAudio ?? undefined)
    assert.equal(result.actualSpec?.outputFormat, 'video/mp4')
    assert.deepEqual(value.receipt, original)
  }
})


test('different output measurements do not produce a specification mismatch', () => {
  const value = job({ width: fixture.output.width })
  value.receipt.outputs.push({ ...output, outputId: 'second-output', width: fixture.output.width + 1 })
  const original = structuredClone(value)
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'unknown')
  assert.equal(result.actualSpec, undefined, 'Different output specifications cannot be summarized as one actual specification.')
  assert.deepEqual(value, original, 'Comparison must preserve the original request, receipt and billing state.')
})

test('multiple outputs retain their measured summary without comparing requested fields', () => {
  const value = job({ width: 1920 })
  value.receipt.outputs.push({ ...output, outputId: 'second-output' })
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'unknown')
  assert.equal(result.actualSpec?.width, fixture.output.width)
})

test('measured metadata is not accepted or rejected based on requested fields', () => {
  const value = job({ width: fixture.output.width })
  value.receipt.outputs.push({ ...output, outputId: 'second-output' })
  assert.equal(videoSpecAcceptance(value).acceptance, 'unknown')
  const unknownAudio = job({ width: fixture.output.width, audio: false })
  unknownAudio.receipt.outputs.push({ ...output, outputId: 'second-output' })
  assert.equal(videoSpecAcceptance(unknownAudio).acceptance, 'unknown')
  const unknownWithMismatch = job({ width: fixture.output.width, audio: false })
  unknownWithMismatch.receipt.outputs.push({ ...output, outputId: 'second-output', width: fixture.output.width + 1 })
  assert.equal(videoSpecAcceptance(unknownWithMismatch).acceptance, 'unknown')
})
