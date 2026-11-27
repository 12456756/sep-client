import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sepVideoToVideoRuntimeFixture } from '../../../src/shared/fixtures/sep-media-runtime-v3'
import { videoRuntimeSchema } from '../../../src/shared/video-media'
import * as fixture from '../../../src/shared/fixtures/media-video-v1.json'
import { VideoStore } from '../../data/video-store'
import { VideoReferenceStore } from '../../data/video-reference-store'
import { SepRealVideoGateway } from '../../data/sep-video-media-gateway'
import { VideoRunService } from '../../service/video-run-service'

test('V3 video-to-video uploads originals over HTTP, freezes both IDs, saves the output and deduplicates a tool retry', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-v2v-http-'))
  const scope = { enterpriseId: 'ent-http', memberId: 'member-http', subscriptionId: 'employee-http' }
  const runtime = videoRuntimeSchema.parse(sepVideoToVideoRuntimeFixture())
  const original = Buffer.from(fixture.mediaFixture.base64, 'base64')
  const source = join(root, 'original.mp4'); await writeFile(source, original)
  const references = new VideoReferenceStore(root)
  const imported = await references.import(scope, 'task-http', [source, source], runtime.profiles[0].videoReferenceSupport!, new AbortController().signal, () => {})
  const localVideoAssetIds = imported.map(asset => asset.localAssetId).reverse()
  const spec = { durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', audio: false, outputFormat: 'video/mp4' }
  const parameterSources = Object.fromEntries(Object.keys(spec).map(field => [field, 'user']))
  const billingDimensions = { model: 'fixture-model', operation: 'video-to-video', durationSeconds: 5, resolution: '720p' }
  let uploads = 0, quotes = 0, submits = 0, clientRequestId = ''
  let quoted: Record<string, unknown> | undefined
  const receipt = () => ({ mock: false, protocolVersion: 3, semanticHashVersion: 3, specRevision: 1,
    receiptId: 'receipt-http', clientRequestId, profileId: 'video_example', configVersion: '1', operation: 'video-to-video',
    status: 'SUCCEEDED', pollAfterMs: null, billingStatus: 'SETTLED', errorCode: null,
    recovery: { canQuery: false, canCancel: false, canDownload: true }, effectiveSpec: spec, billingDimensions,
    actualSpec: { durationSeconds: 5, width: 1280, height: 720, frameRate: 24, mimeType: 'video/mp4', hasAudio: false, source: 'measured' },
    deliveryStatus: 'matched', amountCny: '0.120000', actualCostCny: '0.120000', amountUsd: '0.02',
    outputs: [{ ...fixture.output, outputId: 'output-http', expiresAt: null }] })
  const serverErrors: unknown[] = []
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-not-a-real-token')
      const url = new URL(request.url!, 'http://127.0.0.1')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      if (url.pathname.endsWith('/video-references')) {
        assert.equal(url.searchParams.get('profileId'), 'video_example'); assert.equal(url.searchParams.get('configVersion'), '1')
        const form = await new Response(bytes, { headers: { 'Content-Type': request.headers['content-type']! } }).formData()
        assert.deepEqual([...form.keys()], ['file'])
        const file = form.get('file'); assert.ok(file && typeof file !== 'string')
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), original)
        json({ mock: false, kind: 'video', profileId: 'video_example', configVersion: '1', referenceId: `video-http-${++uploads}`,
          mimeType: 'video/mp4', byteLength: original.length, sha256: imported[0].sha256, expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201)
        return
      }
      const body = bytes.length ? JSON.parse(bytes.toString('utf8')) as Record<string, unknown> : undefined
      if (url.pathname.endsWith('/quotes')) {
        quotes++; quoted = body
        assert.equal(body?.operation, 'video-to-video'); assert.equal(body?.protocolVersion, 3)
        assert.deepEqual(body?.referenceIds, []); assert.deepEqual(body?.videoReferenceIds, ['video-http-1', 'video-http-2'])
        assert.deepEqual(body?.requestedSpec, spec); assert.deepEqual(body?.parameterSources, parameterSources)
        assert.equal('parameters' in body!, false)
        json({ mock: false, protocolVersion: 3, semanticHashVersion: 3, specRevision: 1, quoteId: 'quote-http',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), semanticSha256: 'a'.repeat(64), pricingStatus: 'quoted',
          amountCny: '0.120000', amountUsd: '0.02', pricingVersion: 'price-http', usdToCnyRate: 6, billingStatus: 'NOT_RESERVED',
          funding: { creditCny: '0.120000', memberWalletCny: '0.000000', personalCny: '0.000000' }, effectiveSpec: spec, billingDimensions })
        return
      }
      if (url.pathname.endsWith('/requests') && request.method === 'POST') {
        submits++
        const { clientRequestId: id, quoteId, ...semantic } = body!
        assert.equal(quoteId, 'quote-http'); assert.deepEqual(semantic, quoted)
        clientRequestId = String(id); json(receipt(), 202); return
      }
      if (url.pathname.endsWith('/requests/receipt-http')) { json(receipt()); return }
      if (url.pathname.endsWith('/content')) {
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(original.length), 'X-SHA256': fixture.mediaFixture.sha256 })
        response.end(original); return
      }
      json({ error: 'Unexpected fixture request' }, 404)
    } catch (error) { serverErrors.push(error); json({ error: 'Fixture validation failed' }, 500) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}/api`
  const store = new VideoStore(root)
  const service = new VideoRunService({ mock: false, scope: { currentScope: () => scope }, store, videoReferences: references,
    getTask: async () => ({ subscriptionId: scope.subscriptionId }), authorizationRevision: () => 0,
    authorize: async () => runtime,
    readReference: async () => assert.fail('Video-to-video cannot read image references'),
    gateway: () => new SepRealVideoGateway({ mock: false, baseUrl, subscriptionId: scope.subscriptionId, token: async () => 'fixture-not-a-real-token' }),
    tracker: { floorMs: 1, maxAttempts: 4, budgetMs: 5000 } })
  t.after(async () => {
    await service.stopAll(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  })
  const tools = await service.prepareRun({ taskId: 'task-http', runId: 'run-http', subscriptionId: scope.subscriptionId,
    employee: { subscriptionId: scope.subscriptionId, modelId: 'fixture-model', gatewayUrl: baseUrl, video: runtime } })
  assert.ok(tools)
  assert.ok(tools.names.includes('video_from_video'))
  const discovery = await tools.execute('video_get_job', {}) as { referenceVideos: { localAssetId: string }[] }
  assert.deepEqual(discovery.referenceVideos.map(asset => asset.localAssetId), imported.map(asset => asset.localAssetId))
  const input = { creativeBrief: 'Change to a night street', protocolVersion: 3, specRevision: 1, requestedSpec: spec, parameterSources, localVideoAssetIds }
  const result = await tools.execute('video_from_video', input) as { jobId: string; saveStatus: string }
  assert.equal(result.saveStatus, 'SAVED')
  assert.deepEqual((await store.getJob(scope, 'task-http', result.jobId))?.localReferenceIds, localVideoAssetIds)
  assert.deepEqual(await store.readAsset(scope, 'task-http', result.jobId, 'output-http'), original)
  assert.equal((await tools.execute('video_from_video', input) as { jobId: string }).jobId, result.jobId)
  assert.deepEqual({ uploads, quotes, submits }, { uploads: 2, quotes: 1, submits: 1 })
  assert.deepEqual(serverErrors, [])
})
