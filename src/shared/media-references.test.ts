import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mediaReferenceProblem } from './media-references'
import { videoRequestSchema, videoRuntimeSchema } from './video-media'
import { videoGenerationInputSchema, videoToolGenerationInputSchema } from './video-host'
import * as fixture from './fixtures/media-video-v1.json'

const support = { maxCount: 3, maxInputBytes: 1024, mimeTypes: ['image/png'] }
const assets = [1, 2, 3].map(index => ({ localAssetId: `image-${index}`, mime: 'image/png', size: 512, status: 'SAVED' }))
test('reference validation honors the current profile, individual files and total transport budget', () => {
  assert.equal(mediaReferenceProblem(assets, support), null)
  assert.match(mediaReferenceProblem(assets, { ...support, maxCount: 2 })!, /2/)
  assert.ok(mediaReferenceProblem([assets[0]!, assets[0]!], support))
  assert.ok(mediaReferenceProblem([{ ...assets[0]!, mime: 'image/jpeg' }], support))
  assert.ok(mediaReferenceProblem([{ ...assets[0]!, size: 1025 }], support))
  assert.ok(mediaReferenceProblem([{ ...assets[0]!, status: 'MISSING' }], support))
  assert.ok(mediaReferenceProblem(assets.map(asset => ({ ...asset, size: 40 * 1024 * 1024 })), { ...support, maxInputBytes: 50 * 1024 * 1024 }))
})

test('V3 video accepts ordered multi-reference requests while legacy video remains single-reference', () => {
  const request = { ...fixture.quoteRequest, protocolVersion: 3, requestedSpec: { durationSeconds: 4 },
    parameters: { durationSeconds: 4 }, parameterSources: { durationSeconds: 'model' }, specRevision: 1,
    referenceIds: assets.map(asset => asset.localAssetId).reverse() }
  assert.deepEqual(videoRequestSchema.parse(request).referenceIds, request.referenceIds)
  assert.equal(videoRequestSchema.safeParse({ ...fixture.quoteRequest, referenceIds: request.referenceIds }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...request, referenceIds: [] }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...request, referenceIds: ['same', 'same'] }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...request, referenceIds: Array.from({ length: 33 }, (_, i) => `ref-${i}`) }).success, false)
  const input = { ...request, localAssetIds: request.referenceIds }
  const { referenceIds: _ids, configVersion: _version, ...local } = input
  assert.deepEqual(videoGenerationInputSchema.parse(local).localAssetIds, request.referenceIds)
  assert.deepEqual(videoToolGenerationInputSchema.parse({ creativeBrief: request.creativeBrief, localAssetIds: request.referenceIds }).localAssetIds, request.referenceIds)
})

test('video runtime retains the full V3 reference capability through normalization and persistence', () => {
  const runtime = { protocolVersion: 3, executionMode: 'real', executionAvailable: true, defaultProfileId: 'video-profile',
    tools: ['video_from_image', 'video_get_job'], profiles: [{ profileId: 'video-profile', configVersion: 'cfg', kind: 'video',
      displayName: 'Video', operations: ['image-to-video'], executionMode: 'async-query', authorized: true,
      adapter: { id: 'sub2api-video', version: '3', available: true, operations: ['image-to-video'], referenceSupport: support,
        supportsTaskQuery: true, supportsCancel: false }, capabilityHints: [] }] }
  const parsed = videoRuntimeSchema.parse(runtime)
  assert.ok('referenceSupport' in parsed.profiles[0]!)
  assert.deepEqual(parsed.profiles[0]!.referenceSupport, support)
  assert.deepEqual(videoRuntimeSchema.parse(parsed), parsed)
})
