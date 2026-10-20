import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoRuntimeSchema, type VideoReceipt } from '../../src/shared/video-media'
import type { VideoGenerationInput } from '../../src/shared/video-host'
import { VideoStore } from '../data/video-store'
import { MockVideoMediaGateway, type MockVideoScenario } from '../data/mock-video-media-gateway'
import type { VideoRunPort } from '../domain/video-tools'
import type { VideoScope } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'
import { VideoRunService } from './video-run-service'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const scope: VideoScope = { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' }
const bytes = Buffer.from('mock reference')
const input = (): VideoGenerationInput => ({
  profileId: 'mock-video-from-image', operation: 'image-to-video', localAssetIds: ['asset-a'], creativeBrief: 'Slow product movement',
  parameters: { ...fixture.quoteRequest.parameters, resolution: '720p', outputFormat: 'video/mp4' },
})
async function setup(scenario: MockVideoScenario = 'success') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-run-'))
  directories.push(root)
  const store = new VideoStore(root), gateway = new MockVideoMediaGateway(scenario)
  const state = { revision: 0, runtime: videoRuntimeSchema.parse(fixture.runtime), granted: true, subscriptionId: scope.subscriptionId,
    policy: undefined as Parameters<VideoRunPort['prepareRun']>[0]['toolPolicy'], uploads: 0 }
  const approvals: Parameters<MockVideoHostOptions['requestApproval']>[0][] = []
  const options: MockVideoHostOptions = {
    mock: true, scope: { currentScope: () => ({ enterpriseId: scope.enterpriseId, memberId: scope.memberId }) }, store,
    authorizationRevision: () => state.revision,
    getTask: async () => ({ subscriptionId: state.subscriptionId }),
    authorize: async () => { if (!state.granted) throw new AppError('PERMISSION_DENIED'); return state.runtime },
    policy: async () => state.policy,
    gateway: owner => { assert.equal(owner.subscriptionId, scope.subscriptionId); return {
      quote: gateway.quote.bind(gateway), submit: gateway.submit.bind(gateway), findReceipt: gateway.findReceipt.bind(gateway),
      getReceipt: gateway.getReceipt.bind(gateway), content: gateway.content.bind(gateway),
      uploadReference: async value => { state.uploads++; return { mock: true, referenceId: 'ref-a', mimeType: 'image/png', byteLength: value.length,
        sha256: createHash('sha256').update(value).digest('hex'), width: 1, height: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    } },
    readReference: async (_owner, taskId, id) => { assert.equal(taskId, 'task-a'); assert.equal(id, 'asset-a'); return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') } },
    requestApproval: async request => { approvals.push(request); return true }, tracker: { floorMs: 1, maxAttempts: 4, budgetMs: 5000 },
  }
  const runInput: Parameters<VideoRunPort['prepareRun']>[0] = {
    taskId: 'task-a', runId: 'run-a', subscriptionId: scope.subscriptionId,
    employee: { subscriptionId: scope.subscriptionId, modelId: 'model-a', gatewayUrl: 'http://mock', video: state.runtime },
    requestApproval: options.requestApproval,
  }
  return { options, state, store, gateway, approvals, runInput, service: new VideoRunService(options) }
}

test('run facade binds two host approvals to real run and awaits original output save', async () => {
  const f = await setup(), tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  const job = await tools.execute('video_from_image', input()) as { jobId: string }
  assert.equal(f.approvals.length, 2)
  assert.ok(f.approvals.every(request => request.runId === 'run-a' && request.subscriptionId === scope.subscriptionId))
  await f.service.waitForRun('task-a', 'run-a')
  assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.state.uploads, 1)
  await f.service.finishRun('task-a', 'run-a')
  await assert.rejects(tools.execute('video_from_image', input()))
})

test('real run cannot finish a saved video while billing is reconciling and restores original billing on a later run', async () => {
  const f = await setup()
  f.state.runtime = videoRuntimeSchema.parse({ ...f.state.runtime, protocolVersion: 2, executionMode: 'real',
    profiles: f.state.runtime.profiles.map(profile => ({ ...profile, capabilities: { ...profile.capabilities,
      audioModes: [false], defaultAudio: false, defaults: fixture.quoteRequest.parameters } })) })
  f.runInput.employee.video = f.state.runtime
  let settled = false
  const source = f.options.gateway(scope)
  const real = (receipt: VideoReceipt): VideoReceipt => ({ ...receipt, mock: false,
    billingStatus: receipt.status === 'SUCCEEDED' ? settled ? 'SETTLED' : 'RECONCILING' : 'RESERVED',
    recovery: { ...receipt.recovery, canQuery: receipt.status !== 'SUCCEEDED' || !settled }, amountCny: '0.900000' })
  const options: MockVideoHostOptions = { ...f.options, mock: false, tracker: { floorMs: 1, maxAttempts: 2, budgetMs: 1000 }, gateway: () => ({
    quote: async (value, signal) => ({ ...await source.quote(value, signal), currency: 'CNY', amount: '0.900000' }),
    submit: async (value, signal) => real(await source.submit(value, signal)),
    findReceipt: async (id, signal) => { const receipt = await source.findReceipt(id, signal); return receipt ? real(receipt) : null },
    getReceipt: async (id, signal) => real(await source.getReceipt(id, signal)), content: source.content.bind(source),
    uploadReference: async (bytes, signal) => ({ ...await source.uploadReference(bytes, signal), mock: false }),
  }) }
  const service = new VideoRunService(options)
  const tools = await service.prepareRun(f.runInput)
  assert.ok(tools)
  const job = await tools.execute('video_from_image', input()) as { jobId: string }
  await assert.rejects(service.waitForRun('task-a', 'run-a'), { code: 'INVALID_STATE' })
  const pending = await f.store.getJob(scope, 'task-a', job.jobId)
  assert.equal(pending?.saveStatus, 'SAVED'); assert.equal(pending?.receipt?.billingStatus, 'RECONCILING')
  await service.finishRun('task-a', 'run-a')
  settled = true
  const next = new VideoRunService(options)
  assert.ok(await next.prepareRun({ ...f.runInput, runId: 'run-b' }))
  await next.waitForRun('task-a', 'run-b')
  const result = await f.store.getJob(scope, 'task-a', job.jobId)
  assert.equal(result?.receipt?.billingStatus, 'SETTLED'); assert.equal(result?.trackingStatus, 'STOPPED')
  assert.equal(f.gateway.calls.submit, 1); assert.equal(f.gateway.calls.quote, 1); assert.equal(f.gateway.calls.content, 1)
  await next.finishRun('task-a', 'run-b')
})

test('missing, malformed, disabled and empty-tools video cannot expose or execute tools', async () => {
  const f = await setup()
  for (const video of [undefined, {}, { ...f.state.runtime, protocolVersion: 2 }, { ...f.state.runtime, executionAvailable: false, tools: [] }, { ...f.state.runtime, tools: [] }]) {
    const employee = { ...f.runInput.employee, video } as unknown as typeof f.runInput.employee
    assert.equal(await f.service.prepareRun({ ...f.runInput, employee }), undefined)
  }
  const tools = await f.service.prepareRun(f.runInput)
  f.state.runtime = { ...f.state.runtime, tools: [] }
  await assert.rejects(tools!.execute('video_from_image', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.gateway.calls.quote, 0)
  await f.service.stopAll()
})

test('new run restores uncertain original receipt without another submission', async () => {
  const f = await setup('submission-unknown')
  const original = await new MockVideoHostService(f.options).generate('task-a', input())
  assert.equal(original.generationStatus, 'SUBMISSION_UNKNOWN')
  const tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  await f.service.waitForRun('task-a', 'run-a')
  assert.equal((await f.store.getJob(scope, 'task-a', original.jobId))?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.findReceipt, 1)
  await f.service.stopAll()
})

test('new run cannot quote or submit again while an original MAYBE_SENT is unresolved', async context => {
  const f = await setup('submission-unknown')
  const original = await new MockVideoHostService(f.options).generate('task-a', input())
  assert.equal(original.generationStatus, 'SUBMISSION_UNKNOWN')
  context.mock.method(f.gateway, 'findReceipt', async () => null)
  const tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  try {
    await assert.rejects(tools.execute('video_from_image', input()), { code: 'CONFLICT' })
    assert.equal(f.gateway.calls.quote, 1)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.state.uploads, 1)
    assert.equal(f.approvals.length, 2)
  } finally { await f.service.stopAll() }
})

test('receipt SUBMISSION_UNKNOWN also blocks generation until explicit original recovery clarifies it', async context => {
  const f = await setup('submission-unknown'), ipc = new MockVideoHostService(f.options)
  const original = await ipc.generate('task-a', input())
  await ipc.resume('task-a', original.jobId)
  const receipt = (await f.store.getJob(scope, 'task-a', original.jobId))!.receipt!
  assert.equal(receipt.status, 'SUBMISSION_UNKNOWN')
  const stalled = context.mock.method(f.gateway, 'getReceipt', async () => receipt)
  const tools = await f.service.prepareRun(f.runInput)
  try {
    await assert.rejects(tools!.execute('video_from_image', input()), { code: 'CONFLICT' })
    assert.equal(f.gateway.calls.quote, 1)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.state.uploads, 1)
  } finally { await f.service.stopAll() }
  stalled.mock.restore()
  await ipc.resume('task-a', original.jobId)
  await ipc.resume('task-a', original.jobId)
  assert.equal((await f.store.getJob(scope, 'task-a', original.jobId))!.saveStatus, 'SAVED')
  await ipc.stopAll()
})

test('actual run facade and IPC host share the in-flight submission gate', async () => {
  const f = await setup(), ipc = new MockVideoHostService(f.options)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => { entered(); await gate; return true } })
  const pending = tools!.execute('video_from_image', input())
  await waiting
  try {
    await assert.rejects(ipc.generate('task-a', input()), { code: 'CONFLICT' })
  } finally { release(); await pending; await f.service.stopAll(); await ipc.stopAll() }
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.submit, 1)
})

