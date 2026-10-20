/** Invoked by SEP's opt-in video client integration test against an isolated loopback fixture. */
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fixture from '../src/shared/fixtures/media-video-v1.json'
import { videoRequestSchema } from '../src/shared/video-media'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../electron/common/platform/sep-media-gateway-contract'
import { SepMockVideoGateway } from '../electron/data/sep-video-media-gateway'
import { VideoStore } from '../electron/data/video-store'
import { VideoService } from '../electron/service/video-service'

async function run(): Promise<void> {
  const base = new URL(process.env.SEP_VIDEO_MOCK_TEST_BASE_URL ?? '')
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/api' || base.username || base.password || base.search || base.hash) throw new Error('Video test requires an isolated loopback SEP fixture.')
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-http-'))
  const counts = { submit: 0, quote: 0, content: 0 }
  const gateway = new SepMockVideoGateway({
    mock: true, baseUrl: base.href, subscriptionId: 'sub-1', token: async () => 'synthetic-video-employment-token',
    fetch: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/requests') && init?.method === 'POST') counts.submit++
      if (url.endsWith('/quotes')) counts.quote++
      if (url.endsWith('/content')) counts.content++
      return fetch(input, { ...init, headers: { ...init?.headers, 'x-test-auth': 'yes' } })
    },
  })
  const scope = { enterpriseId: 'enterprise-1', memberId: 'member-1', subscriptionId: 'sub-1' }
  const signal = new AbortController().signal
  let service = new VideoService({ scope, gateway, store: new VideoStore(root) })
  try {
    const profiles = await gateway.profiles(signal)
    assert.equal(profiles.persistence, 'database')
    assert.deepEqual(profiles.profiles, fixture.runtime.profiles)
    const reference = await gateway.uploadReference(Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64'), signal)
    const input = videoRequestSchema.parse({ ...fixture.quoteRequest, referenceIds: [reference.referenceId] })
    const submitted = await service.generate('task-http-video', input)
    assert.equal(submitted.receipt?.status, 'QUEUED')
    const running = await service.resume(submitted.taskId, submitted.jobId)
    assert.equal(running.receipt?.status, 'RUNNING')
    service.close()
    service = new VideoService({ scope, gateway, store: new VideoStore(root) })
    const restored = await service.recover()
    assert.equal(restored.length, 1)
    const done = restored[0]!
    assert.equal(done.receipt?.receiptId, submitted.receipt?.receiptId)
    assert.equal(done.receipt?.status, 'SUCCEEDED')
    assert.equal(done.saveStatus, 'SAVED')
    const output = done.receipt!.outputs[0]!
    const bytes = await new VideoStore(root).readAsset(scope, done.taskId, done.jobId, output.outputId)
    assert.deepEqual(Buffer.from(bytes), Buffer.from(fixture.mediaFixture.base64, 'base64'))
    service.close()
    service = new VideoService({ scope, gateway, store: new VideoStore(root) })
    const again = await service.recover()
    assert.equal(again[0]?.saveStatus, 'SAVED')
    assert.deepEqual(counts, { submit: 1, quote: 1, content: 1 })
    process.stdout.write(JSON.stringify({ mock: true, billingStatus: done.receipt!.billingStatus, receiptId: done.receipt!.receiptId, status: done.receipt!.status, saveStatus: done.saveStatus, byteLength: bytes.length, sha256: output.sha256, counts }) + '\n')
  } finally {
    service.close()
    await rm(root, { recursive: true, force: true })
  }
}
void run().catch(() => { process.stderr.write('Video mock roundtrip failed.\n'); process.exitCode = 1 })
