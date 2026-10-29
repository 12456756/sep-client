import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { summarizeArrangementMediaTools } from './arrangement-media-availability'
import { MOCK_MEDIA_CAPABILITIES } from '../data/mock-media-gateway'

test('media summaries distinguish runtime tools, missing grants and unavailable adapters', () => {
  const runtime = { authorized: true, image: MOCK_MEDIA_CAPABILITIES, imageHost: true, video: fixture.runtime, videoHostMode: 'mock' as const }
  const result = summarizeArrangementMediaTools(runtime)
  assert.equal(result.media_generate_image.state, 'available')
  assert.equal(result.video_generate.state, 'unavailable')
  assert.equal(result.video_from_image.state, 'available')
  assert.equal(summarizeArrangementMediaTools({ ...runtime, imageHost: false }).media_generate_image.reason, 'host-unavailable')
  assert.equal(summarizeArrangementMediaTools({ ...runtime, authorized: false }).video_generate.reason, 'not-authorized')
  assert.equal(summarizeArrangementMediaTools({ ...runtime, videoHostMode: 'real' }).video_generate.state, 'unavailable')
  assert.equal(summarizeArrangementMediaTools({ ...runtime, video: {} }).video_generate.reason, 'runtime-unavailable')
})
