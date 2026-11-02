import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { requiredArrangementMediaTools, summarizeArrangementMediaTools } from './arrangement-media-availability'
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

test('required media tools include legacy media deliverables without explicit requirements', () => {
  assert.deepEqual(requiredArrangementMediaTools({
    deliverables: [
      { id: 'poster', name: 'Poster', format: 'png', path: 'deliverables/poster.png', contentOutline: ['Poster'], acceptanceCriteria: ['Readable'], artifact: { kind: 'image', source: 'media-output' } },
      { id: 'video', name: 'Video', format: 'mp4', path: 'deliverables/video.mp4', contentOutline: ['Video'], acceptanceCriteria: ['Playable'], artifact: { kind: 'video', source: 'media-output', operation: 'image-to-video' } },
    ],
  }), ['media_generate_image', 'video_from_image'])
})
