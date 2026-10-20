/** Cross-repository V1 acceptance. Only an isolated loopback Nest test may invoke this runner. */
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Subscription } from '../src/shared/types'
import { videoRuntimeSchema } from '../src/shared/video-media'
import { getEmployeeRuntime } from '../electron/common/platform/platform-api'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../electron/common/platform/sep-media-gateway-contract'
import { EmployeeAuthorizer } from '../electron/service/employee-authorizer'
import { EmployeeDirectory } from '../electron/service/employee-directory'
import { MockVideoHostService } from '../electron/service/mock-video-host-service'
import { MediaStore } from '../electron/data/media-store'
import { VideoStore } from '../electron/data/video-store'
import { SepMockVideoGateway } from '../electron/data/sep-video-media-gateway'
import * as fixture from '../src/shared/fixtures/media-video-v1.json'

async function run(): Promise<void> {
  const base = new URL(process.env.SEP_VIDEO_MOCK_TEST_BASE_URL ?? '')
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/api' || base.username || base.password || base.search || base.hash || process.env.SEP_BASE_URL !== base.href) {
    throw new Error('V1 acceptance requires an explicitly configured isolated loopback API.')
  }
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-v1-http-'))
  const nativeFetch = globalThis.fetch
  const counts = { quote: 0, submit: 0, content: 0, runtime: 0, approvals: 0 }
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.origin, base.origin, 'No external requests are allowed in V1 acceptance.')
    if (url.pathname.endsWith('/quotes')) counts.quote++
    if (url.pathname.endsWith('/requests') && init?.method === 'POST') counts.submit++
    if (url.pathname.endsWith('/content')) counts.content++
    if (url.pathname.endsWith('/runtime')) {
      counts.runtime++
      assert.equal(url.searchParams.get('videoProtocolVersion'), '1')
      assert.equal(url.searchParams.get('mediaProtocolVersion'), '1')
      assert.equal(url.searchParams.get('skillArtifactProtocolVersion'), '1')
    }
    const headers = new Headers(init?.headers)
    headers.set('x-test-auth', 'yes')
    return nativeFetch(input, { ...init, headers, redirect: 'error' })
  }
  const owner = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
  const scope = { ...owner, subscriptionId: 'sub-1' }
  const manifest = await getEmployeeRuntime(scope.subscriptionId, 'synthetic-access-token')
  const subscription: Subscription = {
    id: scope.subscriptionId, subscriptionId: scope.subscriptionId, employeeId: manifest.employee.id,
    name: manifest.employee.name, status: 'ACTIVE', templateVersion: manifest.templateVersion,
    template: { id: manifest.employee.id, name: manifest.employee.name, avatar: null },
    allowedModels: [...manifest.runtime.allowedModels], department: null, upgradeAvailable: false,
  }
  const authorizer = new EmployeeAuthorizer({
    getValidAccessToken: async () => 'synthetic-access-token', getMeta: () => owner,
  }, new EmployeeDirectory(async () => [subscription]), {
    prepare: async () => ({ skillPaths: [], skills: [] }), invalidate() {},
  }, `${base.href}/gateway/v1`, { getRuntime: getEmployeeRuntime })
  const gateway = new SepMockVideoGateway({ mock: true, baseUrl: base.href,
    subscriptionId: scope.subscriptionId, token: async () => 'synthetic-video-employment-token' })
  const store = new VideoStore(root)
  const media = new MediaStore(root)
  const selection = join(root, 'selected-reference.png')
  await writeFile(selection, Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64'))
  const reference = await media.importReference(owner, 'task-v1', selection)
  const makeHost = () => new MockVideoHostService({
    mock: true, scope: { currentScope: () => owner }, store,
    getTask: async taskId => taskId === 'task-v1' ? { subscriptionId: scope.subscriptionId } : null,
    authorize: async subscriptionId => (await authorizer.authorize(subscriptionId))?.video,
    authorizationRevision: () => authorizer.getAuthorizationRevision(), gateway: () => gateway,
    readReference: async (_scope, taskId, localAssetId) => {
      const bytes = await media.readAsset(owner, taskId, localAssetId)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
    requestApproval: async approval => {
      counts.approvals++
      assert.equal(approval.subscriptionId, scope.subscriptionId)
      assert.equal(approval.toolName, 'video_from_image')
      return true
    },
  })
  let host = makeHost()
  try {
    const employee = await authorizer.authorize(scope.subscriptionId)
    assert.ok(employee?.runtimeSnapshot)
    assert.deepEqual(employee.runtimeSnapshot.video, employee.video)
    assert.ok(Object.isFrozen(employee.runtimeSnapshot.video))
    const runtime = videoRuntimeSchema.parse(employee.video)
    assert.equal(runtime.executionAvailable, true)
    const profile = runtime.profiles.find(profile => profile.profileId === runtime.defaultProfileId) ?? runtime.profiles[0]!
    const generated = await host.generate('task-v1', {
      profileId: profile.profileId, operation: 'image-to-video', localAssetIds: [reference.localAssetId],
      creativeBrief: 'Isolated V1 product video fixture', parameters: {
        durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4',
      },
    })
    assert.equal(generated.profileId, profile.profileId)
    assert.equal(generated.generationStatus, 'QUEUED')
    const [frozen] = await store.listJobs(scope)
    assert.equal(frozen!.request.configVersion, profile.configVersion)
    assert.equal(counts.approvals, 2)
    await host.resume('task-v1', generated.jobId)
    await host.stopAll()
    host = makeHost()
    const done = await host.resume('task-v1', generated.jobId)
    assert.equal(done.saveStatus, 'SAVED')
    const [original] = await store.listJobs(scope)
    assert.equal(original!.receipt!.receiptId, frozen!.receipt!.receiptId)
    const output = done.outputs[0]!
    const preview = await host.preview('task-v1', generated.jobId, output.outputId)
    assert.ok(preview.bytes)
    assert.equal(createHash('sha256').update(preview.bytes).digest('hex'), fixture.mediaFixture.sha256)
    const safeView = JSON.stringify(await host.getTaskVideo('task-v1'))
    for (const privateField of ['modelId', 'receiptId', 'referenceIds', 'creativeBrief', 'relativePath']) assert.equal(safeView.includes(privateField), false)
    const before = { ...counts }
    for (const action of ['revoke', 'restore'] as const) {
      const response = await fetch(`${base.href}/__test/video/${action}`, { method: 'POST' })
      assert.equal(response.ok, true)
      if (action === 'revoke') {
        await assert.rejects(host.preview('task-v1', generated.jobId, output.outputId))
        await assert.rejects(gateway.getReceipt(original!.receipt!.receiptId, AbortSignal.timeout(10_000)))
      }
    }
    // Observe the restored policy before obtaining a new native/read lease.
    // The authorization revision intentionally rejects leases captured before this observation.
    await authorizer.authorize(scope.subscriptionId)
    await host.preview('task-v1', generated.jobId, output.outputId)
    assert.equal(counts.quote, before.quote)
    assert.equal(counts.submit, before.submit)
    assert.equal(counts.content, before.content)
    assert.equal(counts.submit, 1)
    assert.equal(counts.quote, 1)
    process.stdout.write(JSON.stringify({ mock: true, realModels: false, realBilling: false, syntheticScope: true,
      profileId: profile.profileId, configVersion: profile.configVersion, saveStatus: done.saveStatus,
      sha256: output.sha256, authorizationRevocation: true, originalReceiptRestored: true, counts }) + '\n')
  } finally {
    await host.stopAll()
    globalThis.fetch = nativeFetch
    await rm(root, { recursive: true, force: true })
  }
}
void run().catch(error => { process.stderr.write(`V1 video mock roundtrip failed: ${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1 })
