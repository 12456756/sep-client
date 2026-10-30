import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import * as fixture from './fixtures/media-video-v1.json'
import * as v2Fixture from './fixtures/media-video-v2.json'
import { videoAllowedAudioModes, videoOutputSchema, videoProfileSchema, videoReceiptSchema, videoRequestSchema, videoRequestWithIdentitySchema, videoRuntimeSchema, videoQuoteResponseSchema } from './video-media'

test('SEP V3 video runtime normalizes advisory hints and round-trips without inventing audio defaults', () => {
  const runtime = {
    protocolVersion: 3,
    executionMode: 'real',
    executionAvailable: true,
    defaultProfileId: 'video-v3',
    tools: ['video_generate', 'video_from_image'],
    profiles: [{
      profileId: 'video-v3', configVersion: 'cfg-v3', kind: 'video', displayName: 'V3 video',
      operations: ['text-to-video', 'image-to-video'], executionMode: 'async-query', authorized: true,
      adapter: { id: 'adapter-v3', version: '1', available: true, operations: ['text-to-video', 'image-to-video'],
        referenceSupport: { maxCount: 1, maxInputBytes: 10485760, mimeTypes: ['image/png'] },
        supportsTaskQuery: true, supportsCancel: false },
      capabilityHints: [{ field: 'durationSeconds', values: [8, 12], source: 'adapter', observedAt: null, confidence: 'declared' }],
    }],
  }
  const normalized = videoRuntimeSchema.parse(runtime)
  assert.equal(normalized.protocolVersion, 3)
  assert.deepEqual(normalized.profiles[0]?.capabilityHints, runtime.profiles[0].capabilityHints)
  assert.equal(normalized.profiles[0]?.capabilities.supportsTaskQuery, true)
  assert.equal(normalized.profiles[0]?.capabilities.supportsAudio, false)
  assert.equal('audioModes' in (normalized.profiles[0]?.capabilities ?? {}), false)
  assert.deepEqual(videoRuntimeSchema.parse(normalized), normalized)
})

test('V3 video request retains omitted fields and rejects a second contradictory specification', () => {
  const input = { ...fixture.quoteRequest, protocolVersion: 3, specRevision: 1, parameterSources: { durationSeconds: 'model', audio: 'user' },
    parameters: { durationSeconds: 720, audio: false }, requestedSpec: { durationSeconds: 720, audio: false } }
  const parsed = videoRequestSchema.parse(input)
  assert.deepEqual(parsed.parameters, input.parameters)
  assert.equal(videoRequestSchema.safeParse({ ...input, parameters: { durationSeconds: 4 } }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...fixture.quoteRequest, parameters: {} }).success, false)
})

test('real video contracts are strict and cannot accept mock billing', () => {
  assert.equal(videoRuntimeSchema.parse({ ...fixture.runtime, executionMode: 'real' }).executionMode, 'real')
  for (const billingStatus of ['NOT_RESERVED', 'RESERVED', 'SETTLED', 'RELEASED', 'RECONCILING']) {
    assert.ok(videoReceiptSchema.safeParse({ ...fixture.receipt, mock: false, billingStatus, amountCny: '1.000000', actualCostCny: '0.800000', amountUsd: '0.12' }).success)
  }
  for (const value of [{ ...fixture.receipt, mock: false }, { ...fixture.receipt, amountCny: '1.000000' },
    { ...fixture.receipt, mock: false, billingStatus: 'RESERVED', amountCny: '1.00' },
    { ...fixture.receipt, mock: false, billingStatus: 'RESERVED', privateUrl: 'secret' }]) assert.equal(videoReceiptSchema.safeParse(value).success, false)
})