test('revocation revision after approval prevents upload and submit', async () => {
  const f = await setup()
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => { f.state.revision++; return true } })
  await assert.rejects(tools!.execute('video_from_image', input()), { code: 'AUTH_REQUIRED' })
  assert.equal(f.state.uploads, 0)
  assert.equal(f.gateway.calls.submit, 0)
  await f.service.stopAll()
})

test('policy change after quote blocks submission even after approval', async () => {
  const f = await setup()
  let approvals = 0
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => {
    if (++approvals === 2) f.state.policy = { preset: 'read-only', allowedTools: [], allowedPaths: [], deniedPaths: [], workspaceDir: '/unused', commandPolicy: 'disabled', approvalMode: 'confirm-each' }
    return true
  } })
  await assert.rejects(tools!.execute('video_from_image', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.gateway.calls.submit, 0)
  await f.service.stopAll()
})

test('stopTask interrupts an unresponsive approval and invalidates captured facade', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => { entered(); return new Promise<boolean>(() => undefined) } })
  const rejected = assert.rejects(tools!.execute('video_from_image', input()))
  await waiting
  await f.service.stopTask('task-a')
  await rejected
  await assert.rejects(tools!.execute('video_from_image', input()))
  assert.equal(f.gateway.calls.submit, 0)
})

