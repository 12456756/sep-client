import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

function image(width: number, height: number): Buffer {
  const chunk = (kind: string, bytes: Buffer): Buffer => {
    const data = Buffer.concat([Buffer.from(kind), bytes]); let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0))])
}

test('negotiates actual SEP V3 runtime and saves an image through the model tool over HTTP', async t => {
  const bytes = image(1024, 1024)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const owner = { enterpriseId: 'enterprise-http', memberId: 'member-http' }
  const spec = { aspectRatio: '1:1', size: '1024x1024', count: 1, quality: 'high' }
  const sources = { aspectRatio: 'model', size: 'model', count: 'model', quality: 'model' }
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  let clientRequestId = ''
  const runtime = { protocolVersion: 3, executionMode: 'real', executionAvailable: true, defaultProfileId: 'image-http',
    tools: ['image_generate'], profiles: [{ profileId: 'image-http', configVersion: 'cfg-http', kind: 'image',
      displayName: 'HTTP image', operations: ['generate'], executionMode: 'sync-response', authorized: true,
      adapter: { id: 'sub2api-image', version: '1', available: true, operations: ['generate'],
        referenceSupport: { maxCount: 0, maxInputBytes: 10485760, mimeTypes: ['image/png'] },
        supportsTaskQuery: true, supportsCancel: false },
      capabilityHints: [{ field: 'size', values: ['1536x1024'], source: 'adapter', observedAt: null, confidence: 'declared' }],
    }] }
  const receipt = () => ({ mock: false, protocolVersion: 3, semanticHashVersion: 3, specRevision: 1,
    receiptId: 'receipt-http', clientRequestId, profileId: 'image-http', configVersion: 'cfg-http',
    executionMode: 'sync-response', status: 'SUCCEEDED', pollAfterMs: null, billingStatus: 'SETTLED', errorCode: null,
    outputErrors: [], recovery: { canQuery: true, canCancel: false, canDownload: true }, effectiveSpec: spec,
    actualSpec: { size: '1024x1024', width: 1024, height: 1024, count: 1 },
    acceptance: { status: 'unknown', mismatchedFields: [], unknownFields: ['quality'] },
    outputs: [{ outputId: 'output-http', kind: 'image', mimeType: 'image/png', byteLength: bytes.length,
      width: 1024, height: 1024, sha256, expiresAt: new Date(Date.now() + 60000).toISOString() }] })
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value))
    }
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-http-not-a-real-token')
      const path = request.url ?? ''
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : undefined
      calls.push({ path, body })
      if (path === '/api/client/subscriptions/sub-http/runtime?mediaProtocolVersion=3&skillArtifactProtocolVersion=1&videoProtocolVersion=3') {
        json({ manifestVersion: 1, subscriptionId: 'sub-http', templateVersion: '1.0',
          employee: { id: 'employee-http', name: 'HTTP employee', version: '1.0', maxSteps: 10 },
          runtime: { systemPrompt: 'HTTP instructions', modelId: 'chat-http', allowedModels: ['chat-http'],
            skills: [], skillArtifactProtocolVersion: 1, media: runtime } })
        return
      }
      const root = '/api/gateway/v1/media/real'
      if (path === `${root}/quotes`) {
        assert.equal(body?.protocolVersion, 3)
        assert.equal('parameters' in body!, false)
        assert.deepEqual(body?.requestedSpec, spec)
        assert.deepEqual(body?.parameterSources, sources)
        assert.equal(body?.specRevision, 1)
        // SEP binds the public digest to its authenticated scope and adapter.
        const semanticSha256 = createHash('sha256').update(JSON.stringify({ semanticHashVersion: 3, protocolVersion: 3,
          scope: 'fixture-server-scope', adapter: 'sub2api-image', profileId: body!.profileId, configVersion: body!.configVersion,
          operation: body!.operation, specRevision: body!.specRevision, referenceIds: [], referenceHashes: [],
          briefSha256: createHash('sha256').update(String(body!.creativeBrief).trim()).digest('hex'),
          requestedSpec: body!.requestedSpec, parameterSources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))),
        })).digest('hex')
        json({ mock: false, protocolVersion: 3, semanticHashVersion: 3, specRevision: 1, quoteId: 'quote-http',
          expiresAt: new Date(Date.now() + 60000).toISOString(), semanticSha256, pricingStatus: 'quoted', amountCny: '0.120000',
          pricingVersion: 'price-http', billingStatus: 'NOT_RESERVED',
          funding: { creditCny: '0.120000', memberWalletCny: '0.000000', personalCny: '0.000000' },
          profileId: 'image-http', configVersion: 'cfg-http', modelId: 'image-model-http', adapterVersion: '1',
          amountUsd: '0.020000', connectionFingerprint: 'a'.repeat(64), effectiveSpec: spec,
          billingDimensions: { size: spec.size, count: spec.count, quality: spec.quality }, normalizationNotes: [] })
        return
      }
      if (path === `${root}/requests` && request.method === 'POST') {
        assert.equal(clientRequestId, '')
        assert.equal(body?.quoteId, 'quote-http')
        assert.deepEqual(body?.requestedSpec, spec)
        assert.deepEqual(body?.parameterSources, sources)
        clientRequestId = String(body?.clientRequestId)
        json(receipt(), 202); return
      }
      if (path === `${root}/requests/receipt-http`) { json(receipt()); return }
      if (path === `${root}/requests/receipt-http/outputs/output-http/content`) {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length),
          'X-SHA256': sha256, 'X-SEP-Media-Mock': 'false' })
        response.end(bytes); return
      }
      json({ error: 'Unexpected request' }, 404)
    } catch (error) { json({ error: String(error) }, 500) }
  })
  const previousBaseUrl = process.env['SEP_BASE_URL']
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-v3-http-'))
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
  const { MediaStore } = await import('../../data/media-store')
  const { SepRealMediaGateway } = await import('../../data/sep-real-media-gateway')
  const { MediaService } = await import('../../service/media-service')
  const manifest = await getEmployeeRuntime('sub-http', 'fixture-http-not-a-real-token')
  assert.deepEqual(manifest.runtime.media, runtime)
  const employee = { subscriptionId: 'sub-http', media: manifest.runtime.media }
  const store = new MediaStore(directory)
  const service = new MediaService({ scope: { currentScope: () => owner }, store,
    gateway: new SepRealMediaGateway({ baseUrl, token: async () => 'fixture-http-not-a-real-token' }),
    getTask: async () => ({ subscriptionId: 'sub-http' }), authorize: async () => employee, requestApproval: async () => true,
    pollFloorMs: 1, operationTimeoutMs: 2000 })
  cleanup.stop = () => service.stopAll()
  const tools = await service.prepareRun({ taskId: 'task-http', runId: 'run-http', subscriptionId: 'sub-http',
    employee, requestApproval: async () => true })
  assert.ok(tools)
  const capabilities = await tools.execute('media_get_capabilities', {}, new AbortController().signal) as { capabilities: { protocolVersion: number } }
  assert.equal(capabilities.capabilities.protocolVersion, 3)
  const result = await tools.execute('media_generate_image', { creativeBrief: 'A product photograph', protocolVersion: 3,
    requestedSpec: spec, parameterSources: sources, specRevision: 1 }, new AbortController().signal) as { jobId: string }
  await service.waitForRun('task-http', 'run-http')
  const saved = await store.getJob(owner, 'task-http', result.jobId)
  assert.equal(saved?.saveStatus, 'SAVED')
  assert.equal(saved?.generationStatus, 'SUCCEEDED')
  assert.equal(saved?.billingStatus, 'SETTLED')
  assert.notEqual(saved?.errorCode, 'OUTPUT_SPEC_MISMATCH')
  assert.deepEqual(saved?.input.requestedSpec, spec)
  assert.deepEqual(saved?.request.parameterSources, sources)
  const assets = await store.listAssets(owner, 'task-http')
  assert.equal(assets.length, 1)
  assert.deepEqual(await store.readAsset(owner, 'task-http', assets[0].localAssetId), bytes)
  assert.equal(calls.filter(call => call.path.endsWith('/quotes')).length, 1)
  assert.equal(calls.filter(call => call.path.endsWith('/requests')).length, 1)
})
