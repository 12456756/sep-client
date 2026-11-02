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

test('measured video dimensions override inconsistent supplier actualSpec without modifying billing or original receipt', () => {
  const value = job({ width: fixture.output.width + 1 }, { width: fixture.output.width + 1 })
  const original = structuredClone(value.receipt)
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'mismatched')
  assert.equal(result.actualSpec?.width, fixture.output.width)
  assert.deepEqual(value.receipt, original)
})

test('unknown audio verification remains unknown while equivalent measured ratio is accepted', () => {
  assert.equal(videoSpecAcceptance(job({ audio: false })).acceptance, 'unknown')
  assert.equal(videoSpecAcceptance(job({ aspectRatio: `${fixture.output.width * 2}:${fixture.output.height * 2}` })).acceptance, 'matched')
})

test('fractional delivered duration remains measured evidence while mismatches preserve successful generation and billing', () => {
  const value = job({ durationSeconds: 4 }, {
    durationSeconds: 4.458333, width: 1344, height: 768, frameRate: 24,
    mimeType: 'video/mp4', hasAudio: true, source: 'measured',
  })
  value.receipt.outputs = [{ ...output, durationSeconds: 4.458333, width: 1344, height: 768 }]
  const original = structuredClone(value)
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'mismatched')
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
    assert.equal(result.acceptance, hasAudio === null ? 'unknown' : hasAudio ? 'mismatched' : 'matched')
    assert.equal(result.actualSpec?.audio, hasAudio ?? undefined)
    assert.equal(result.actualSpec?.outputFormat, 'video/mp4')
    assert.deepEqual(value.receipt, original)
  }
})


test('every video output is checked and any explicit mismatch prevents acceptance', () => {
  const value = job({ width: fixture.output.width })
  value.receipt.outputs.push({ ...output, outputId: 'second-output', width: fixture.output.width + 1 })
  const original = structuredClone(value)
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'mismatched')
  assert.equal(result.actualSpec, undefined, 'Different output specifications cannot be summarized as one actual specification.')
  assert.deepEqual(value, original, 'Comparison must preserve the original request, receipt and billing state.')
})

test('multiple uniformly incorrect outputs remain mismatched without supplier actualSpec', () => {
  const value = job({ width: 1920 })
  value.receipt.outputs.push({ ...output, outputId: 'second-output' })
  const result = videoSpecAcceptance(value)
  assert.equal(result.acceptance, 'mismatched')
  assert.equal(result.actualSpec?.width, fixture.output.width)
})

test('multiple outputs match only when all requested fields are verified for every output', () => {
  const value = job({ width: fixture.output.width })
  value.receipt.outputs.push({ ...output, outputId: 'second-output' })
  assert.equal(videoSpecAcceptance(value).acceptance, 'matched')
  const unknownAudio = job({ width: fixture.output.width, audio: false })
  unknownAudio.receipt.outputs.push({ ...output, outputId: 'second-output' })
  assert.equal(videoSpecAcceptance(unknownAudio).acceptance, 'unknown')
  const unknownWithMismatch = job({ width: fixture.output.width, audio: false })
  unknownWithMismatch.receipt.outputs.push({ ...output, outputId: 'second-output', width: fixture.output.width + 1 })
  assert.equal(videoSpecAcceptance(unknownWithMismatch).acceptance, 'mismatched')
})