test('stopped run waits for interrupted content to settle and never reports completion', async context => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  context.mock.method(f.gateway, 'content', async () => { entered(); return new Promise<AsyncIterable<Uint8Array>>(() => undefined) })
  const tools = await f.service.prepareRun(f.runInput)
  await tools!.execute('video_from_image', input())
  const rejected = assert.rejects(f.service.waitForRun('task-a', 'run-a'))
  await waiting
  await f.service.stopTask('task-a')
  await rejected
  assert.equal((await f.store.listJobs(scope))[0].saveStatus, 'SAVE_FAILED')
  assert.equal(f.gateway.calls.submit, 1)
})

test('node employee owns authorization even when task primary subscription differs', async () => {
  const f = await setup()
  f.state.subscriptionId = 'task-primary-subscription'
  const tools = await f.service.prepareRun(f.runInput)
  await tools!.execute('video_from_image', input())
  assert.ok(f.approvals.every(request => request.subscriptionId === scope.subscriptionId))
  f.state.subscriptionId = 'new-task-primary'
  await assert.rejects(f.service.waitForRun('task-a', 'run-a'), { code: 'AUTH_REQUIRED' })
  assert.equal(f.gateway.calls.submit, 1)
  await f.service.stopAll()
})

for (const scenario of ['failed', 'corrupt-download'] as const) {
  test(`${scenario} does not mark video run delivered`, async () => {
    const f = await setup(scenario), tools = await f.service.prepareRun(f.runInput)
    await tools!.execute('video_from_image', input())
    await assert.rejects(f.service.waitForRun('task-a', 'run-a'), { code: 'INVALID_STATE' })
    assert.equal(f.gateway.calls.submit, 1)
    await f.service.stopAll()
  })
}

test('stopTask aborts preparation before a delayed task binding can publish a facade', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const service = new VideoRunService({ ...f.options, getTask: async () => { entered(); return new Promise<null>(() => undefined) } })
  const rejected = assert.rejects(service.prepareRun(f.runInput))
  await waiting
  await service.stopTask('task-a')
  await rejected
  assert.equal(f.gateway.calls.submit, 0)
})

test('runtime stopTask also interrupts direct IPC host generation', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const ipcHost = new MockVideoHostService({ ...f.options, requestApproval: async () => { entered(); return new Promise<boolean>(() => undefined) } })
  const service = new VideoRunService(f.options, ipcHost)
  const rejected = assert.rejects(ipcHost.generate('task-a', input()))
  await waiting
  await service.stopTask('task-a')
  await rejected
  assert.equal(f.gateway.calls.submit, 0)
})
