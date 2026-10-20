/** Isolated cross-repository real-contract acceptance. Never targets a model/provider endpoint. */
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { videoBillingPending, videoReferenceSchema, videoRuntimeSchema } from '../src/shared/video-media'
import type { VideoJobView } from '../src/shared/video-host'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../electron/common/platform/sep-media-gateway-contract'
import { SepRealVideoGateway } from '../electron/data/sep-video-media-gateway'
import { VideoStore } from '../electron/data/video-store'
import { MAX_VIDEO_BYTES } from '../electron/data/video-files'
import { MockVideoHostService } from '../electron/service/mock-video-host-service'
import { redactText } from '../electron/common/redact'

function isolatedBase(env: NodeJS.ProcessEnv): URL {
  const base = new URL(env.SEP_VIDEO_V2_TEST_BASE_URL ?? '')
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.pathname !== '/api' ||
    base.username || base.password || base.search || base.hash || env.SEP_BASE_URL !== base.href) {
    throw new Error('V2 acceptance requires an explicitly configured isolated loopback API.')
  }
  return base
}

export function formatVideoV2Failure(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const message = 'V2 isolated video HTTP acceptance failed.\n'
  if (env.SEP_VIDEO_V2_TEST_DEBUG !== 'true') return message
  try { isolatedBase(env) } catch { return message }
  const detail = error instanceof Error ? error.stack ?? error.message : 'Unknown isolated runner error.'
  return message + redactText(detail.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]'), 16_384) + '\n'
}

