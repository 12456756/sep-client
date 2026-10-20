import * as assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import * as fixture from '../src/shared/fixtures/media-video-v1.json'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../electron/common/platform/sep-media-gateway-contract'
import { videoRuntimeSchema, type VideoRequest } from '../src/shared/video-media'
import { formatVideoV2Failure, runVideoV2Http } from './test-video-v2-http'

test('V2 debug details require explicit isolated opt-in and redact credentials', () => {
  const base = 'http://127.0.0.1:3000/api'
  const env = { SEP_VIDEO_V2_TEST_BASE_URL: base, SEP_BASE_URL: base }
  const error = new assert.AssertionError({ message: 'Synthetic duration mismatch; Bearer synthetic-token; key sk-synthetic-key' })
  const generic = 'V2 isolated video HTTP acceptance failed.\n'
  assert.equal(formatVideoV2Failure(error, env), generic)
  assert.equal(formatVideoV2Failure(error, { ...env, SEP_VIDEO_V2_TEST_DEBUG: '1' }), generic)
  assert.equal(formatVideoV2Failure(error, { ...env, SEP_VIDEO_V2_TEST_DEBUG: 'true', SEP_BASE_URL: 'https://example.invalid/api' }), generic)
  const debug = formatVideoV2Failure(error, { ...env, SEP_VIDEO_V2_TEST_DEBUG: 'true' })
  assert.match(debug, /AssertionError/)
  assert.match(debug, /Synthetic duration mismatch/)
  assert.match(debug, /test-video-v2-http\.test\.ts:/)
  assert.ok(!debug.includes('synthetic-token') && !debug.includes('sk-synthetic-key'))
})

test('V2 runner rejects non-loopback, credentials, redirects and mismatched base configuration before network I/O', async () => {
  for (const base of ['https://example.invalid/api', 'http://localhost:3000/api', 'http://127.0.0.1:3000/api/',
    'http://user:password@127.0.0.1:3000/api', 'http://127.0.0.1:3000/api?other=1']) {
    await assert.rejects(runVideoV2Http({ SEP_VIDEO_V2_TEST_BASE_URL: base, SEP_BASE_URL: base }), /isolated loopback API/)
  }
  await assert.rejects(runVideoV2Http({ SEP_VIDEO_V2_TEST_BASE_URL: 'http://127.0.0.1:3000/api', SEP_BASE_URL: 'http://127.0.0.1:3001/api' }), /isolated loopback API/)
  await assert.rejects(runVideoV2Http({ SEP_VIDEO_V2_TEST_BASE_URL: 'http://127.0.0.1:3000/api', SEP_BASE_URL: 'http://127.0.0.1:3000/api', SEP_VIDEO_V2_TEST_OPERATION: 'invalid' }), /Unsupported isolated video operation/)
})

