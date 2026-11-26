import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoRuntimeSchema, type VideoRequest } from '../../src/shared/video-media'
import type { VideoJobView } from '../../src/shared/video-host'
import { VideoStore } from '../data/video-store'
import { MockVideoMediaGateway, type MockVideoScenario } from '../data/mock-video-media-gateway'
import type { VideoRunPort } from '../domain/video-tools'
import { AppError } from '../errors/app-error'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'
import { VideoRunService } from './video-run-service'
import { ConversationVideoRunService } from './conversation-video-run-service'
import { runtimeFeedback } from '../errors/runtime-feedback'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const owner = { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' }
const input = { creativeBrief: 'A product video', localAssetIds: ['asset-a'],
  parameters: { ...fixture.quoteRequest.parameters, resolution: '720p', outputFormat: 'video/mp4' } }

async function setup(scenario: MockVideoScenario = 'success', waitBudgetMs?: number) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-conversation-video-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new VideoStore(root), gateway = new MockVideoMediaGateway(scenario)
  const runtime = videoRuntimeSchema.parse(fixture.runtime)
  const state = { revision: 0, memberId: owner.memberId }
  const options: MockVideoHostOptions = {
    mock: true, store, scope: { currentScope: () => ({ enterpriseId: owner.enterpriseId, memberId: state.memberId }) },
    authorizationRevision: () => state.revision, getTask: async () => ({ subscriptionId: owner.subscriptionId }),
    authorize: async () => runtime, authorizeRecovery: async () => {}, gateway: () => ({
      quote: gateway.quote.bind(gateway), submit: gateway.submit.bind(gateway), findReceipt: gateway.findReceipt.bind(gateway),
      getReceipt: gateway.getReceipt.bind(gateway), content: gateway.content.bind(gateway),
      uploadReference: async bytes => ({ mock: true, referenceId: 'reference-a', mimeType: 'image/png', byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    }),
    readReference: async () => { const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2S5cAAAAASUVORK5CYII=', 'base64'); return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') } },
    tracker: { floorMs: 1, maxAttempts: 1, budgetMs: 5000 },
  }
  const ipc = new MockVideoHostService(options)
  const base = new VideoRunService(options, ipc)
  const video = new ConversationVideoRunService(base, options, waitBudgetMs)
  cleanup.push(() => base.stopAll())
  cleanup.push(() => video.stopTask('task-a'))
  const run: Parameters<VideoRunPort['prepareRun']>[0] = {
    taskId: 'task-a', runId: 'run-a', subscriptionId: owner.subscriptionId,
    employee: { subscriptionId: owner.subscriptionId, modelId: 'model-a', gatewayUrl: 'http://unused', video: runtime },
  }
  return { root, store, gateway, state, options, base, video, run, ipc }
}

test('conversation continues the original video after a bounded tracker exits while it is running', { timeout: 10_000 }, async () => {
  const f = await setup(), tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  const result = await tools.execute('video_from_image', input) as VideoJobView
  await f.video.waitForRun('task-a', 'run-a')
  assert.equal(result.generationStatus, 'SUCCEEDED')
  assert.equal(result.saveStatus, 'SAVED')
  assert.equal((await f.store.listJobs(owner)).length, 1)
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.submit, 1)
  await f.video.finishRun('task-a', 'run-a')
})

test('conversation video has one wait budget across tracker rounds and can resume the original job after expiry', { timeout: 10_000 }, async context => {
  const f = await setup('success', 2_500)
  const sharedStop = context.mock.method(f.ipc, 'stopTask')
  const getReceipt = f.gateway.getReceipt.bind(f.gateway)
  const query = context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof getReceipt>) => ({
    ...await getReceipt(...args), status: 'RUNNING' as const, outputs: [], pollAfterMs: 1,
    recovery: { canQuery: true, canDownload: false, canCancel: false },
  }))
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  const sibling = await f.video.prepareRun({ ...f.run, runId: 'run-b', recoverJobIds: [] })
  assert.ok(sibling)
  await assert.rejects(tools.execute('video_from_image', input), error => runtimeFeedback(error).code === 'MEDIA_WAIT_EXPIRED')
  assert.ok(query.mock.callCount() >= 2)
  await f.video.finishRun('task-a', 'run-a')
  assert.equal(sharedStop.mock.callCount(), 0)
  await assert.rejects(tools.execute('video_get_job', {}), /run closed/)
  await sibling.execute('video_get_job', {})
  await f.video.finishRun('task-a', 'run-b')
  const [pending] = await f.store.listJobs(owner)
  assert.equal(pending?.receipt?.status, 'RUNNING')
  assert.equal(pending?.trackingStatus, 'INTERRUPTED')
  assert.equal(f.gateway.calls.submit, 1)
  query.mock.restore()
  const ipc = new MockVideoHostService(f.options)
  try { assert.equal((await ipc.resume('task-a', pending!.jobId)).saveStatus, 'SAVED') }
  finally { await ipc.stopAll() }
  assert.equal(f.gateway.calls.submit, 1)
})