test('real terminal billing remains queryable with null poll hints until settled or released', () => {
  for (const status of ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']) {
    for (const billingStatus of ['RESERVED', 'RECONCILING', 'SETTLED', 'RELEASED', 'NOT_RESERVED']) {
      const delivered = status === 'SUCCEEDED' || status === 'PARTIAL_SUCCEEDED'
      const pending = billingStatus === 'RESERVED' || billingStatus === 'RECONCILING'
      const value = { ...fixture.receipts.succeeded, mock: false, status, billingStatus,
        outputs: delivered ? [{ ...fixture.output, width: 1344, height: 768, durationSeconds: 4.458333, frameRate: 24 }] : [],
        recovery: { canQuery: pending, canCancel: false, canDownload: delivered }, pollAfterMs: null }
      assert.ok(videoReceiptSchema.safeParse(value).success, `${status}/${billingStatus}`)
      assert.equal(videoReceiptSchema.safeParse({ ...value, recovery: { ...value.recovery, canQuery: !pending } }).success, false)
      assert.equal(videoReceiptSchema.safeParse({ ...value, pollAfterMs: 1000 }).success, false)
      assert.equal(videoReceiptSchema.safeParse({ ...value, recovery: { ...value.recovery, canCancel: true } }).success, false)
      if (delivered) assert.equal(videoReceiptSchema.parse(value).outputs[0].durationSeconds, 4.458333)
    }
  }
})

test('shared video fixtures preserve the async profile, request and quote contracts', () => {
  assert.deepEqual(videoProfileSchema.parse(fixture.profile), fixture.profile)
  assert.deepEqual(videoRuntimeSchema.parse(fixture.runtime), fixture.runtime)
  assert.deepEqual(videoRequestSchema.parse(fixture.quoteRequest), fixture.quoteRequest)
  assert.deepEqual(videoRequestWithIdentitySchema.parse(fixture.request), fixture.request)
  assert.deepEqual(videoQuoteResponseSchema.parse(fixture.quote), fixture.quote)
})

test('image-to-video requires exactly one reference and strict video parameters', () => {
  for (const referenceIds of [[], ['ref1', 'ref2']]) assert.equal(videoRequestSchema.safeParse({ ...fixture.quoteRequest, referenceIds }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...fixture.quoteRequest, parameters: { ...fixture.quoteRequest.parameters, outputFormat: 'image/png' } }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...fixture.quoteRequest, apiKey: 'secret' }).success, false)
})

test('all shared receipt states and video metadata parse without alteration', () => {
  for (const receipt of Object.values(fixture.receipts)) assert.deepEqual(videoReceiptSchema.parse(receipt), receipt)
  assert.deepEqual(videoOutputSchema.parse(fixture.output), fixture.output)
  assert.equal(createHash('sha256').update(Buffer.from(fixture.mediaFixture.base64, 'base64')).digest('hex'), fixture.output.sha256)
})

test('shared receipt schema restores historical V3 records with partial actual-spec evidence', () => {
  const historical = { ...fixture.receipts.succeeded, protocolVersion: 3, specRevision: 1,
    effectiveSpec: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' },
    actualSpec: { width: 1280 } }
  assert.deepEqual(videoReceiptSchema.parse(historical), historical)
})

test('video receipts preserve fractional duration in normalized and supplier-measured actual specifications', () => {
  for (const actualSpec of [
    { durationSeconds: 4.458333, width: 1344, height: 768, frameRate: 24, outputFormat: 'video/mp4', audio: true },
    { durationSeconds: 4.458333, width: 1344, height: 768, frameRate: 24, mimeType: 'video/mp4', hasAudio: true, source: 'measured' },
  ]) {
    const receipt = { ...fixture.receipts.succeeded, actualSpec }
    assert.deepEqual(videoReceiptSchema.parse(receipt), receipt)
  }
})

test('video runtime rejects dangling defaults, duplicate profiles and unsupported tools', () => {
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, defaultProfileId: 'missing' }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, profiles: [...fixture.runtime.profiles, ...fixture.runtime.profiles] }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, tools: ['video_generate'] }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, executionAvailable: false }).success, false)
})

