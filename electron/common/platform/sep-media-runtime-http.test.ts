import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { parseMediaCapabilities } from './media-contract'
import { optionalVideoRuntimeSchema } from './video-runtime-contract'
import * as videoFixture from '../../../src/shared/fixtures/media-video-v1.json'

test('SEP runtime contract passes through actual HTTP without enabling media execution', async t => {
  const fixtures: { media: unknown }[] = JSON.parse(readFileSync(
    new URL('./fixtures/sep-media-runtime-v1.json', import.meta.url), 'utf8',
  ))
  const requests: { path: string; authenticated: boolean }[] = []
  let media: unknown = fixtures[0].media
  let video: unknown
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    const authenticated = request.headers.authorization === 'Bearer fixture-access-not-a-real-token'
    requests.push({ path, authenticated })
    if (!authenticated) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }))
      return
    }
    if (path !== '/api/client/subscriptions/sub-http/runtime?mediaProtocolVersion=2&skillArtifactProtocolVersion=1&videoProtocolVersion=2') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      manifestVersion: 1, subscriptionId: 'sub-http', templateVersion: '1.0',
      employee: { id: 'employee-http', name: 'Fixture employee', version: '1.0', maxSteps: 10 },
      runtime: { systemPrompt: 'Fixture instructions', modelId: 'chat-fixture', allowedModels: ['chat-fixture'], skills: [], skillArtifactProtocolVersion: 1,
        ...(media === undefined ? {} : { media }), ...(video === undefined ? {} : { video }) },
    }))
  })
  const previousBaseUrl = process.env['SEP_BASE_URL']
  t.after(async () => {
    if (previousBaseUrl === undefined) delete process.env['SEP_BASE_URL']
    else process.env['SEP_BASE_URL'] = previousBaseUrl
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  process.env['SEP_BASE_URL'] = `http://127.0.0.1:${address.port}/api`
  const { getEmployeeRuntime } = await import('./platform-api')
  for (const fixture of fixtures) {
    media = fixture.media
    const manifest = await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')
    assert.deepEqual(manifest.runtime.media, fixture.media)
    assert.deepEqual(parseMediaCapabilities(manifest.runtime.media), { protocolVersion: 1, tools: [], profiles: [] })
    assert.equal(manifest.runtime.modelId, 'chat-fixture')
  }
  media = { mock: false, protocolVersion: 1, persistence: 'database', tools: ['image_generate', 'image_edit'], profiles: [{
    profileId: 'image-prod', kind: 'image', displayName: 'Production image', configVersion: 'config-v1', operations: ['generate', 'edit'],
    executionMode: 'sync-response', capabilities: { supportsReferenceImage: true, maxOutputs: 4,
      sizes: ['1024x1024', '1536x1024'], maxWidth: 1536, maxHeight: 1024 },
  }] }
  const realManifest = await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')
  assert.deepEqual(realManifest.runtime.media, media)
  assert.deepEqual(parseMediaCapabilities(realManifest.runtime.media).tools,
    ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'])
  assert.equal(parseMediaCapabilities(realManifest.runtime.media).profiles[0]?.profileId, 'image-prod')
  media = { protocolVersion: 1, executionAvailable: true, defaultProfileId: 'image-prod', tools: ['image_generate', 'image_edit'], profiles: [{
    profileId: 'image-prod', kind: 'image', displayName: 'Production image', configVersion: 'config-v1', operations: ['generate', 'edit'],
    executionMode: 'sync-response', capabilities: { supportsReferenceImage: true, maxOutputs: 8,
      sizes: ['1024x1024', '1536x1024'], maxWidth: 1536, maxHeight: 1024 },
  }] }
  const executableManifest = await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')
  const executableCapabilities = parseMediaCapabilities(executableManifest.runtime.media)
  assert.deepEqual(executableCapabilities.tools, ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'])
  assert.equal(executableCapabilities.profiles[0]?.maxCount, 4, 'The current local receipt contract accepts at most four outputs.')
  media = undefined
  assert.equal((await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')).runtime.media, undefined)
  video = videoFixture.runtime
  const videoManifest = await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')
  assert.deepEqual(videoManifest.runtime.video, videoFixture.runtime)
  assert.equal(Object.isFrozen(videoManifest.runtime.video?.profiles[0]?.capabilities), true)
  assert.equal(videoManifest.runtime.media, undefined)
  assert.equal(videoManifest.runtime.modelId, 'chat-fixture')
  const v2VideoProfile = { ...videoFixture.runtime.profiles[0]!, capabilities: { ...videoFixture.runtime.profiles[0]!.capabilities,
    supportsAudio: true,
    audioModes: [true], defaultAudio: true,
    defaults: { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: true, outputFormat: 'video/mp4' } } }
  video = { ...videoFixture.runtime, protocolVersion: 2, executionMode: 'real', profiles: [v2VideoProfile] }
  await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')
  const parsedV2Video = optionalVideoRuntimeSchema.parse(video)
  assert.equal(parsedV2Video?.protocolVersion, 2)
  assert.deepEqual(parsedV2Video?.profiles[0]?.capabilities.audioModes, [true])
  for (const invalidVideo of [
    { ...videoFixture.runtime, protocolVersion: 2 },
    { ...videoFixture.runtime, executionAvailable: false },
    { ...videoFixture.runtime, apiKey: 'private-video-secret' },
  ]) {
    video = invalidVideo
    const manifest = await getEmployeeRuntime('sub-http', 'fixture-access-not-a-real-token')
    assert.equal(manifest.runtime.video, undefined)
    assert.equal(manifest.runtime.modelId, 'chat-fixture')
    assert.equal(JSON.stringify(manifest).includes('private-video-secret'), false)
  }
  await assert.rejects(getEmployeeRuntime('sub-http', 'invalid-fixture-token'), error => {
    assert.equal((error as { statusCode?: number }).statusCode, 401)
    return true
  })
  assert.equal(requests.length, 11)
  assert.equal(requests.filter(request => request.authenticated).length, 10)
  assert.ok(requests.every(request => request.path === '/api/client/subscriptions/sub-http/runtime?mediaProtocolVersion=2&skillArtifactProtocolVersion=1&videoProtocolVersion=2'))
})
