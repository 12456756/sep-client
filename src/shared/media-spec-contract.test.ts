import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { imageRequestedSpecSchema, videoRequestedSpecSchema, mediaSpecMetadataSchema, mediaSpecsEqual } from './media-spec-contract'

test('media specifications preserve omissions and explicit false without platform defaults', () => {
  assert.deepEqual(imageRequestedSpecSchema.parse({}), {})
  assert.deepEqual(videoRequestedSpecSchema.parse({ audio: false }), { audio: false })
  assert.deepEqual(mediaSpecMetadataSchema.parse({ protocolVersion: 3, specRevision: 2, parameterSources: { audio: 'user' } }), {
    protocolVersion: 3, specRevision: 2, parameterSources: { audio: 'user' },
  })
})

test('new specifications accept provider values beyond legacy lists and resource-free business ceilings', () => {
  assert.deepEqual(imageRequestedSpecSchema.parse({ size: '2048x1152', quality: 'ultra', count: 20 }), { size: '2048x1152', quality: 'ultra', count: 20 })
  const spec = { durationSeconds: 720, aspectRatio: '9:16', resolution: '8k', frameRate: 29.97, audio: false, outputFormat: 'video/quicktime' }
  assert.deepEqual(videoRequestedSpecSchema.parse(spec), spec)
})

test('invalid, contradictory or untrusted specifications fail before submission', () => {
  for (const spec of [{ durationSeconds: 0 }, { frameRate: Infinity }, { frameRate: NaN }, { aspectRatio: '0:9' }, { outputFormat: 'https://private.example' }, { resolution: '1080p\nsecret' }, { url: 'https://example.test' }]) {
    assert.equal(videoRequestedSpecSchema.safeParse(spec).success, false)
  }
  for (const spec of [{ count: 0 }, { width: -1 }, { size: '2048x1152', aspectRatio: '1:1' }, { width: 1024, height: 1024, aspectRatio: '16:9' }, { size: '2048x1152', width: 1024 }, { apiKey: 'secret' }]) {
    assert.equal(imageRequestedSpecSchema.safeParse(spec).success, false)
  }
  assert.equal(mediaSpecMetadataSchema.safeParse({ protocolVersion: 3, specRevision: 0, parameterSources: {} }).success, false)
  assert.equal(mediaSpecMetadataSchema.safeParse({ protocolVersion: 3, specRevision: 1, parameterSources: { apiKey: 'user' } }).success, false)
})

test('quoted specifications must preserve exact semantics and omission, regardless of property order', () => {
  assert.equal(mediaSpecsEqual({ audio: false, aspectRatio: '18:32' }, { aspectRatio: '9:16', audio: false }), true)
  assert.equal(mediaSpecsEqual({ durationSeconds: 8 }, { durationSeconds: 4 }), false)
  assert.equal(mediaSpecsEqual({}, { frameRate: 24 }), false)
  assert.equal(mediaSpecsEqual({ quality: 'high' }, {}), false)
})
