import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import { MediaStore } from '../electron/data/media-store'
import { SkillVersionStore } from '../electron/data/skill-version-store'
import { SepMediaGateway, SepMediaGatewayError } from '../electron/data/sep-media-gateway'
import { MediaService } from '../electron/service/media-service'
import { EmployeeAuthorizer } from '../electron/service/employee-authorizer'
import { EmployeeDirectory } from '../electron/service/employee-directory'
import { SkillStore } from '../electron/pi/sdk/pi-skill-packages'
import { AuthApiError, getEmployeeRuntime, getEmployeeSkills, getSubscriptions } from '../electron/common/platform/platform-api'
import { config } from '../electron/common/config'
import type { MediaGenerationInput, MediaJobView } from '../src/shared/media'

// Invoked by SEP's isolated PostgreSQL/Nest test, never by the production client.
const baseUrl = process.env.SEP_MEDIA_TEST_URL!
const token = process.env.SEP_MEDIA_TEST_TOKEN!
const accessToken = process.env.SEP_MEDIA_TEST_ACCESS_TOKEN!
const employeeId = process.env.SEP_MEDIA_TEST_EMPLOYEE!
const foreignToken = process.env.SEP_MEDIA_TEST_FOREIGN_TOKEN!
const subscriptionId = process.env.SEP_MEDIA_TEST_SUBSCRIPTION!
const owner = { enterpriseId: process.env.SEP_MEDIA_TEST_ENTERPRISE!, memberId: process.env.SEP_MEDIA_TEST_MEMBER! }
assert.ok(baseUrl && token && accessToken && employeeId && foreignToken && subscriptionId && owner.enterpriseId && owner.memberId, 'Missing isolated integration configuration')
// config reads env on module load. SEP injects this before spawning us, not after imports.
assert.equal(config.SEP_BASE_URL, baseUrl)
assert.ok(baseUrl.endsWith('/api'))
assert.notEqual(accessToken, token, 'Ordinary access and employment tokens must be distinct')
const services: MediaService[] = []
const metrics = { submits: 0, quotes: 0, downloads: 0 }
const employeeMetrics = { runtime: 0, metadata: 0, artifacts: 0, previews: 0 }
const networkFetch = globalThis.fetch
let revokeOnArtifact = false
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url))
  if (target.pathname.endsWith('/runtime') || target.pathname.endsWith('/skills') || target.pathname.endsWith('/artifact')) {
    assert.equal(target.origin, new URL(baseUrl).origin)
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${accessToken}`)
  }
  if (target.pathname.endsWith('/runtime')) {
    employeeMetrics.runtime++
    assert.equal(target.searchParams.get('skillArtifactProtocolVersion'), '1')
  }
  if (target.pathname.endsWith('/skills')) employeeMetrics.metadata++
  if (target.pathname.endsWith('/artifact')) {
    employeeMetrics.artifacts++
    if (revokeOnArtifact) {
      revokeOnArtifact = false
      await fixtureState('revoked')
    }
  }
  if (target.pathname.endsWith('/preview')) employeeMetrics.previews++
  return networkFetch(url, init)
}
async function fixtureState(state: 'v1' | 'v2' | 'blocked' | 'revoked') {
  const response = await networkFetch(`${baseUrl}/__media-integration/fixture/${state}`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
  })
  assert.equal(response.status, 201)
}
let loseSubmitResponse = false, failDownload = false, unavailableSubmitResponse = false, denyDownload = false
const http: typeof fetch = async (url, init) => {
  const pathname = new URL(String(url)).pathname
  if (init?.method === 'POST' && pathname.endsWith('/requests')) metrics.submits++
  if (init?.method === 'POST' && pathname.endsWith('/quotes')) metrics.quotes++
  const response = await fetch(url, init)
  if (init?.method === 'POST' && pathname.endsWith('/requests') && loseSubmitResponse) {
    loseSubmitResponse = false
    await response.body?.cancel()
    throw new Error('Injected lost response after server acceptance')
  }
  if (init?.method === 'POST' && pathname.endsWith('/requests') && unavailableSubmitResponse) {
    unavailableSubmitResponse = false
    await response.body?.cancel()
    return new Response(JSON.stringify({ error: { code: 'MEDIA_STORAGE_UNAVAILABLE', message: 'Injected acknowledgement failure' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } })
  }
  if (pathname.endsWith('/content')) {
    metrics.downloads++
    if (denyDownload) {
      denyDownload = false
      await response.body?.cancel()
      return new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'Injected authentication expiry' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } })
    }
    if (failDownload) {
      failDownload = false
      await response.body?.cancel()
      return new Response('{"error":"not an image"}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  }
  return response
}
const gateway = new SepMediaGateway({ baseUrl, token: async () => token, fetch: http })
const signal = new AbortController().signal
const profiles = await gateway.profiles(subscriptionId, signal)
assert.equal(profiles.persistence, 'database')
const png = Buffer.from(profiles.referenceFixtureBase64, 'base64')
assert.equal(createHash('sha256').update(png).digest('hex'), profiles.referenceFixtureSha256)
const capabilities = profiles.capabilities
const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-media-two-repos-'))
const root = join(directory, 'user-data')

function client() {
  // Synthetic session, real directory/authorizer/installer/API. No real login or model calls.
  const versions = new SkillVersionStore(join(root, 'skill-versions'))
  const skills = new SkillStore(join(root, 'installed-skills'), versions)
  const authorizer = new EmployeeAuthorizer({ getValidAccessToken: async () => accessToken, getMeta: () => owner },
    new EmployeeDirectory(getSubscriptions), skills, 'mock://no-model', { getRuntime: getEmployeeRuntime })
  const store = new MediaStore(root)
  const service = new MediaService({ scope: { currentScope: () => owner }, store, gateway,
    // Only this explicit fixture injection enables execution. Production runtime stays false.
    capabilities: () => capabilities, getTask: async () => ({ subscriptionId }), authorize: id => authorizer.authorize(id),
    requestApproval: async () => true, pollFloorMs: 1, maxAttempts: 3, operationTimeoutMs: 5000 })
  services.push(service)
  return { store, service, authorizer, skills, versions }
}
async function settle(service: MediaService, taskId: string, jobId: string): Promise<MediaJobView> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const job = (await service.getTaskMedia(taskId)).jobs.find(item => item.jobId === jobId)!
    if (job.trackingStatus !== 'ACTIVE') return job
    await delay(10)
  }
  throw new Error('Mock integration job did not settle')
}
function input(profileId: string, count = 1): MediaGenerationInput {
  return { profileId, operation: 'generate', localAssetIds: [], creativeBrief: 'Static PNG integration only', parameters: { aspectRatio: '1:1', size: '1x1', count } }
}
async function generate(service: MediaService, profileId: string, count = 1) {
  const taskId = `task-${profileId}`
  const job = await service.generateTaskMedia(taskId, input(profileId, count))
  return settle(service, taskId, job.jobId)
}

try {
  const initial = client()
  const { skills, versions } = initial
  let { service, store, authorizer } = initial
  const manifest = await getEmployeeRuntime(subscriptionId, accessToken)
  assert.equal(manifest.runtime.skillArtifactProtocolVersion, 1)
  assert.equal('skillArtifactProtocolVersion' in manifest, false)
  assert.equal((manifest.runtime.media as { executionAvailable: boolean }).executionAvailable, false)
  const metadata = await getEmployeeSkills(employeeId, accessToken)
  assert.equal(metadata.subscriptionId, subscriptionId)
  const approved = manifest.runtime.skills[0]
  const artifact = approved.artifact!
  assert.equal(artifact.status, 'AVAILABLE')
  if (artifact.status !== 'AVAILABLE') assert.fail('Fixture artifact must be installable')
  assert.equal(artifact.protocolVersion, 1)
  assert.equal(artifact.capabilityId, approved.capabilityId)
  assert.equal(artifact.versionId, approved.versionId)
  assert.equal(artifact.format, 'single-file')
  assert.equal(artifact.entryPath, 'SKILL.md')
  assert.equal(artifact.fileCount, 1)
  assert.ok(artifact.installationDirectory)
  assert.equal(artifact.approvedContentSha256, createHash('sha256').update(approved.content).digest('hex'))
  assert.notEqual(artifact.artifactSha256, artifact.approvedContentSha256)
  for (const path of [`/client/subscriptions/${subscriptionId}/runtime`, `/enterprise/employees/${employeeId}/skills`, artifact.downloadPath]) {
    for (const credential of [token, 'invalid-synthetic-access']) {
      const response = await networkFetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${credential}` } })
      assert.equal(response.status, 401, 'Employee APIs accept only the synthetic ordinary token')
      await response.body?.cancel()
    }
  }
  const ordinaryMedia = await networkFetch(`${baseUrl}/gateway/v1/media/profiles`, { headers: { Authorization: `Bearer ${accessToken}` } })
  assert.equal(ordinaryMedia.status, 401, 'Media APIs require employment, not ordinary access')
  await ordinaryMedia.body?.cancel()

  const employee = await authorizer.authorize(subscriptionId)
  assert.ok(employee?.runtimeSnapshot)
  const frozenEmployee = JSON.stringify(employee.runtimeSnapshot)
  const installed = employee.runtimeSnapshot.skills[0]
  assert.equal(await versions.selected(owner, subscriptionId, installed.capabilityId), installed.versionId)
  const oldEntry = await readFile(join(installed.path, 'SKILL.md'))
  assert.equal(createHash('sha256').update(oldEntry).digest('hex'), artifact.entrySha256)
  assert.equal(oldEntry.length, artifact.byteLength)
  assert.deepEqual(installed.artifact, artifact)
  assert.equal(installed.content, oldEntry.toString('utf8'))
  assert.notEqual(installed.content, approved.content, 'Installed entry must use server-generated artifact bytes')
  const toolTaskId = 'task-employee-tools', toolRunId = 'run-employee-v1'
  const tools = await service.prepareRun({ taskId: toolTaskId, runId: toolRunId, subscriptionId, employee, requestApproval: async () => true })
  assert.ok(tools)
  assert.ok(tools.names.includes('media_generate_image'))
  const toolCapabilities = await tools.execute('media_get_capabilities', {}, signal)
  assert.ok(toolCapabilities)
  await tools.execute('media_generate_image', input('mock-sync'), signal)
  await service.waitForRun(toolTaskId, toolRunId)
  const [toolJob] = (await service.getTaskMedia(toolTaskId)).jobs
  assert.equal(toolJob.runId, toolRunId)
  assert.equal(toolJob.saveStatus, 'SAVED')
  assert.deepEqual(await store.readAsset(owner, toolTaskId, toolJob.assets[0].localAssetId), png)
  const persisted = await store.getSnapshot(owner, toolTaskId, toolRunId)
  assert.ok(persisted?.runtimeSnapshot)
  assert.deepEqual(persisted.runtimeSnapshot, employee.runtimeSnapshot)
  assert.equal(persisted.skills[0].sha256, artifact.entrySha256)
  assert.equal(persisted.skills[0].path, installed.path)

  await fixtureState('v2')
  const nextEmployee = await authorizer.authorize(subscriptionId)
  assert.ok(nextEmployee?.runtimeSnapshot)
  const nextSkill = nextEmployee.runtimeSnapshot.skills[0]
  assert.equal(nextSkill.capabilityId, installed.capabilityId)
  assert.notEqual(nextSkill.baseSkillVersionId, installed.baseSkillVersionId)
  assert.notEqual(nextSkill.path, installed.path)
  assert.notEqual(nextSkill.sha256, installed.sha256)
  assert.equal(await versions.selected(owner, subscriptionId, nextSkill.capabilityId), nextSkill.versionId)
  assert.deepEqual(await readFile(join(installed.path, 'SKILL.md')), oldEntry)
  assert.equal(JSON.stringify(employee.runtimeSnapshot), frozenEmployee)
  assert.deepEqual((await store.getSnapshot(owner, toolTaskId, toolRunId))?.runtimeSnapshot, employee.runtimeSnapshot)
  await service.prepareRun({ taskId: toolTaskId, runId: 'run-employee-v2', subscriptionId, employee: nextEmployee, requestApproval: async () => true })
  assert.deepEqual((await store.getSnapshot(owner, toolTaskId, 'run-employee-v2'))?.runtimeSnapshot, nextEmployee.runtimeSnapshot)
  const staleArtifact = await networkFetch(`${baseUrl}${artifact.downloadPath}`, { headers: { Authorization: `Bearer ${accessToken}` } })
  assert.equal(staleArtifact.status, 404)
  await staleArtifact.body?.cancel()
  const beforeDenied = { ...metrics }, beforeBlockedArtifacts = employeeMetrics.artifacts
  await fixtureState('blocked')
  const blockedManifest = await getEmployeeRuntime(subscriptionId, accessToken)
  assert.equal(blockedManifest.runtime.skills[0].artifact?.status, 'BLOCKED')
  assert.equal(blockedManifest.runtime.skills[0].content.includes('references/image.md'), true)
  await assert.rejects(authorizer.authorize(subscriptionId), /Employee runtime skill artifact is unavailable or mismatched/)
  await assert.rejects(service.generateTaskMedia('task-blocked', input('mock-sync')), /Employee runtime skill artifact is unavailable or mismatched/)
  await assert.rejects(skills.prepare({ ...owner, subscriptionId, employeeId, accessToken,
    skillArtifactProtocolVersion: 1, runtimeSkills: blockedManifest.runtime.skills }), /BLOCKED/)
  assert.equal(employeeMetrics.artifacts, beforeBlockedArtifacts, 'BLOCKED must not attempt download or fallback to old content')
  assert.equal(await store.getSnapshot(owner, 'task-blocked'), null)
  await fixtureState('v2')
  revokeOnArtifact = true
  await assert.rejects(authorizer.authorize(subscriptionId), error => error instanceof AuthApiError && error.statusCode === 404)
  await assert.rejects(service.generateTaskMedia('task-revoked', input('mock-sync')), error => error instanceof AuthApiError && error.statusCode === 404)
  assert.equal(await store.getSnapshot(owner, 'task-revoked'), null)
  assert.deepEqual(metrics, beforeDenied, 'BLOCKED/revoked preparation cannot quote, submit or save stale content')
  assert.deepEqual(await readFile(join(installed.path, 'SKILL.md')), oldEntry)
  await fixtureState('v2')

  const sync = await generate(service, 'mock-sync', 2)
  assert.equal(sync.generationStatus, 'SUCCEEDED')
  assert.equal(sync.saveStatus, 'SAVED')
  assert.equal(sync.billingStatus, 'MOCK_NOT_CHARGED')
  for (const asset of sync.assets) assert.deepEqual(await store.readAsset(owner, sync.taskId, asset.localAssetId), png)

  const source = join(directory, 'reference.png')
  await writeFile(source, png)
  const [reference] = await service.importReferences('task-edit', [source])
  const edit = await service.generateTaskMedia('task-edit', { ...input('mock-sync'), operation: 'edit', localAssetIds: [reference.localAssetId] })
  assert.equal((await settle(service, 'task-edit', edit.jobId)).saveStatus, 'SAVED')

  const asyncJob = await generate(service, 'mock-async')
  assert.equal(asyncJob.generationStatus, 'SUCCEEDED')
  assert.equal(asyncJob.saveStatus, 'SAVED')
  const partial = await generate(service, 'mock-partial', 2)
  assert.equal(partial.generationStatus, 'PARTIAL_SUCCEEDED')
  assert.equal(partial.assets.length, 1)
  assert.equal((await store.getJob(owner, partial.taskId, partial.jobId))?.outputErrors?.[0].code, 'OUTPUT_FAILED')
  assert.equal((await generate(service, 'mock-failed')).generationStatus, 'FAILED')
  const unknown = await generate(service, 'mock-unknown')
  assert.equal(unknown.generationStatus, 'SUBMISSION_UNKNOWN')
  assert.equal(unknown.canResumeTracking, false)
  await assert.rejects(service.redo(unknown.taskId, unknown.jobId))
  const expired = await generate(service, 'mock-expired')
  assert.equal(expired.generationStatus, 'RESULT_EXPIRED')
  assert.equal(expired.canRetrySave, false)
  const noPriceSubmits = metrics.submits
  await assert.rejects(generate(service, 'mock-no-price'))
  assert.equal(metrics.submits, noPriceSubmits)

  const retryTask = 'task-download-retry'
  failDownload = true
  const retry = await service.generateTaskMedia(retryTask, input('mock-sync'))
  assert.equal((await settle(service, retryTask, retry.jobId)).saveStatus, 'SAVE_FAILED')
  const beforeRetry = { ...metrics }
  await service.retrySave(retryTask, retry.jobId)
  assert.equal((await settle(service, retryTask, retry.jobId)).saveStatus, 'SAVED')
  assert.equal(metrics.submits, beforeRetry.submits)
  assert.equal(metrics.quotes, beforeRetry.quotes)
  assert.equal(metrics.downloads, beforeRetry.downloads + 1)

  loseSubmitResponse = true
  const beforeLost = metrics.submits
  const recovered = await generate(service, 'mock-sync')
  assert.equal(recovered.saveStatus, 'SAVED')
  assert.equal(metrics.submits, beforeLost + 1)

  unavailableSubmitResponse = true
  const before503 = metrics.submits
  assert.equal((await generate(service, 'mock-sync')).saveStatus, 'SAVED')
  assert.equal(metrics.submits, before503 + 1)

  denyDownload = true
  const beforeAuth = { ...metrics }
  const authJob = await generate(service, 'mock-sync', 2)
  assert.equal(authJob.trackingStatus, 'AUTH_REQUIRED')
  assert.equal(authJob.saveStatus, 'SAVE_FAILED')
  assert.equal(metrics.downloads, beforeAuth.downloads + 1)
  await service.retrySave(authJob.taskId, authJob.jobId)
  assert.equal((await settle(service, authJob.taskId, authJob.jobId)).saveStatus, 'SAVED')
  assert.equal(metrics.submits, beforeAuth.submits + 1)
  assert.equal(metrics.quotes, beforeAuth.quotes + 1)

  const cancelTask = 'task-cancel'
  const cancelled = await service.generateTaskMedia(cancelTask, input('mock-async'))
  await service.cancel(cancelTask, cancelled.jobId, true)
  assert.equal((await store.getJob(owner, cancelTask, cancelled.jobId))?.generationStatus, 'CANCELLED')

  const syncRecord = (await store.getJob(owner, sync.taskId, sync.jobId))!
  const foreign = new SepMediaGateway({ baseUrl, token: async () => foreignToken })
  const scopeRejected = (error: unknown) => error instanceof SepMediaGatewayError &&
    error.statusCode === 404 && error.gatewayCode === 'MEDIA_NOT_FOUND'
  assert.equal((await gateway.getReceipt(subscriptionId, syncRecord.receiptId!, signal)).clientRequestId, syncRecord.clientRequestId)
  const ownerChunks: Uint8Array[] = []
  for await (const chunk of await gateway.content(subscriptionId, syncRecord.receiptId!, sync.assets[0].outputId!, signal)) ownerChunks.push(chunk)
  assert.deepEqual(Buffer.concat(ownerChunks), png)
  await assert.rejects(foreign.getReceipt(subscriptionId, syncRecord.receiptId!, signal), scopeRejected)
  await assert.rejects(foreign.content(subscriptionId, syncRecord.receiptId!, sync.assets[0].outputId!, signal), scopeRejected)

  const restartingTask = 'task-restarting'
  const pending = await service.generateTaskMedia(restartingTask, input('mock-async'))
  await service.stopAll()
  const original = (await store.getJob(owner, restartingTask, pending.jobId))!
  assert.equal(original.trackingStatus, 'INTERRUPTED')
  const beforeRestart = metrics.submits
  process.stdout.write('SEP_MEDIA_RESTART_READY\n')
  const lines = createInterface({ input: process.stdin })
  await new Promise<void>(resolve => { lines.once('line', () => resolve()); })
  lines.close()
  ;({ service, store, authorizer } = client())
  const reconstructed = await authorizer.authorize(subscriptionId)
  assert.ok(reconstructed?.runtimeSnapshot)
  assert.equal(reconstructed.runtimeSnapshot.skills[0].path, nextSkill.path)
  assert.deepEqual((await store.getSnapshot(owner, toolTaskId, toolRunId))?.runtimeSnapshot, employee.runtimeSnapshot)
  assert.deepEqual(await readFile(join(installed.path, 'SKILL.md')), oldEntry)
  const restored = (await store.getJob(owner, restartingTask, pending.jobId))!
  assert.equal(restored.clientRequestId, original.clientRequestId)
  const receipt = await gateway.findReceipt(subscriptionId, original.clientRequestId, signal)
  assert.ok(receipt)
  await service.resumePending()
  assert.equal((await settle(service, restartingTask, pending.jobId)).saveStatus, 'SAVED')
  assert.equal(metrics.submits, beforeRestart)
  assert.equal((await store.getJob(owner, restartingTask, pending.jobId))?.receiptId, original.receiptId)
  assert.deepEqual(await store.readAsset(owner, sync.taskId, sync.assets[0].localAssetId), png)
  const exported = join(directory, 'export.png')
  await store.exportAsset(owner, sync.taskId, sync.assets[0].localAssetId, exported)
  assert.deepEqual(await readFile(exported), png)
  assert.ok(employeeMetrics.artifacts > 10)
  assert.ok(employeeMetrics.runtime > 10)
  assert.ok(employeeMetrics.metadata > 10)
  assert.equal(employeeMetrics.previews, 0, 'Approved artifact path must never fallback to preview')
  process.stdout.write(`SEP_MEDIA_INTEGRATION_PASSED ${JSON.stringify({ ...metrics, employee: employeeMetrics, authentication: 'synthetic-no-real-login' })}\n`)
} finally {
  try { await Promise.all(services.map(service => service.stopAll())) }
  finally {
    globalThis.fetch = networkFetch
    await rm(directory, { recursive: true, force: true })
  }
}