export async function runVideoV2Http(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const base = isolatedBase(env)
  const operation = env.SEP_VIDEO_V2_TEST_OPERATION ?? 'text-to-video'
  assert.ok(operation === 'text-to-video' || operation === 'image-to-video', 'Unsupported isolated video operation.')
  const fromImage = operation === 'image-to-video'
  const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
  const pngSha256 = createHash('sha256').update(png).digest('hex')
  let referenceApproved = false, referenceRead = false, uploadedReferenceId: string | undefined
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-v2-http-'))
  const nativeFetch = globalThis.fetch
  const counts = { profiles: 0, references: 0, quote: 0, submit: 0, findReceipt: 0, query: 0, content: 0,
    runtime: 0, approvals: 0, revoke: 0, restore: 0, corruptedDownloads: 0, lostSubmitResponses: 0, opened: 0 }
  let dropSubmitResponse = true, corruptDownload = true, revision = 0
  const owner = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
  const scope = { ...owner, subscriptionId: 'sub-1' }
  const taskId = 'task-v2-real'
  const parameters = { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' as const, frameRate: 24, audio: true, outputFormat: 'video/mp4' as const }
  const hosts: MockVideoHostService[] = []

  // Block every origin and route outside this fixture, including redirects. Real
  // keys are never consulted; the SEP fixture installs its synthetic auth guard.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.origin, base.origin, 'External I/O is forbidden in V2 acceptance.')
    assert.ok(!url.username && !url.password)
    assert.ok(url.pathname.startsWith('/api/gateway/v1/media/video-real/') ||
      /^\/api\/__test\/video\/(runtime|revoke|restore)$/.test(url.pathname), 'Only isolated video test routes are allowed.')
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('x-test-auth', 'yes')
    if (url.pathname.endsWith('/runtime')) counts.runtime++
    if (url.pathname.endsWith('/profiles')) counts.profiles++
    if (url.pathname.endsWith('/references')) counts.references++
    if (url.pathname.endsWith('/quotes')) counts.quote++
    if (url.pathname.includes('/by-client-id/')) counts.findReceipt++
    else if (/\/requests\/[^/]+$/.test(url.pathname) && method === 'GET') counts.query++
    if (url.pathname.endsWith('/content')) counts.content++
    if (url.pathname.endsWith('/revoke')) counts.revoke++
    if (url.pathname.endsWith('/restore')) counts.restore++
    const submitting = url.pathname.endsWith('/requests') && method === 'POST'
    if (submitting) counts.submit++
    const response = await nativeFetch(input, { ...init, headers, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10_000)]) })
    if (url.pathname.endsWith('/references') && response.ok) {
      const reference = videoReferenceSchema.parse(await response.clone().json())
      assert.equal(reference.mock, false); assert.equal(reference.byteLength, png.length)
      assert.equal(reference.sha256, pngSha256)
      assert.equal(reference.width, 1); assert.equal(reference.height, 1)
      uploadedReferenceId = reference.referenceId
      assert.equal(typeof uploadedReferenceId, 'string')
    }
    if (submitting && response.ok && dropSubmitResponse) {
      dropSubmitResponse = false
      counts.lostSubmitResponses++
      await response.body?.cancel()
      throw new Error('Isolated lost submit response.')
    }
    if (url.pathname.endsWith('/content') && response.ok && corruptDownload) {
      assert.ok(response.body)
      corruptDownload = false
      counts.corruptedDownloads++
      let changed = false
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const bytes = new Uint8Array(chunk)
          if (!changed && bytes.byteLength) { bytes[0] ^= 0xff; changed = true }
          controller.enqueue(bytes)
        },
      }))
      return new Response(body, { status: response.status, headers: response.headers })
    }
    return response
  }

  const makeHost = () => {
    // Reconstruct the actual disk store and HTTP adapter on every host restart.
    const store = new VideoStore(root)
    const gateway = new SepRealVideoGateway({ mock: false, baseUrl: base.href, subscriptionId: scope.subscriptionId,
      token: async () => 'synthetic-video-v2-employment-token' })
    const host = new MockVideoHostService({
      mock: false, scope: { currentScope: () => owner }, store,
      authorizationRevision: () => revision,
      getTask: async id => id === taskId ? { subscriptionId: scope.subscriptionId } : null,
      authorize: async (subscriptionId, signal) => {
        assert.equal(subscriptionId, scope.subscriptionId)
        const response = await fetch(`${base.href}/__test/video/runtime`, { signal })
        assert.equal(response.ok, true)
        const bytes = await response.arrayBuffer()
        assert.ok(bytes.byteLength < 256 * 1024)
        return videoRuntimeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
      },
      gateway: actual => { assert.deepEqual(actual, scope); return gateway },
      readReference: async (actual, id, localAssetId) => {
        assert.ok(fromImage && referenceApproved, 'Local PNG must not be read before upload approval.')
        assert.deepEqual(actual, scope); assert.equal(id, taskId); assert.equal(localAssetId, 'asset-v2-png')
        referenceRead = true
        return { bytes: png, sha256: pngSha256 }
      },
      requestApproval: async approval => {
        counts.approvals++
        assert.equal(approval.taskId, taskId)
        assert.equal(approval.subscriptionId, scope.subscriptionId)
        assert.equal(approval.toolName, fromImage ? 'video_from_image' : 'video_generate')
        if ((approval.input as { operation?: string }).operation === 'upload-references') {
          assert.ok(fromImage && !referenceApproved && !referenceRead)
          assert.equal(counts.references, 0)
          assert.deepEqual(approval.input, { operation: 'upload-references', referenceCount: 1, mock: false })
          referenceApproved = true
          return true
        }
        if (fromImage) assert.ok(referenceApproved && referenceRead && uploadedReferenceId)
        const value = approval.input as { mock: boolean; parameters: unknown; quote: { currency: string; amount: string; expiresAt: number } }
        assert.equal(value.mock, false)
        assert.deepEqual(value.parameters, parameters)
        assert.equal(value.quote.currency, 'CNY')
        assert.match(value.quote.amount, /^\d+\.\d{6}$/)
        assert.ok(Number(value.quote.amount) > 0, 'Synthetic paid-mode quote must not masquerade as free mock.')
        assert.ok(value.quote.expiresAt > Date.now())
        return true
      },
      openOutput: async (actual, id, jobId, outputId, signal, validate) => {
        signal.throwIfAborted(); validate(); assert.deepEqual(actual, scope); assert.equal(id, taskId)
        const path = await store.verifiedAssetPath(actual, id, jobId, outputId)
        assert.ok(path.startsWith(root)); validate(); counts.opened++
      },
    })
    hosts.push(host)
    return { host, store, gateway }
  }

  try {
    let current = makeHost()
    const signal = AbortSignal.timeout(10_000)
    const profiles = await current.gateway.profiles(signal)
    assert.equal(profiles.mock, false); assert.equal(profiles.persistence, 'database')
    assert.equal(profiles.billingStatus, 'NOT_RESERVED')
    const runtime = (await current.host.getTaskVideo(taskId)).runtime
    assert.equal(runtime.executionMode, 'real'); assert.equal(runtime.executionAvailable, true)
    const profile = runtime.profiles.find(item => item.profileId === 'real-h3')
    assert.ok(profile); assert.equal(profile.configVersion, 'cfg-real-h3')
    assert.ok(profiles.profiles.some(item => item.profileId === profile.profileId && item.configVersion === profile.configVersion))
    if (!fromImage) await current.gateway.uploadReference(png, signal)

    const generated = await current.host.generate(taskId, { profileId: profile.profileId, operation,
      localAssetIds: fromImage ? ['asset-v2-png'] : [], creativeBrief: 'Isolated V2 real-contract product video acceptance', parameters })
    assert.equal(generated.generationStatus, 'SUBMISSION_UNKNOWN')
    const [frozen] = await current.store.listJobs(scope)
    assert.ok(frozen); assert.equal(frozen.executionMode, 'real'); assert.equal(frozen.submission, 'MAYBE_SENT')
    assert.equal(frozen.quote.currency, 'CNY'); assert.equal(counts.approvals, fromImage ? 2 : 1)
    assert.equal(frozen.taskId, taskId); assert.equal(frozen.request.operation, operation)
    assert.deepEqual(frozen.request.referenceIds, fromImage ? [uploadedReferenceId] : [])
    await current.host.stopAll()
    current = makeHost()

    const queriesBeforeRevoke = counts.findReceipt + counts.query
    const revoke = await fetch(`${base.href}/__test/video/revoke`, { method: 'POST' })
    assert.equal(revoke.ok, true); await revoke.body?.cancel(); revision++
    await assert.rejects(current.host.resume(taskId, generated.jobId), { code: 'PERMISSION_DENIED' })
    await current.host.track(taskId)
    const paused = await current.store.getJob(scope, taskId, generated.jobId)
    assert.equal(paused?.trackingStatus, 'AUTH_REQUIRED')
    assert.equal(counts.findReceipt + counts.query, queriesBeforeRevoke)
    await current.host.stopAll()
    current = makeHost()
    await current.host.track(taskId)
    assert.equal(counts.findReceipt + counts.query, queriesBeforeRevoke, 'Restart must not auto-resume a revoked grant.')
    const restore = await fetch(`${base.href}/__test/video/restore`, { method: 'POST' })
    assert.equal(restore.ok, true); await restore.body?.cancel(); revision++

    let delivered: VideoJobView | undefined
    for (let attempt = 0; attempt < 12; attempt++) {
      const view = await current.host.resume(taskId, generated.jobId)
      assert.ok(!['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(view.generationStatus), 'Isolated task unexpectedly failed.')
      if (view.generationStatus === 'SUCCEEDED') { delivered = view; break }
    }
    assert.ok(delivered, 'Isolated task did not complete within the bounded query budget.')
    assert.equal(delivered.saveStatus, 'SAVE_FAILED', 'A corrupted download must not publish SAVED.')
    assert.equal(counts.corruptedDownloads, 1)
    assert.deepEqual(await current.store.listAssets(scope, taskId), [])
    const [original] = await current.store.listJobs(scope)
    assert.ok(original?.receipt && !original.receipt.mock)
    const receiptId = original.receipt.receiptId
    assert.equal(original.request.clientRequestId, frozen.request.clientRequestId)
    const metadata = original.receipt.outputs[0]
    assert.ok(metadata); assert.equal(metadata.width, 1344); assert.equal(metadata.height, 768)
    assert.equal(metadata.frameRate, 24); assert.ok(Math.abs(metadata.durationSeconds - 4.458333) <= 0.01)
    assert.equal(original.request.parameters.durationSeconds, 4)

    await current.host.stopAll()
    current = makeHost()
    const repaired = await current.host.retrySave(taskId, generated.jobId)
    assert.equal(repaired.saveStatus, 'SAVED')
    for (let attempt = 0; attempt < 12; attempt++) {
      const view = await current.host.resume(taskId, generated.jobId)
      if (!videoBillingPending(view.billingStatus)) break
    }
    const [saved] = await current.store.listJobs(scope)
    assert.equal(saved?.receipt?.receiptId, receiptId)
    assert.equal(saved.request.clientRequestId, frozen.request.clientRequestId)
    assert.equal(saved.taskId, taskId); assert.equal(saved.request.operation, operation)
    assert.deepEqual(saved.request.referenceIds, frozen.request.referenceIds)
    assert.equal(saved.saveStatus, 'SAVED'); assert.equal(saved.receipt?.billingStatus, 'SETTLED')
    const savedAssets = await current.store.listAssets(scope, taskId)
    assert.equal(savedAssets.length, 1)
    assert.equal(savedAssets[0].taskId, taskId); assert.equal(savedAssets[0].jobId, generated.jobId)
    const savedBytes = await current.store.readAsset(scope, taskId, generated.jobId, metadata.outputId)
    assert.equal(savedBytes.byteLength, metadata.byteLength)
    assert.equal(createHash('sha256').update(savedBytes).digest('hex'), metadata.sha256.toLowerCase())
    if (env.SEP_VIDEO_V2_TEST_OUTPUT_FILE) {
      assert.ok(isAbsolute(env.SEP_VIDEO_V2_TEST_OUTPUT_FILE))
      const handle = await open(env.SEP_VIDEO_V2_TEST_OUTPUT_FILE, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await handle.stat()
        assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_VIDEO_BYTES)
        assert.equal(stat.size, savedBytes.byteLength)
        assert.equal(createHash('sha256').update(await handle.readFile()).digest('hex'), metadata.sha256.toLowerCase())
      } finally { await handle.close() }
    }
    await current.host.stopAll()
    current = makeHost()
    const before = { ...counts }
    const restoredView = await current.host.getTaskVideo(taskId)
    assert.equal(restoredView.mock, false)
    const restored = restoredView.jobs.find(job => job.jobId === generated.jobId)
    assert.equal(restored?.saveStatus, 'SAVED')
    const preview = await current.host.preview(taskId, generated.jobId, metadata.outputId)
    assert.equal(preview.opened, true); assert.equal('bytes' in preview, false)
    assert.equal(counts.content, before.content); assert.equal(counts.query, before.query)
    assert.equal(counts.references, 1); assert.equal(counts.approvals, fromImage ? 2 : 1)
    assert.equal(counts.quote, 1); assert.equal(counts.submit, 1); assert.ok(counts.findReceipt >= 1)
    return { mock: false, realModels: false, realBilling: false, syntheticScope: true, operation,
      referenceUploadApproved: referenceApproved, sameTaskSaved: true,
      profileId: profile.profileId, configVersion: profile.configVersion, saveStatus: 'SAVED', billingStatus: saved.receipt?.billingStatus,
      sha256: metadata.sha256, byteLength: metadata.byteLength, width: metadata.width, height: metadata.height,
      durationSeconds: metadata.durationSeconds, frameRate: metadata.frameRate,
      authorizationRevocation: true, corruptDownloadRejected: true, originalReceiptRestored: true, counts }
  } finally {
    try { await Promise.all(hosts.map(host => host.stopAll())) } finally {
      globalThis.fetch = nativeFetch
      await rm(root, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runVideoV2Http().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    // Stack details require both explicit debug opt-in and isolated loopback configuration.
    process.stderr.write(formatVideoV2Failure(error))
    process.exitCode = 1
  })
}