test('video v2 requires valid defaults while v1 remains strict and audio modes follow negotiated runtime', () => {
  const profile = fixture.runtime.profiles[0]!
  const v2Profile = { ...profile, capabilities: { ...profile.capabilities, supportsAudio: true, audioModes: [true], defaultAudio: true,
    defaults: { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: true, outputFormat: 'video/mp4' } } }
  const v2 = { ...fixture.runtime, protocolVersion: 2, executionMode: 'real', profiles: [v2Profile] }
  assert.equal(videoRuntimeSchema.safeParse(v2).success, true)
  assert.equal(videoRuntimeSchema.safeParse({ ...v2, profiles: [{ ...v2Profile, capabilities: { ...v2Profile.capabilities,
    defaults: { ...v2Profile.capabilities.defaults, aspectRatio: '1:1' } } }] }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, profiles: [{ ...profile,
    capabilities: { ...profile.capabilities, audioModes: [true] } }] }).success, false)
  assert.deepEqual(videoAllowedAudioModes({ protocolVersion: 2, executionMode: 'real' }, v2Profile), [true])
  assert.deepEqual(videoAllowedAudioModes({ protocolVersion: 1, executionMode: 'real' }, profile), [true])
  assert.deepEqual(videoAllowedAudioModes({ protocolVersion: 1, executionMode: 'mock' }, profile), [false])
})

test('SEP backend video v2 fixture is consumed with strict defaults and audio refinement', () => {
  const runtime = videoRuntimeSchema.parse(v2Fixture.runtime)
  assert.deepEqual(runtime, v2Fixture.runtime)
  const profile = runtime.profiles[0]!
  assert.deepEqual(profile.capabilities.audioModes, [false])
  assert.equal(profile.capabilities.defaultAudio, false)
  assert.deepEqual(videoAllowedAudioModes(runtime, profile), [false])

  const invalidDefaults = {
    ...v2Fixture.runtime,
    profiles: [{ ...profile, capabilities: {
      ...profile.capabilities,
      defaults: { ...profile.capabilities.defaults, durationSeconds: 10 },
    } }],
  }
  assert.equal(videoRuntimeSchema.safeParse(invalidDefaults).success, false)
  assert.equal(videoRuntimeSchema.safeParse({
    ...v2Fixture.runtime,
    profiles: [{ ...profile, capabilities: { ...profile.capabilities, defaultAudio: true } }],
  }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({
    ...v2Fixture.runtime,
    profiles: [{ ...profile, capabilities: { ...profile.capabilities, providerSecret: 'secret' } }],
  }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({
    ...fixture.runtime,
    profiles: [{ ...fixture.runtime.profiles[0], capabilities: {
      ...fixture.runtime.profiles[0].capabilities,
      audioModes: [false], defaultAudio: false,
      defaults: { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' },
    } }],
  }).success, false)
})

test('video receipts reject contradictory success and recovery states', () => {
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.succeeded, outputs: [] }).success, false)
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.failed, recovery: { canQuery: false, canCancel: false, canDownload: true } }).success, false)
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.succeeded, pollAfterMs: 1000 }).success, false)
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.partial, outputs: [fixture.output, fixture.output] }).success, false)
})

test('V3 advisory audio modes never invent required audio and adapter metadata rejects arbitrary addresses', () => {
  const profile = { capabilities: { supportsAudio: true } }
  assert.deepEqual(videoAllowedAudioModes({ protocolVersion: 3, executionMode: 'real' }, profile), [])
  const source = JSON.parse(JSON.stringify(fixture.runtime))
  const runtime = { ...source, protocolVersion: 3, executionMode: 'real', profiles: source.profiles.map((item: Record<string, unknown>) => ({ ...item, adapterVersion: 'https://private.invalid?api_key=secret' })) }
  assert.equal(videoRuntimeSchema.safeParse(runtime).success, false)
})
