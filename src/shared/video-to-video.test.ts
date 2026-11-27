import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { sepVideoToVideoRuntimeFixture as videoToVideoRuntime } from './fixtures/sep-media-runtime-v3'
import { videoRequestSchema, videoRuntimeSchema } from './video-media'
import { videoGenerationInputSchema } from './video-host'

const spec = { durationSeconds: 5, resolution: '720p', audio: false }
const metadata = { protocolVersion: 3, specRevision: 1, requestedSpec: spec, parameterSources: { durationSeconds: 'user', resolution: 'user', audio: 'user' } }
const request = { ...metadata, profileId: 'video_example', configVersion: '1', operation: 'video-to-video',
  referenceIds: [], videoReferenceIds: ['video-2', 'video-1'], creativeBrief: 'Change the scene', parameters: spec }

test('video runtime retains authorized video reference rules and limits', () => {
  const runtime = videoRuntimeSchema.parse(videoToVideoRuntime())
  assert.ok(runtime.tools.includes('video_from_video'))
  assert.ok(runtime.profiles[0].operations.includes('video-to-video'))
  assert.equal(runtime.profiles[0].videoReferenceSupport?.maxCount, 3)
  assert.deepEqual(runtime.profiles[0].videoReferenceSupport?.mimeTypes, ['video/mp4', 'video/quicktime'])
  const missing = videoToVideoRuntime()
  Reflect.deleteProperty(missing.profiles[0].adapter, 'videoReferenceSupport')
  assert.equal(videoRuntimeSchema.safeParse(missing).success, false)
})
test('video requests preserve reference order and reject mixed, missing, duplicate and legacy references', () => {
  assert.deepEqual(videoRequestSchema.parse(request).videoReferenceIds, ['video-2', 'video-1'])
  assert.equal(videoRequestSchema.safeParse({ ...request, referenceIds: ['image-1'] }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...request, videoReferenceIds: [] }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...request, videoReferenceIds: ['video-1', 'video-1'] }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...request, protocolVersion: undefined }).success, false)
  assert.equal(videoRequestSchema.safeParse({ ...request, operation: 'text-to-video' }).success, false)
})
test('local generation separates video assets from image assets', () => {
  const input = { ...metadata, profileId: 'video_example', operation: 'video-to-video', localAssetIds: [],
    localVideoAssetIds: ['vref_1'], creativeBrief: 'Edit video', parameters: spec }
  assert.equal(videoGenerationInputSchema.safeParse(input).success, true)
  assert.equal(videoGenerationInputSchema.safeParse({ ...input, localAssetIds: ['image-1'] }).success, false)
  assert.equal(videoGenerationInputSchema.safeParse({ ...input, localVideoAssetIds: [] }).success, false)
})
