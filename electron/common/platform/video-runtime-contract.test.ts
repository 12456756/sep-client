import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fixture from '../../../src/shared/fixtures/media-video-v1.json'
import { optionalVideoRuntimeSchema, videoRuntimeSnapshotSchema } from './video-runtime-contract'
import { parseEmployeeRuntimeManifest } from './employee-runtime-contract'
import { getEmployeeRuntime } from './platform-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function manifest(video?: unknown) {
  return {
    manifestVersion: 1, subscriptionId: 'sub-video', templateVersion: '1.0',
    employee: { id: 'employee-video', name: 'Video employee', version: '1.0', maxSteps: 10 },
    runtime: { systemPrompt: 'Chat instructions', modelId: 'chat-model', allowedModels: ['chat-model'],
      skills: [], skillArtifactProtocolVersion: 1, ...(video === undefined ? {} : { video }) },
  }
}

function invalidVideos(): unknown[] {
  const runtime = fixture.runtime
  const profile = runtime.profiles[0]!
  return [
    null, [], 'invalid', {},
    { ...runtime, protocolVersion: undefined },
    { ...runtime, protocolVersion: '1' },
    { ...runtime, protocolVersion: 2 },
    { ...runtime, executionAvailable: false },
    { ...runtime, profiles: [] },
    { ...runtime, defaultProfileId: 'missing' },
    { ...runtime, profiles: [profile, profile] },
    { ...runtime, tools: ['video_generate'] },
    { ...runtime, tools: ['video_cancel_job'] },
    { ...runtime, profiles: [{ ...profile, capabilities: { ...profile.capabilities, supportsImageToVideo: false } }] },
    { ...runtime, profiles: [{ ...profile, capabilities: { ...profile.capabilities, maxReferenceCount: 0 } }] },
    { ...runtime, apiKey: 'private-video-secret' },
    { ...runtime, upstreamUrl: 'https://private-video.invalid/v1' },
    { ...runtime, profiles: [{ ...profile, modelId: 'private-upstream-model' }] },
    { ...runtime, profiles: [{ ...profile, baseUrl: 'https://private-video.invalid/v1' }] },
    { ...runtime, profiles: [{ ...profile, capabilities: { ...profile.capabilities, token: 'private-video-secret' } }] },
  ]
}

describe('independent optional video runtime v1', () => {
  it('preserves the existing mock capabilities without upstream configuration', () => {
    const parsed = videoRuntimeSnapshotSchema.parse(fixture.runtime)
    assert.deepEqual(parsed, fixture.runtime)
    assert.deepEqual(parsed.tools, ['video_from_image', 'video_get_job'])
    assert.equal(parsed.profiles[0]?.capabilities.supportsCancel, false)
    for (const key of ['modelId', 'apiKey', 'baseUrl', 'upstreamUrl', 'secret']) {
      assert.equal(JSON.stringify(parsed).includes(`"${key}"`), false)
    }
  })

  it('clones and deeply freezes every nested capability array for snapshots', () => {
    const source = structuredClone(fixture.runtime)
    const parsed = videoRuntimeSnapshotSchema.parse(source)
    function assertFrozen(value: unknown): void {
      if (value === null || typeof value !== 'object') return
      assert.ok(Object.isFrozen(value))
      for (const child of Object.values(value)) assertFrozen(child)
    }
    assertFrozen(parsed)
    source.profiles[0]!.capabilities.durationsSeconds[0] = 600
    source.tools.length = 0
    assert.deepEqual(parsed, fixture.runtime)
    assert.notEqual(parsed, source)
  })

  it('accepts disabled runtimes only with zero tools', () => {
    for (const profiles of [[], fixture.runtime.profiles]) {
      const video = { protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles }
      assert.deepEqual(optionalVideoRuntimeSchema.parse(video), video)
      assert.equal(optionalVideoRuntimeSchema.parse({ ...video, tools: ['video_get_job'] }), undefined)
    }
  })

  it('strictly rejects invalid, newer, unacknowledged and sensitive snapshots while omitting optional fragments', () => {
    assert.equal(optionalVideoRuntimeSchema.parse(undefined), undefined)
    for (const video of invalidVideos()) {
      assert.equal(videoRuntimeSnapshotSchema.safeParse(video).success, false)
      assert.equal(optionalVideoRuntimeSchema.parse(video), undefined)
      const parsed = parseEmployeeRuntimeManifest(manifest(video))
      assert.equal(parsed.runtime.video, undefined)
      assert.equal(parsed.runtime.modelId, 'chat-model')
      assert.equal(parsed.runtime.systemPrompt, 'Chat instructions')
      assert.equal(JSON.stringify(parsed).includes('private-video'), false)
    }
  })

  it('keeps older servers usable without video or media while skill negotiation stays strict', async () => {
    const value = manifest()
    globalThis.fetch = async () => new Response(JSON.stringify(value))
    const parsed = await getEmployeeRuntime('sub-video', 'access')
    assert.equal(parsed.runtime.video, undefined)
    assert.equal(parsed.runtime.media, undefined)
    assert.equal(parsed.runtime.modelId, 'chat-model')
    for (const skillArtifactProtocolVersion of [undefined, 2]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...value, runtime: { ...value.runtime,
        video: fixture.runtime, skillArtifactProtocolVersion } }))
      await assert.rejects(getEmployeeRuntime('sub-video', 'access'), /negotiation failed|Invalid employee runtime manifest/)
    }
  })

  it('preserves video independently from media and uses the exact v1 query and bearer header', async () => {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/api/client/subscriptions/sub-video/runtime')
      assert.equal(url.search, '?mediaProtocolVersion=2&skillArtifactProtocolVersion=1&videoProtocolVersion=2')
      assert.deepEqual([...new Headers(init?.headers)], [['authorization', 'Bearer access']])
      const value = manifest(fixture.runtime)
      return new Response(JSON.stringify({ ...value, runtime: { ...value.runtime, media: { protocolVersion: 2 } } }))
    }
    const parsed = await getEmployeeRuntime('sub-video', 'access')
    assert.deepEqual(parsed.runtime.video, fixture.runtime)
    assert.equal(parsed.runtime.media, undefined)
    assert.equal(parsed.runtime.modelId, 'chat-model')
  })

  it('ignores invalid video from HTTP responses without suppressing media or chat', async () => {
    const media = { protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles: [] }
    for (const video of invalidVideos()) {
      const value = manifest(video)
      globalThis.fetch = async () => new Response(JSON.stringify({ ...value, runtime: { ...value.runtime, media } }))
      const parsed = await getEmployeeRuntime('sub-video', 'access')
      assert.equal(parsed.runtime.video, undefined)
      assert.deepEqual(parsed.runtime.media, media)
      assert.equal(parsed.runtime.systemPrompt, 'Chat instructions')
      assert.equal(JSON.stringify(parsed).includes('private-video'), false)
    }
  })
})