for (const operation of ['text-to-video', 'image-to-video'] as const) {
test(`V2 runner exercises ${operation} real-contract transport and disk recovery on a synthetic loopback server`, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-v2-runner-test-'))
  const bytes = Buffer.from(fixture.mediaFixture.base64, 'base64')
  const file = join(root, 'isolated-video.mp4')
  await writeFile(file, bytes, { mode: 0o600 })
  const profile = { ...fixture.runtime.profiles[0], profileId: 'real-h3', configVersion: 'cfg-real-h3',
    operations: ['text-to-video', 'image-to-video'], capabilities: { ...fixture.runtime.profiles[0].capabilities,
      supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: true,
      durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24] } }
  const activeRuntime = videoRuntimeSchema.parse({ ...fixture.runtime, executionMode: 'real', defaultProfileId: 'real-h3',
    tools: ['video_generate', 'video_from_image', 'video_get_job'], profiles: [profile] })
  const output = { ...fixture.output, width: 1344, height: 768, durationSeconds: 4.459, frameRate: 24,
    expiresAt: new Date(Date.now() + 600_000).toISOString() }
  let granted = true, query = 0, submitted: VideoRequest | undefined
  const counts = { submit: 0, quote: 0, content: 0, revoke: 0, restore: 0, reference: 0 }
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers['x-test-auth'], 'yes')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const url = new URL(req.url!, 'http://127.0.0.1')
      const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      if (url.pathname === '/api/__test/video/runtime') return json(granted ? activeRuntime : { ...activeRuntime, executionAvailable: false, tools: [] })
      if (url.pathname === '/api/__test/video/revoke') { granted = false; counts.revoke++; return json({ ok: true }) }
      if (url.pathname === '/api/__test/video/restore') { granted = true; counts.restore++; return json({ ok: true }) }
      assert.ok(url.pathname.startsWith('/api/gateway/v1/media/video-real/'))
      if (!granted) return json({}, 403)
      if (url.pathname.endsWith('/profiles')) return json({ mock: false, protocolVersion: 1, persistence: 'database', billingStatus: 'NOT_RESERVED', profiles: [profile] })
      if (url.pathname.endsWith('/references')) {
        counts.reference++
        const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
        assert.ok(body.includes(png))
        return json({ mock: false, referenceId: 'ref-real', mimeType: 'image/png', byteLength: png.length,
          sha256: createHash('sha256').update(png).digest('hex'), width: 1, height: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })
      }
      if (url.pathname.endsWith('/quotes')) {
        counts.quote++
        const semantic = JSON.parse(body.toString()) as VideoRequest
        assert.equal(semantic.operation, operation)
        assert.deepEqual(semantic.referenceIds, operation === 'image-to-video' ? ['ref-real'] : [])
        return json({ mock: false, quoteId: 'quote-real', expiresAt: new Date(Date.now() + 60_000).toISOString(), semanticSha256: 'a'.repeat(64),
          pricingStatus: 'quoted', amountCny: '0.900000', amountUsd: '0.12', pricingVersion: 'real-pricing', usdToCnyRate: 7.5,
          funding: { creditCny: '0.900000', memberWalletCny: '0.000000', personalCny: '0.000000' }, billingStatus: 'NOT_RESERVED' })
      }
      const receipt = () => {
        assert.ok(submitted)
        const succeeded = query >= 2
        const billingStatus = query >= 4 ? 'SETTLED' : query >= 3 ? 'RECONCILING' : 'RESERVED'
        return { mock: false, receiptId: 'receipt-real', clientRequestId: submitted.clientRequestId, profileId: submitted.profileId,
          configVersion: submitted.configVersion, operation: submitted.operation, status: succeeded ? 'SUCCEEDED' : query === 1 ? 'RUNNING' : 'QUEUED',
          pollAfterMs: succeeded ? null : 1, outputs: succeeded ? [output] : [], billingStatus, amountCny: '0.900000', amountUsd: '0.12',
          ...(billingStatus === 'SETTLED' ? { actualCostCny: '0.800000' } : {}), errorCode: null,
          recovery: { canQuery: billingStatus !== 'SETTLED', canCancel: false, canDownload: succeeded } }
      }
      if (url.pathname.endsWith('/requests') && req.method === 'POST') {
        counts.submit++; assert.equal(counts.submit, 1)
        submitted = JSON.parse(body.toString()) as VideoRequest
        assert.equal(submitted.operation, operation)
        assert.deepEqual(submitted.referenceIds, operation === 'image-to-video' ? ['ref-real'] : [])
        return json(receipt(), 202)
      }
      if (url.pathname.endsWith('/content')) {
        counts.content++
        res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', bytes.length); res.setHeader('X-SHA256', fixture.output.sha256)
        return res.end(bytes)
      }
      if (url.pathname.includes('/by-client-id/')) {
        assert.ok(submitted); assert.ok(url.pathname.endsWith(`/${submitted.clientRequestId}`))
        return json(receipt())
      }
      assert.ok(url.pathname.endsWith('/requests/receipt-real'))
      query++
      return json(receipt())
    })().catch(() => { res.statusCode = 500; res.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api`
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { runVideoV2Http } from './scripts/test-video-v2-http.ts'; process.stdout.write(JSON.stringify(await runVideoV2Http()) + '\\n');`], {
      cwd: new URL('..', import.meta.url), timeout: 30_000,
      env: { ...process.env, SEP_VIDEO_V2_TEST_BASE_URL: base, SEP_BASE_URL: base, SEP_VIDEO_V2_TEST_OUTPUT_FILE: file, SEP_VIDEO_V2_TEST_OPERATION: operation },
    })
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
    assert.equal(result.mock, false); assert.equal(result.realModels, false); assert.equal(result.realBilling, false)
    assert.equal(result.syntheticScope, true); assert.equal(result.originalReceiptRestored, true)
    assert.equal(result.saveStatus, 'SAVED'); assert.equal(result.billingStatus, 'SETTLED')
    assert.equal(result.width, 1344); assert.equal(result.height, 768); assert.equal(result.durationSeconds, 4.459)
    assert.equal(result.operation, operation); assert.equal(result.sameTaskSaved, true)
    assert.equal(result.referenceUploadApproved, operation === 'image-to-video')
    assert.equal(result.counts.submit, 1); assert.equal(result.counts.quote, 1)
    assert.equal(result.counts.approvals, operation === 'image-to-video' ? 2 : 1)
    assert.equal(result.counts.corruptedDownloads, 1); assert.equal(result.counts.lostSubmitResponses, 1)
    assert.equal(result.counts.opened, 1)
    assert.deepEqual(counts, { submit: 1, quote: 1, content: 2, revoke: 1, restore: 1, reference: 1 })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
}
