import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import { MediaStore } from '../electron/data/media-store'
import { SepMediaGateway, SepMediaGatewayError } from '../electron/data/sep-media-gateway'
import { MediaService } from '../electron/service/media-service'
import type { MediaGenerationInput, MediaJobView } from '../src/shared/media'
import type { EmployeeRuntimeConfig } from '../electron/runtime/run-types'

// Invoked by SEP's isolated PostgreSQL/Nest test, never by the production client.
const baseUrl = process.env.SEP_MEDIA_TEST_URL!
const token = process.env.SEP_MEDIA_TEST_TOKEN!
const foreignToken = process.env.SEP_MEDIA_TEST_FOREIGN_TOKEN!
const subscriptionId = process.env.SEP_MEDIA_TEST_SUBSCRIPTION!
const owner = { enterpriseId: process.env.SEP_MEDIA_TEST_ENTERPRISE!, memberId: process.env.SEP_MEDIA_TEST_MEMBER! }
assert.ok(baseUrl && token && foreignToken && subscriptionId && owner.enterpriseId && owner.memberId, 'Missing isolated integration configuration')
const services: MediaService[] = []
const metrics = { submits: 0, quotes: 0, downloads: 0 }
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
const employee: EmployeeRuntimeConfig = { subscriptionId, modelId: 'mock-no-model', gatewayUrl: 'mock://no-model', systemPrompt: 'Mock-only integration' }
const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-media-two-repos-'))
const root = join(directory, 'user-data')

function client() {
  const store = new MediaStore(root)
  const service = new MediaService({ scope: { currentScope: () => owner }, store, gateway,
    capabilities: () => capabilities, getTask: async () => ({ subscriptionId }), authorize: async () => employee,
    requestApproval: async () => true, pollFloorMs: 1, maxAttempts: 3, operationTimeoutMs: 5000 })
  services.push(service)
  return { store, service }
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
  let { service, store } = client()
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
  ;({ service, store } = client())
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
  process.stdout.write(`SEP_MEDIA_INTEGRATION_PASSED ${JSON.stringify(metrics)}\n`)
} finally {
  try { await Promise.all(services.map(service => service.stopAll())) }
  finally { await rm(directory, { recursive: true, force: true }) }
}