for (const stopped of [false, true]) test(`conversation automatically submits an explicitly requested fresh video and keeps later turns usable (old tracking stopped=${stopped})`, { timeout: 10_000 }, async context => {
  const f = await setup()
  const requests: VideoRequest[] = []
  const submit = f.gateway.submit.bind(f.gateway)
  context.mock.method(f.gateway, 'submit', async (...args: Parameters<typeof submit>) => {
    requests.push(args[0])
    const receipt = await submit(...args)
    if (requests.length === 1) throw new Error('Lost first submission response')
    return receipt
  })
  const missing = context.mock.method(f.gateway, 'findReceipt', async () => null)
  const ipc = new MockVideoHostService(f.options)
  const original = await ipc.generate('task-a', { ...input, profileId: 'mock-video-from-image', operation: 'image-to-video' })
  await ipc.stopAll()
  assert.equal(original.generationStatus, 'SUBMISSION_UNKNOWN')
  const savedOriginal = (await f.store.getJob(owner, 'task-a', original.jobId))!
  if (stopped) await f.store.updateJob(owner, 'task-a', original.jobId, job => ({ ...job, trackingStatus: 'STOPPED' }))
  f.options.policy = async () => ({ preset: 'full-local', approvalMode: 'auto-approve', allowedTools: [],
    allowedPaths: [], deniedPaths: [], commandPolicy: 'restricted', workspaceDir: '/unused' })
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  const result = await tools.execute('video_from_image', { ...input, creativeBrief: 'User explicitly requests a new product video' }) as VideoJobView
  await f.video.waitForRun('task-a', f.run.runId)
  assert.notEqual(result.jobId, original.jobId)
  assert.equal(result.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 2)
  assert.equal(f.gateway.calls.quote, 2)
  assert.notEqual(requests[0].clientRequestId, requests[1].clientRequestId)
  assert.equal(requests[1].creativeBrief, 'User explicitly requests a new product video')
  const retained = (await f.store.getJob(owner, 'task-a', original.jobId))!
  assert.equal(retained.submission, 'MAYBE_SENT')
  assert.equal(retained.receipt, null)
  assert.equal(retained.request.clientRequestId, savedOriginal.request.clientRequestId)
  assert.equal(retained.failure?.stage, savedOriginal.failure?.stage)
  assert.deepEqual((await f.store.getJob(owner, 'task-a', result.jobId))?.previousUnconfirmedJobIds, [original.jobId])
  await f.video.finishRun('task-a', f.run.runId)
  const reloadedOptions = { ...f.options, store: new VideoStore(f.root) }
  const reloadedBase = new VideoRunService(reloadedOptions)
  const reloaded = new ConversationVideoRunService(reloadedBase, reloadedOptions)
  cleanup.push(() => reloadedBase.stopAll())
  cleanup.push(() => reloaded.stopTask('task-a'))
  const later = await reloaded.prepareRun({ ...f.run, runId: 'later-run' })
  assert.ok(later)
  await reloaded.waitForRun('task-a', 'later-run')
  assert.equal(f.gateway.calls.submit, 2)
  assert.equal((await f.store.getJob(owner, 'task-a', original.jobId))?.submission, 'MAYBE_SENT')
  const history = await later.execute('video_get_job', { jobId: original.jobId }) as VideoJobView
  assert.equal(history.generationStatus, 'SUBMISSION_UNKNOWN')
  await reloaded.finishRun('task-a', 'later-run')
  missing.mock.restore()
  assert.ok(await reloaded.prepareRun({ ...f.run, runId: 'recover-original', recoverJobIds: [original.jobId] }))
  await reloaded.waitForRun('task-a', 'recover-original')
  assert.equal((await f.store.getJob(owner, 'task-a', original.jobId))?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 2)
  assert.equal(f.gateway.calls.quote, 2)
})

test('conversation restores original pending video before completing a recovered turn', { timeout: 10_000 }, async () => {
  const f = await setup(), tools = await f.base.prepareRun(f.run)
  assert.ok(tools)
  await assert.rejects(tools.execute('video_from_image', input), { code: 'INVALID_STATE' })
  const original = (await f.store.listJobs(owner))[0]!
  await f.base.stopTask('task-a')
  assert.ok(await f.video.prepareRun({ ...f.run, runId: 'run-b', recoverJobIds: [original.jobId] }))
  await f.video.waitForRun('task-a', 'run-b')
  const saved = await f.store.getJob(owner, 'task-a', original.jobId)
  assert.equal(saved?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.submit, 1)
  await f.video.finishRun('task-a', 'run-b')
})

test('conversation retries a rate-limited original download after arrangement recovery is exhausted', { timeout: 15_000 }, async context => {
  const f = await setup()
  let downloads = 0
  const content = f.gateway.content.bind(f.gateway)
  context.mock.method(f.gateway, 'content', async (...args: Parameters<typeof content>) => {
    if (++downloads <= 6) throw new AppError('RATE_LIMITED')
    return content(...args)
  })
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  await tools.execute('video_from_image', input)
  await f.video.waitForRun('task-a', 'run-a')
  assert.equal((await f.store.listJobs(owner))[0]?.saveStatus, 'SAVED')
  assert.equal(downloads, 7)
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.submit, 1)
  await f.video.finishRun('task-a', 'run-a')
})

