import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fixture from '../../../src/shared/fixtures/media-video-v1.json'

test('negotiates actual SEP V3 video runtime and saves a tool-generated video over HTTP', async t => {
  const bytes = Buffer.from(fixture.mediaFixture.base64, 'base64')
  const scope = { enterpriseId: 'enterprise-http', memberId: 'member-http', subscriptionId: 'sub-video-http' }
  const spec = { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' }
  const sources = Object.fromEntries(Object.keys(spec).map(field => [field, { source: 'model', decisionRef: 'video-brief' }]))
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  let clientRequestId = ''
  const runtime = { protocolVersion: 3, executionMode: 'real', executionAvailable: true, defaultProfileId: 'video.http',
    tools: ['video_generate', 'video_get_job'], profiles: [{ profileId: 'video.http', configVersion: 'cfg-http', kind: 'video',
      displayName: 'HTTP video', operations: ['text-to-video'], executionMode: 'async-query', authorized: true,
      adapter: { id: 'sub2api-video', version: '1', available: true, operations: ['text-to-video'],
        referenceSupport: { maxCount: 0, maxInputBytes: 10485760, mimeTypes: ['image/png'] },
        supportsTaskQuery: true, supportsCancel: false },
      capabilityHints: [{ field: 'durationSeconds', values: [4], source: 'adapter', observedAt: null, confidence: 'declared' }],
    }] }
  const billingDimensions = { model: 'video-model-http', operation: 'text-to-video', durationSeconds: 5, resolution: '720p' }
  const receipt = () => ({ mock: false, protocolVersion: 3, semanticHashVersion: 3, specRevision: 1,
    receiptId: 'receipt-video-http', clientRequestId, profileId: 'video.http', configVersion: 'cfg-http', operation: 'text-to-video',
    status: 'SUCCEEDED', pollAfterMs: null, billingStatus: 'SETTLED', errorCode: null,
    recovery: { canQuery: false, canCancel: false, canDownload: true }, effectiveSpec: spec, billingDimensions,
    actualSpec: { durationSeconds: 5, width: 720, height: 1280, frameRate: 24, mimeType: 'video/mp4', hasAudio: false, source: 'measured' },
    deliveryStatus: 'matched', amountCny: '0.120000', actualCostCny: '0.120000', amountUsd: '0.02',
    outputs: [{ ...fixture.output, outputId: 'output-video-http', expiresAt: null }] })
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value))
    }
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-video-http-not-a-real-token')
      const path = request.url ?? ''
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : undefined
      calls.push({ path, body })
      if (path === '/api/client/subscriptions/sub-video-http/runtime?mediaProtocolVersion=3&skillArtifactProtocolVersion=1&videoProtocolVersion=3') {
        json({ manifestVersion: 1, subscriptionId: scope.subscriptionId, templateVersion: '1.0',
          employee: { id: 'employee-http', name: 'HTTP employee', version: '1.0', maxSteps: 10 },
          runtime: { systemPrompt: 'HTTP instructions', modelId: 'chat-http', allowedModels: ['chat-http'],
            skills: [], skillArtifactProtocolVersion: 1, video: runtime } })
        return
      }
      const root = '/api/gateway/v1/media/video-real'
      if (path === `${root}/quotes`) {
        assert.equal(body?.protocolVersion, 3)
        assert.equal('parameters' in body!, false)
        assert.deepEqual(body?.referenceIds, [])
        assert.deepEqual(body?.requestedSpec, spec)
        assert.deepEqual(body?.parameterSources, sources)
        assert.equal(body?.specRevision, 1)
        json({ mock: false, protocolVersion: 3, semanticHashVersion: 3, specRevision: 1, quoteId: 'quote-video-http',
          expiresAt: new Date(Date.now() + 60000).toISOString(), semanticSha256: 'a'.repeat(64),
          pricingStatus: 'quoted', amountCny: '0.120000', amountUsd: '0.02', pricingVersion: 'price-http', usdToCnyRate: 6,
          billingStatus: 'NOT_RESERVED', funding: { creditCny: '0.120000', memberWalletCny: '0.000000', personalCny: '0.000000' },
          effectiveSpec: spec, billingDimensions })
        return
      }
      if (path === `${root}/requests` && request.method === 'POST') {
        assert.equal(clientRequestId, '')
        assert.equal(body?.quoteId, 'quote-video-http')
        assert.equal('parameters' in body!, false)
        assert.deepEqual(body?.requestedSpec, spec)
        assert.deepEqual(body?.parameterSources, sources)
        clientRequestId = String(body?.clientRequestId)
        json(receipt(), 202); return
      }
      if (path === `${root}/requests/receipt-video-http`) { json(receipt()); return }
      if (path === `${root}/requests/receipt-video-http/outputs/output-video-http/content`) {
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length),
          'X-SHA256': fixture.mediaFixture.sha256, 'X-SEP-Media-Mock': 'false' })
        response.end(bytes); return
      }
      json({ error: 'Unexpected request' }, 404)
    } catch (error) { json({ error: String(error) }, 500) }
  })
  const previousBaseUrl = process.env['SEP_BASE_URL']
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-v3-http-'))
  const cleanup: { stop?: () => Promise<void> } = {}
  t.after(async () => {
    await cleanup.stop?.()
    if (previousBaseUrl === undefined) delete process.env['SEP_BASE_URL']
    else process.env['SEP_BASE_URL'] = previousBaseUrl
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}/api`
  process.env['SEP_BASE_URL'] = baseUrl
  const { getEmployeeRuntime } = await import('./platform-api')
  const { videoRuntimeSchema } = await import('../../../src/shared/video-media')
  const { VideoStore } = await import('../../data/video-store')
  const { SepRealVideoGateway } = await import('../../data/sep-video-media-gateway')
  const { VideoRunService } = await import('../../service/video-run-service')
  const manifest = await getEmployeeRuntime(scope.subscriptionId, 'fixture-video-http-not-a-real-token')
  const video = videoRuntimeSchema.parse(manifest.runtime.video)
  assert.equal(video.protocolVersion, 3)
  const employee = { subscriptionId: scope.subscriptionId, modelId: 'chat-http', gatewayUrl: baseUrl, video }
  const store = new VideoStore(directory)
  const service = new VideoRunService({ mock: false, scope: { currentScope: () => scope }, store,
    gateway: () => new SepRealVideoGateway({ mock: false, baseUrl, subscriptionId: scope.subscriptionId,
      token: async () => 'fixture-video-http-not-a-real-token' }),
    authorizationRevision: () => 0, getTask: async () => ({ subscriptionId: scope.subscriptionId }),
    authorize: async () => video, requestApproval: async () => true,
    readReference: async () => assert.fail('Text-to-video must not upload a reference'),
    tracker: { floorMs: 1, maxAttempts: 4, budgetMs: 5000 } })
  cleanup.stop = () => service.stopAll()
  const tools = await service.prepareRun({ taskId: 'task-video-http', runId: 'run-video-http', subscriptionId: scope.subscriptionId,
    employee, requestApproval: async () => true })
  assert.ok(tools)
  const result = await tools.execute('video_generate', { creativeBrief: 'A short vertical product video', protocolVersion: 3,
    requestedSpec: spec, parameterSources: sources, specRevision: 1 }) as { jobId: string }
  await service.waitForRun('task-video-http', 'run-video-http')
  const saved = await store.getJob(scope, 'task-video-http', result.jobId)
  assert.equal(saved?.saveStatus, 'SAVED')
  assert.equal(saved?.receipt?.status, 'SUCCEEDED')
  assert.equal(saved?.receipt?.billingStatus, 'SETTLED')
  assert.deepEqual(saved?.request.requestedSpec, spec)
  assert.deepEqual(saved?.request.parameterSources, sources)
  assert.deepEqual(await store.readAsset(scope, 'task-video-http', result.jobId, 'output-video-http'), bytes)
  const view = await tools.execute('video_get_job', { jobId: result.jobId }) as { error: string | null; actualSpec: { audio?: boolean } }
  assert.equal(view.error, null)
  assert.equal(view.actualSpec.audio, false)
  assert.equal(calls.filter(call => call.path.endsWith('/quotes')).length, 1)
  assert.equal(calls.filter(call => call.path.endsWith('/requests')).length, 1)
})
