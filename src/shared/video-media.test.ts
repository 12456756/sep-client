import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import * as fixture from './fixtures/media-video-v1.json'
import { videoOutputSchema, videoProfileSchema, videoReceiptSchema, videoRequestSchema, videoRequestWithIdentitySchema, videoRuntimeSchema, videoQuoteResponseSchema } from './video-media'

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

test('video runtime rejects dangling defaults, duplicate profiles and unsupported tools', () => {
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, defaultProfileId: 'missing' }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, profiles: [...fixture.runtime.profiles, ...fixture.runtime.profiles] }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, tools: ['video_generate'] }).success, false)
  assert.equal(videoRuntimeSchema.safeParse({ ...fixture.runtime, executionAvailable: false }).success, false)
})

test('video receipts reject contradictory success and recovery states', () => {
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.succeeded, outputs: [] }).success, false)
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.failed, recovery: { canQuery: false, canCancel: false, canDownload: true } }).success, false)
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.succeeded, pollAfterMs: 1000 }).success, false)
  assert.equal(videoReceiptSchema.safeParse({ ...fixture.receipts.partial, outputs: [fixture.output, fixture.output] }).success, false)
})
