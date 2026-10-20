import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../electron/common/platform/sep-media-gateway-contract'
import * as fixture from '../src/shared/fixtures/media-video-v1.json'
import { videoRuntimeSchema, type VideoRequest } from '../src/shared/video-media'
import { approveLiveVideo, cnyMicros, liveVideoConfigSchema, loadLiveVideoConfig, runVideoV2Live, validateLiveBase } from './test-video-v2-live'

const parameters = { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' as const, frameRate: 24, audio: true, outputFormat: 'video/mp4' as const }
const configInput = {
  baseUrl: 'http://127.0.0.1:12345/api', accessToken: 'private-access-token', employmentToken: 'private-employment-token',
  enterpriseId: 'enterprise-live', memberId: 'member-live', subscriptionId: 'subscription-live', profileId: 'h3-live',
  operation: 'text-to-video' as const, outputRoot: '/private/isolated-evidence', paid: true as const, capCny: '2.000000',
  creativeBrief: 'Offline unit test only', parameters,
}
const paidInput = () => ({ mock: false, parameters, creativeBrief: configInput.creativeBrief, profile: 'H3',
  quote: { amount: '1.900000', currency: 'CNY', expiresAt: Date.now() + 60_000, amountUsd: '0.25', pricingVersion: 'live-v1',
    funding: { creditCny: '1.900000', memberWalletCny: '0.000000', personalCny: '0.000000' } } })

test('live configuration requires explicit paid consent, positive decimal CNY cap and a bounded budget', () => {
  for (const change of [{ paid: false }, { paid: undefined }, { capCny: '0' }, { capCny: '-1' }, { capCny: 'NaN' },
    { capCny: '1.0000001' }, { capCny: undefined }, { budgetMs: 900_001 }, { operation: 'image-to-video' },
    { modelId: 'other-model' }, { pngPath: '/private/unused.png' }]) {
    assert.equal(liveVideoConfigSchema.safeParse({ ...configInput, ...change }).success, false)
  }
  assert.equal(liveVideoConfigSchema.parse(configInput).budgetMs, 900_000)
  assert.equal(cnyMicros('9007199254740993.000001'), 9007199254740993000001n)
  assert.equal(cnyMicros('0.1'), 100_000n)
})

test('live runner rejects external/ambiguous origins before authentication or network I/O', () => {
  for (const base of ['https://example.invalid/api', 'http://localhost:12345/api', 'http://127.0.0.1/api',
    'http://private@127.0.0.1:12345/api', 'http://127.0.0.1:12345/api/', 'http://127.0.0.1:12345/api?x=1']) {
    assert.throws(() => validateLiveBase(base))
  }
  assert.equal(validateLiveBase(configInput.baseUrl).href, configInput.baseUrl)
})

test('each live approval verifies CNY currency, exact parameters, expiry, cap and image upload ordering', () => {
  const config = liveVideoConfigSchema.parse(configInput)
  assert.equal(approveLiveVideo(paidInput(), config, false), 'quote')
  for (const quote of [{ amount: '2.000001' }, { amount: '0.000000' }, { currency: 'MOCK' }, { expiresAt: 0 }]) {
    assert.throws(() => approveLiveVideo({ ...paidInput(), quote: { ...paidInput().quote, ...quote } }, config, false))
  }
  assert.throws(() => approveLiveVideo({ ...paidInput(), mock: true }, config, false))
  assert.throws(() => approveLiveVideo({ ...paidInput(), parameters: { ...parameters, durationSeconds: 5 } }, config, false))
  const image = liveVideoConfigSchema.parse({ ...configInput, operation: 'image-to-video', pngPath: '/private/ref.png' })
  assert.throws(() => approveLiveVideo(paidInput(), image, false))
  assert.equal(approveLiveVideo({ operation: 'upload-references', referenceCount: 1, mock: false }, image, false), 'upload')
  assert.equal(approveLiveVideo(paidInput(), image, true), 'quote')
  assert.throws(() => approveLiveVideo({ operation: 'upload-references', referenceCount: 1, mock: false }, image, true))
})

test('private config, PNG and evidence cannot use repository paths, symlinks or public token files', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-live-private-unit-'))
  try {
    const file = join(root, 'config.json')
    const write = (value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 })
    await write({ ...configInput, outputRoot: join(root, 'evidence') })
    assert.equal((await loadLiveVideoConfig(file)).paid, true)
    await chmod(file, 0o644)
    await assert.rejects(loadLiveVideoConfig(file), /private-path-permissions/)
    await chmod(file, 0o600)
    const linked = join(root, 'link.json')
    await symlink(file, linked)
    await assert.rejects(loadLiveVideoConfig(linked), /symlinked-private-path/)
    await assert.rejects(loadLiveVideoConfig('relative.json'), /absolute-private-path-required/)
    const repo = fileURLToPath(new URL('..', import.meta.url))
    await write({ ...configInput, outputRoot: resolve(repo, 'outputs/must-not-be-used') })
    await assert.rejects(loadLiveVideoConfig(file), /private-path-inside-repository/)
    await write({ ...configInput, outputRoot: resolve(repo, '../SEP/outputs/must-not-be-used') })
    await assert.rejects(loadLiveVideoConfig(file), /private-path-inside-repository/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('server token JSON accepts runtimeUrl/cacheDirectory metadata but still requires explicit paid/cap/operation inputs', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-live-server-config-unit-'))
  try {
    const path = join(root, 'tokens.json')
    const { paid: _paid, capCny: _cap, operation: _operation, outputRoot: _output, creativeBrief: _brief, ...credentials } = configInput
    const input = { ...credentials, kind: 'video-v2-live', accessTokenExpiresIn: 900,
      runtimeUrl: `${configInput.baseUrl}/client/subscriptions/${configInput.subscriptionId}/runtime?videoProtocolVersion=1`,
      cacheDirectory: join(root, 'evidence'), configVersion: 'h3-live-version', modelId: 'minimax-h3' }
    await writeFile(path, JSON.stringify(input), { mode: 0o600 })
    await assert.rejects(loadLiveVideoConfig(path))
    const env = { SEP_VIDEO_V2_LIVE_PAID: 'true', SEP_VIDEO_V2_LIVE_CAP_CNY: '2',
      SEP_VIDEO_V2_LIVE_OPERATION: 'text-to-video', SEP_VIDEO_V2_LIVE_CREATIVE_BRIEF: 'Unit only' }
    const parsed = await loadLiveVideoConfig(path, env)
    assert.equal(parsed.outputRoot, input.cacheDirectory)
    assert.equal(parsed.capCny, '2'); assert.equal(parsed.configVersion, 'h3-live-version')
    await assert.rejects(loadLiveVideoConfig(path, { ...env, SEP_VIDEO_V2_LIVE_PAID: '1' }))
    for (const runtimeUrl of ['https://example.invalid/runtime?videoProtocolVersion=1',
      `${configInput.baseUrl}/client/subscriptions/other/runtime?videoProtocolVersion=1`,
      `${input.runtimeUrl}&videoProtocolVersion=1`, `${input.runtimeUrl}&unexpected=1`]) {
      await writeFile(path, JSON.stringify({ ...input, runtimeUrl }), { mode: 0o600 })
      await assert.rejects(loadLiveVideoConfig(path, env), /invalid-runtime-url/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Offline HTTP doubles are test-only. The live entry point has no fixture or mock transport.
async function offlineServer(operation: 'text-to-video' | 'image-to-video', overCap = false, corruptFirstDownload = false) {
  const bytes = Buffer.from(fixture.mediaFixture.base64, 'base64')
  const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
  const runtimeProfile = { ...fixture.runtime.profiles[0], profileId: 'h3-live', configVersion: 'h3-live-version',
    operations: ['text-to-video', 'image-to-video'], capabilities: { ...fixture.runtime.profiles[0].capabilities,
      supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: true,
      durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24] } }
  const runtime = videoRuntimeSchema.parse({ ...fixture.runtime, executionMode: 'real', profiles: [runtimeProfile],
    defaultProfileId: runtimeProfile.profileId, tools: ['video_generate', 'video_from_image', 'video_get_job'] })
  const counts = { runtime: 0, references: 0, quotes: 0, submits: 0, queries: 0, downloads: 0 }
  let submitted: VideoRequest | undefined
  const failures: unknown[] = []
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers['x-test-auth'], undefined)
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const url = new URL(req.url!, configInput.baseUrl)
      const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      if (url.pathname.endsWith('/runtime')) {
        counts.runtime++
        assert.equal(req.headers.authorization, 'Bearer private-access-token')
        assert.equal(url.searchParams.get('videoProtocolVersion'), '1')
        return json({ manifestVersion: 1, subscriptionId: configInput.subscriptionId, templateVersion: 'v1',
          employee: { id: 'employee-live', name: 'Live', version: 'v1', maxSteps: 5 },
          runtime: { video: runtime, systemPrompt: '', modelId: 'llm', allowedModels: ['llm'], skills: [], skillArtifactProtocolVersion: 1 } })
      }
      assert.equal(req.headers.authorization, 'Bearer private-employment-token')
      assert.ok(url.pathname.startsWith('/api/gateway/v1/media/video-real/'))
      if (url.pathname.endsWith('/profiles')) return json({ mock: false, protocolVersion: 1, persistence: 'database', billingStatus: 'NOT_RESERVED', profiles: [runtimeProfile] })
      if (url.pathname.endsWith('/references')) {
        counts.references++; assert.equal(operation, 'image-to-video'); assert.ok(body.includes(png))
        return json({ mock: false, referenceId: 'live-ref', mimeType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'),
          byteLength: png.byteLength, width: 1, height: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })
      }
      if (url.pathname.endsWith('/quotes')) {
        counts.quotes++
        const value = JSON.parse(body.toString())
        assert.equal(value.operation, operation)
        assert.deepEqual(value.referenceIds, operation === 'image-to-video' ? ['live-ref'] : [])
        return json({ mock: false, quoteId: 'live-quote', expiresAt: new Date(Date.now() + 60_000).toISOString(), semanticSha256: 'b'.repeat(64),
          pricingStatus: 'quoted', amountCny: overCap ? '2.000001' : '1.900000', amountUsd: '0.25', pricingVersion: 'live-v1', usdToCnyRate: 7.6,
          funding: { creditCny: overCap ? '2.000001' : '1.900000', memberWalletCny: '0.000000', personalCny: '0.000000' }, billingStatus: 'NOT_RESERVED' })
      }
      const receipt = () => {
        assert.ok(submitted)
        return { mock: false, receiptId: 'live-receipt', clientRequestId: submitted.clientRequestId,
          profileId: submitted.profileId, configVersion: submitted.configVersion, operation: submitted.operation,
          status: 'SUCCEEDED', pollAfterMs: null, billingStatus: 'SETTLED', amountCny: '1.900000', actualCostCny: '1.800000', amountUsd: '0.25', errorCode: null,
          recovery: { canQuery: false, canCancel: false, canDownload: true },
          outputs: [{ ...fixture.output, width: 960, height: 540, durationSeconds: 4.25, frameRate: 30,
            expiresAt: new Date(Date.now() + 60_000).toISOString() }] }
      }
      if (url.pathname.endsWith('/requests') && req.method === 'POST') {
        counts.submits++; assert.equal(counts.submits, 1)
        submitted = JSON.parse(body.toString())
        assert.equal(submitted!.operation, operation)
        assert.deepEqual(submitted!.referenceIds, operation === 'image-to-video' ? ['live-ref'] : [])
        // The server accepted the original request; the caller never got its receipt.
        req.socket.destroy()
        return
      }
      if (url.pathname.endsWith('/content')) {
        counts.downloads++
        res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', bytes.length)
        if (corruptFirstDownload && counts.downloads === 1) {
          const corrupt = Buffer.from(bytes); corrupt[0] ^= 0xff
          return res.end(corrupt)
        }
        return res.end(bytes)
      }
      counts.queries++
      if (url.pathname.includes('/by-client-id/')) assert.ok(url.pathname.endsWith(`/${submitted!.clientRequestId}`))
      return json(receipt())
    })().catch(error => { failures.push(error); res.statusCode = 500; res.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { baseUrl: `http://127.0.0.1:${address.port}/api`, counts, failures,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

for (const operation of ['text-to-video', 'image-to-video'] as const) {
  test(`offline ${operation}: real adapter/host/store recover accepted POST once and reopen original receipt`, async () => {
    const server = await offlineServer(operation)
    const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-live-offline-unit-'))
    const nativeFetch = globalThis.fetch
    try {
      const path = join(root, 'config.json'), pngPath = join(root, 'reference.png')
      await writeFile(pngPath, Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64'), { mode: 0o600 })
      await writeFile(path, JSON.stringify({ ...configInput, baseUrl: server.baseUrl, operation, outputRoot: join(root, 'evidence'),
        kind: 'video-live', accessTokenExpiresIn: 900, configVersion: 'h3-live-version',
        runtimeUrl: `${server.baseUrl}/client/subscriptions/${configInput.subscriptionId}/runtime?videoProtocolVersion=1`,
        ...(operation === 'image-to-video' ? { pngPath } : {}), budgetMs: 15_000 }), { mode: 0o600 })
      const first = await runVideoV2Live(path)
      assert.equal(globalThis.fetch, nativeFetch)
      assert.equal(first.mock, false); assert.equal(first.saveStatus, 'SAVED'); assert.equal(first.billingStatus, 'SETTLED')
      assert.equal(first.originalReceiptRestored, true); assert.equal(first.previewPathVerified, true)
      const outputs = first.outputs as { width: number; height: number; durationSeconds: number; frameRate: number }[]
      assert.deepEqual(outputs.map(({ width, height, durationSeconds, frameRate }) => ({ width, height, durationSeconds, frameRate })),
        [{ width: 960, height: 540, durationSeconds: 4.25, frameRate: 30 }])
      assert.equal((first.counts as { quoteApprovals: number }).quoteApprovals, 1)
      assert.equal((first.counts as { uploadApprovals: number }).uploadApprovals, operation === 'image-to-video' ? 1 : 0)
      const before = { ...server.counts }
      const second = await runVideoV2Live(path)
      assert.equal(second.resumed, true)
      assert.equal(second.jobId, first.jobId); assert.equal(second.clientRequestId, first.clientRequestId); assert.equal(second.receiptId, first.receiptId)
      for (const key of ['submits', 'quotes', 'references', 'downloads', 'queries'] as const) assert.equal(server.counts[key], before[key])
      assert.equal(server.counts.submits, 1); assert.equal(server.counts.quotes, 1)
      assert.equal(server.counts.references, operation === 'image-to-video' ? 1 : 0)
      assert.ok(!JSON.stringify(second).includes('private-access-token') && !JSON.stringify(second).includes('private-employment-token'))
      assert.ok(!JSON.stringify(second).includes(server.baseUrl) && !JSON.stringify(second).includes(root))
      assert.deepEqual(server.failures, [])
    } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
  })
}

test('over-cap real-contract quote is never submitted and restart never creates a replacement job', async () => {
  const server = await offlineServer('text-to-video', true)
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-live-cap-unit-'))
  try {
    const path = join(root, 'config.json'), outputRoot = join(root, 'evidence')
    await writeFile(path, JSON.stringify({ ...configInput, baseUrl: server.baseUrl, outputRoot }), { mode: 0o600 })
    await assert.rejects(runVideoV2Live(path), /quote-over-cap-or-expired/)
    await assert.rejects(runVideoV2Live(path), /original-job-not-submitted/)
    assert.equal(server.counts.submits, 0); assert.equal(server.counts.quotes, 1)
    const journal = await readFile(join(outputRoot, 'live-attempt.json'), 'utf8')
    assert.ok(!journal.includes(configInput.accessToken) && !journal.includes(configInput.employmentToken))
    assert.deepEqual(server.failures, [])
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('budget interruption after corrupt download preserves the original job for retrySave on restart', async () => {
  const server = await offlineServer('text-to-video', false, true)
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-live-corrupt-unit-'))
  try {
    const path = join(root, 'config.json'), outputRoot = join(root, 'evidence')
    const config = { ...configInput, baseUrl: server.baseUrl, outputRoot, budgetMs: 1000 }
    await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    await assert.rejects(runVideoV2Live(path))
    assert.equal(server.counts.submits, 1); assert.equal(server.counts.downloads, 1)
    // A new invocation can have a fresh budget, but cannot change the paid identity.
    await writeFile(path, JSON.stringify({ ...config, budgetMs: 15_000 }), { mode: 0o600 })
    const recovered = await runVideoV2Live(path)
    assert.equal(recovered.resumed, true); assert.equal(recovered.saveStatus, 'SAVED')
    assert.equal(server.counts.submits, 1); assert.equal(server.counts.quotes, 1); assert.equal(server.counts.downloads, 2)
    assert.equal((recovered.counts as { quoteApprovals: number }).quoteApprovals, 0)
    assert.deepEqual(server.failures, [])
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('existing attempt without a published job fails closed before any I/O, even after an earlier failure', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-live-nojob-unit-'))
  try {
    const path = join(root, 'config.json'), outputRoot = join(root, 'evidence')
    // Closed loopback port: no paid request can be sent by this test.
    await writeFile(path, JSON.stringify({ ...configInput, baseUrl: 'http://127.0.0.1:1/api', outputRoot }), { mode: 0o600 })
    await assert.rejects(runVideoV2Live(path))
    await assert.rejects(runVideoV2Live(path), /attempt-without-job-no-resubmit/)
    await writeFile(join(outputRoot, 'live-runner.lock'), 'stale-lock\n', { mode: 0o600 })
    await assert.rejects(runVideoV2Live(path), { code: 'EEXIST' })
    assert.equal(await readFile(join(outputRoot, 'live-runner.lock'), 'utf8'), 'stale-lock\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})
