import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { sepRuntimeV3Fixture } from '../../../src/shared/fixtures/sep-media-runtime-v3'
import { videoRuntimeSchema } from '../../../src/shared/video-media'
import { sepMediaRuntimeSchema, toLocalMediaCapabilities } from './sep-media-runtime-contract'

test('new V3 runtime does not grant tools for unapproved or unavailable profiles', () => {
  for (const kind of ['image', 'video'] as const) {
    const ready = sepRuntimeV3Fixture(kind)
    const unavailable = {
      ...ready, status: 'unavailable', executionAvailable: false, defaultProfileId: null, tools: [],
      profiles: ready.profiles.map(profile => ({ ...profile, adapter: { ...profile.adapter, available: false, reason: 'PROFILE_DISABLED' },
        unavailableReason: 'PROFILE_DISABLED', unavailableMessage: 'Disabled.' })),
    }
    const schema = kind === 'image' ? sepMediaRuntimeSchema : videoRuntimeSchema
    assert.ok(schema.safeParse(unavailable).success)
    const parsed = kind === 'image' ? toLocalMediaCapabilities(unavailable) : videoRuntimeSchema.parse(unavailable)
    assert.deepEqual(parsed.tools, [])
    assert.deepEqual(parsed.profiles, [])
    assert.equal(schema.safeParse({ ...unavailable, tools: ready.tools }).success, false)
    assert.equal(schema.safeParse({ ...ready, profiles: ready.profiles.map(profile => ({ ...profile, authorized: false })) }).success, false)
  }
})

test('new V3 runtime rejects invalid reference rules and retains supported operations only', () => {
  const image = sepRuntimeV3Fixture('image')
  const profile = image.profiles[0]
  assert.equal(sepMediaRuntimeSchema.safeParse({ ...image, profiles: [{ ...profile,
    referenceRules: profile.referenceRules.map(rule => ({ ...rule, maxCount: 5 })),
  }] }).success, false)
  const generate = toLocalMediaCapabilities({ ...image, tools: ['image_generate'] })
  assert.deepEqual(generate.profiles[0].operations, ['generate'])
  assert.equal(generate.profiles[0].capabilities.referenceImage, false)
  const video = sepRuntimeV3Fixture('video')
  assert.deepEqual(videoRuntimeSchema.parse({ ...video, tools: ['video_generate', 'video_get_job', 'video_cancel_job'] }).tools,
    ['video_generate', 'video_get_job'])
})