test('conversation keeps recovering a rate-limited original download until it becomes available', { timeout: 20_000 }, async context => {
  const f = await setup()
  let downloads = 0
  let allowDownload = false
  const content = f.gateway.content.bind(f.gateway)
  context.mock.method(f.gateway, 'content', async (...args: Parameters<typeof f.gateway.content>) => {
    downloads++
    if (!allowDownload) throw new AppError('RATE_LIMITED')
    return content(...args)
  })
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  let settled = false
  const execution = tools.execute('video_from_image', input).finally(() => { settled = true })
  const deadline = Date.now() + 10_000
  while (downloads < 12 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(downloads >= 12, `expected repeated recovery attempts, saw ${downloads}`)
  assert.equal(settled, false)
  allowDownload = true
  await execution
  await f.video.waitForRun('task-a', 'run-a')
  const job = (await f.store.listJobs(owner))[0]
  assert.equal(job?.saveStatus, 'SAVED')
  assert.equal(job?.receipt?.recovery.canDownload, true)
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.submit, 1)
  await f.video.finishRun('task-a', 'run-a')
})

test('conversation cancellation stops original-video recovery without generating another video', { timeout: 10_000 }, async context => {
  const f = await setup(), controller = new AbortController()
  const receipt = f.gateway.getReceipt.bind(f.gateway)
  let observed!: () => void
  const queried = new Promise<void>(resolve => { observed = resolve })
  context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof receipt>) => {
    const current = await receipt(...args)
    observed()
    return { ...current, pollAfterMs: 20_000 }
  })
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  const generating = tools.execute('video_from_image', input, controller.signal)
  const rejected = assert.rejects(generating, /Conversation cancelled/)
  await queried
  await new Promise(resolve => setTimeout(resolve, 120))
  controller.abort(new Error('Conversation cancelled'))
  await rejected
  assert.equal(f.gateway.calls.submit, 1)
  await f.video.stopTask('task-a')
})

test('conversation cannot restart original tracking after account or authorization changes', { timeout: 10_000 }, async context => {
  const f = await setup()
  const receipt = f.gateway.getReceipt.bind(f.gateway)
  context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof receipt>) => {
    const current = await receipt(...args)
    f.state.memberId = 'member-b'
    f.state.revision++
    return current
  })
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  await assert.rejects(tools.execute('video_from_image', input), { code: 'AUTH_REQUIRED' })
  assert.equal((await f.store.listJobs(owner)).length, 1)
  assert.equal(f.gateway.calls.submit, 1)
  await f.video.stopTask('task-a')
})

test('conversation recovers a one-time receipt validation interruption using the original request', { timeout: 10_000 }, async context => {
  const f = await setup()
  const receipt = f.gateway.getReceipt.bind(f.gateway)
  let invalid = true
  context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof receipt>) => {
    const current = await receipt(...args)
    if (invalid) { invalid = false; return { ...current, clientRequestId: 'wrong-request' } }
    return current
  })
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  const result = await tools.execute('video_from_image', input) as VideoJobView
  assert.equal(result.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.gateway.calls.quote, 1)
})

test('conversation preserves a confirmed generation failure rather than recovering or submitting again', { timeout: 10_000 }, async () => {
  const f = await setup('failed'), tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  await assert.rejects(tools.execute('video_from_image', input))
  assert.equal((await f.store.listJobs(owner))[0]?.receipt?.status, 'FAILED')
  const queries = f.gateway.calls.getReceipt
  await assert.rejects(f.video.waitForRun('task-a', 'run-a'))
  assert.equal(f.gateway.calls.getReceipt, queries)
  assert.equal(f.gateway.calls.submit, 1)
})

test('conversation completion and the tool share original-video recovery', { timeout: 10_000 }, async () => {
  const f = await setup(), tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  const generating = tools.execute('video_from_image', input)
  await new Promise(resolve => setTimeout(resolve, 350))
  await Promise.all([generating, f.video.waitForRun('task-a', 'run-a'), f.video.waitForRun('task-a', 'run-a')])
  assert.equal((await f.store.listJobs(owner))[0]?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.getReceipt, 2)
  assert.equal(f.gateway.calls.submit, 1)
})

test('conversation stops on persistent invalid original receipts and preserves the concrete error', { timeout: 10_000 }, async context => {
  const f = await setup()
  const receipt = f.gateway.getReceipt.bind(f.gateway)
  context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof receipt>) => ({ ...await receipt(...args), clientRequestId: 'wrong-request' }))
  const tools = await f.video.prepareRun(f.run)
  assert.ok(tools)
  await assert.rejects(tools.execute('video_from_image', input), /Video receipt differs from original request/)
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal((await f.store.listJobs(owner))[0]?.saveStatus, 'PENDING')
})
