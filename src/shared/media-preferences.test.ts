import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { mediaPreferenceKey, readMediaPreference, saveMediaPreference } from './media-preferences'
import { imageFormParameters, videoFormParameters } from './media-view'
import type { MediaProfile } from './media'
import type { VideoRuntime } from './video-media'

function storagePort(rows = new Map<string, string>()) {
  return { rows, getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value) } }
}
const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }

test('media parameter preferences survive a new storage reader and isolate enterprise, member, model and media kind', () => {
  const first = storagePort()
  const key = mediaPreferenceKey(scope, 'image', 'model-a')!
  const parameters = { aspectRatio: '3:2', size: '1536x1024', quality: 'high', count: 3 }
  saveMediaPreference(first, key, 'image', parameters)
  const restarted = storagePort(first.rows)
  assert.deepEqual(readMediaPreference(restarted, key, 'image'), parameters)
  for (const other of [
    mediaPreferenceKey({ ...scope, memberId: 'member-b' }, 'image', 'model-a'),
    mediaPreferenceKey({ ...scope, enterpriseId: 'enterprise-b' }, 'image', 'model-a'),
    mediaPreferenceKey(scope, 'image', 'model-b'), mediaPreferenceKey(scope, 'video', 'model-a'),
  ]) assert.deepEqual(readMediaPreference(restarted, other, 'image'), {})
  assert.notEqual(mediaPreferenceKey({ enterpriseId: 'a:b', memberId: 'c' }, 'image', 'd'), mediaPreferenceKey({ enterpriseId: 'a', memberId: 'b:c' }, 'image', 'd'))
})

test('missing identity never reads or writes a global preference and storage failures cannot block creation', () => {
  const port = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  for (const key of [mediaPreferenceKey(null, 'image', 'model-a'), mediaPreferenceKey({ ...scope, memberId: '' }, 'image', 'model-a'), mediaPreferenceKey(scope, 'image', '')]) {
    assert.equal(key, null)
    assert.deepEqual(readMediaPreference(port, key, 'image'), {})
    assert.doesNotThrow(() => saveMediaPreference(port, key, 'image', { count: 1 }))
  }
  assert.deepEqual(readMediaPreference(port, 'valid', 'image'), {})
  assert.doesNotThrow(() => saveMediaPreference(port, 'valid', 'image', { count: 1 }))
})

test('stored preferences accept parameters only and reject corruption, oversized data and private fields', () => {
  const port = storagePort()
  const key = mediaPreferenceKey(scope, 'image', 'model-a')!
  for (const raw of ['{', 'x'.repeat(4097), JSON.stringify({ count: '2' }), JSON.stringify({ count: 2, creativeBrief: 'private' }), JSON.stringify({ quality: 'high', quoteId: 'old-quote' })]) {
    port.rows.set(key, raw)
    assert.deepEqual(readMediaPreference(port, key, 'image'), {})
  }
  const previous = port.rows.get(key)
  saveMediaPreference(port, key, 'image', { audio: true })
  assert.equal(port.rows.get(key), previous)
})

test('restored image preferences are clamped to new capabilities without recovering old quotes or references', () => {
  const port = storagePort(), key = mediaPreferenceKey(scope, 'image', 'model-a')!
  saveMediaPreference(port, key, 'image', { aspectRatio: '3:2', size: '1536x1024', quality: 'high', count: 4 })
  const profile: MediaProfile = {
    profileId: 'model-a', kind: 'image', displayName: 'model', configVersion: 'new', operations: ['generate'], executionMode: 'sync-response',
    capabilities: { referenceImage: false, cancel: false, recoverByRequestId: true },
    allowedAspectRatios: ['1:1'], allowedSizes: ['1024x1024'], allowedQualities: ['medium'], defaultSize: '1024x1024', defaultQuality: 'medium', maxCount: 1,
  }
  assert.deepEqual(imageFormParameters(profile, readMediaPreference(port, key, 'image')), { aspectRatio: '1:1', size: '1024x1024', quality: 'medium', count: 1 })
})

test('restored video parameters honor changed fixed audio and model defaults', () => {
  const port = storagePort(), key = mediaPreferenceKey(scope, 'video', 'h3')!
  saveMediaPreference(port, key, 'video', { durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', frameRate: 30, audio: false, outputFormat: 'video/webm' })
  const runtime: VideoRuntime = { protocolVersion: 2, executionMode: 'real', executionAvailable: true, defaultProfileId: 'h3', tools: ['video_generate'], profiles: [{
    profileId: 'h3', kind: 'video', displayName: 'h3', configVersion: 'new', operations: ['text-to-video'], executionMode: 'async-query', capabilities: {
      supportsTextToVideo: true, supportsImageToVideo: false, supportsAudio: true, durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24],
      maxInputBytes: 1024, maxReferenceCount: 0, outputFormats: ['video/mp4'], supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 3600,
      audioModes: [true], defaultAudio: true, defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', frameRate: 24, audio: true, outputFormat: 'video/mp4' },
    },
  }] }
  const restored = readMediaPreference(storagePort(port.rows), key, 'video')
  assert.deepEqual(videoFormParameters(runtime, runtime.profiles[0], restored), runtime.profiles[0].capabilities.defaults)
})
