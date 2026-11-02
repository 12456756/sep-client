import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import type { VideoGenerationInput } from '../../src/shared/video-host'
import { videoReceiptSchema, videoRuntimeSchema, type VideoReceipt } from '../../src/shared/video-media'
import { MockVideoMediaGateway } from '../data/mock-video-media-gateway'
import { VideoStore } from '../data/video-store'
import { ArrangementMediaLinkStore } from '../data/arrangement-media-link-store'
import type { ArrangementMediaLink } from '../domain/arrangement-media'
import type { VideoScope } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'
import { SepRealVideoGateway } from '../data/sep-video-media-gateway'

function realReceipt(receipt: VideoReceipt): VideoReceipt {
  return { ...receipt, mock: false, billingStatus: receipt.status === 'SUCCEEDED' ? 'SETTLED' : 'RESERVED', amountCny: '0.900000', amountUsd: '0.12', ...(receipt.status === 'SUCCEEDED' ? { actualCostCny: '0.800000' } : {}) }
}
async function realSetup() {
  const f = await setup()
  // This delivery fixture represents a v2 silent-capable provider. The legacy
  // real v1 H3 fixed-audio contract is exercised separately below.
  f.state.runtime = videoRuntimeSchema.parse({ ...f.state.runtime, protocolVersion: 2, executionMode: 'real',
    profiles: f.state.runtime.profiles.map(profile => ({ ...profile, capabilities: { ...profile.capabilities,
      audioModes: [false], defaultAudio: false, defaults: fixture.quoteRequest.parameters } })) })
  const gateway = f.options.gateway(scope)
  const options: MockVideoHostOptions = { ...f.options, mock: false, gateway: () => ({
    quote: async (input, signal) => ({ ...await gateway.quote(input, signal), currency: 'CNY', amount: '0.900000', amountUsd: '0.12', pricingVersion: 'v2', usdToCnyRate: 7.5, funding: { creditCny: '0.900000', memberWalletCny: '0.000000', personalCny: '0.000000' } }),
    submit: async (input, signal) => realReceipt(await gateway.submit(input, signal)),
    findReceipt: async (id, signal) => { const value = await gateway.findReceipt(id, signal); return value ? realReceipt(value) : null },
    getReceipt: async (id, signal) => realReceipt(await gateway.getReceipt(id, signal)),
    content: gateway.content.bind(gateway),
    uploadReference: async (bytes, signal) => ({ ...await gateway.uploadReference(bytes, signal), mock: false }),
  }) }
  return { ...f, options, host: new MockVideoHostService(options) }
}

test('real host approves actual CNY quote, freezes mode, saves and reopens without byte IPC', async () => {
  const f = await realSetup()
  const opened: string[] = []
  const host = new MockVideoHostService({ ...f.options, openOutput: async (_scope, _task, jobId, _output, _signal, validate) => { validate(); opened.push(jobId) } })
  const job = await host.generate('task-a', input())
  assert.equal(job.billingStatus, 'RESERVED'); assert.equal(job.amountCny, '0.900000')
  const approval = f.approvals[1].input as { mock: boolean; quote: { amount: string; currency: string; amountUsd: string } }
  assert.equal(approval.mock, false); assert.equal(approval.quote.amount, '0.900000'); assert.equal(approval.quote.currency, 'CNY'); assert.equal(approval.quote.amountUsd, '0.12')
  await host.resume('task-a', job.jobId)
  const saved = await host.resume('task-a', job.jobId)
  assert.equal(saved.saveStatus, 'SAVED'); assert.equal(saved.billingStatus, 'SETTLED'); assert.equal(saved.actualCostCny, '0.800000')
  const [stored] = await f.store.listJobs(scope)
  assert.equal(stored.executionMode, 'real'); assert.equal(stored.receipt?.mock, false)
  await host.stopAll()
  const reopened = new MockVideoHostService({ ...f.options, openOutput: async (_scope, _task, id) => { opened.push(id) } })
  assert.equal((await reopened.getTaskVideo('task-a')).mock, false)
  const preview = await reopened.preview('task-a', job.jobId, saved.outputs[0].outputId)
  assert.equal('bytes' in preview, false); assert.equal(preview.opened, true)
  assert.deepEqual(opened, [job.jobId]); assert.equal(f.gateway.calls.submit, 1)
  await reopened.stopAll()
})

test('lost real submit response recovers original request and never repeats submission', async () => {
  const f = await realSetup(), gateway = f.options.gateway(scope)
  const host = new MockVideoHostService({ ...f.options, gateway: () => ({ ...gateway,
    submit: async (input, signal) => { await gateway.submit(input, signal); throw new Error('lost response') },
  }) })
  const unknown = await host.generate('task-a', input())
  assert.equal(unknown.generationStatus, 'SUBMISSION_UNKNOWN')
  assert.equal(unknown.billingStatus, 'RECONCILING')
  await host.stopAll()
  const restored = new MockVideoHostService(f.options)
  await restored.resume('task-a', unknown.jobId)
  await restored.resume('task-a', unknown.jobId)
  assert.equal((await restored.resume('task-a', unknown.jobId)).saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1); assert.equal(f.gateway.calls.quote, 1)
  await restored.stopAll()
})

test('real host exposes definitive rejection and skips original lookup on restart while allowing an explicit new request', async () => {
  const f = await realSetup()
  let submissions = 0
  const denied = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: scope.subscriptionId,
    token: async () => 'test-token', fetch: async () => {
      submissions++
      return new Response(JSON.stringify({ error: { code: 'VIDEO_BUDGET_EXCEEDED', source: 'platform', requestId: 'req-rejected-1' } }),
        { status: 402, headers: { 'Content-Type': 'application/json' } })
    } })
  const options: MockVideoHostOptions = { ...f.options, gateway: owner => ({ ...f.options.gateway(owner), submit: denied.submit.bind(denied) }) }
  const host = new MockVideoHostService(options)
  const job = await host.generate('task-a', input())
  assert.equal(job.generationStatus, 'FAILED')
  assert.equal(job.trackingStatus, 'STOPPED')
  assert.equal(job.error, 'VIDEO_BUDGET_EXCEEDED')
  assert.equal(job.billingStatus, 'NOT_RESERVED')
  await host.stopAll()
  const restored = new MockVideoHostService(options)
  try {
    await restored.resumePending(['task-a'])
    await restored.track('task-a')
    assert.deepEqual(await restored.resume('task-a', job.jobId), job)
    assert.equal(f.gateway.calls.findReceipt, 0)
    assert.equal(f.gateway.calls.getReceipt, 0)
    assert.equal(submissions, 1)
    const next = await restored.generate('task-a', input())
    assert.notEqual(next.jobId, job.jobId)
    assert.equal(submissions, 2)
    assert.equal(f.gateway.calls.quote, 2)
    assert.equal(f.approvals.length, 4)
  } finally { await restored.stopAll(); await f.host.stopAll() }
})

test('local history stays mode isolated regardless of current runtime mode', async () => {
  const f = await setup()
  const mockJob = await f.host.generate('task-a', input())
  const realOptions: MockVideoHostOptions = { ...f.options, mock: false }
  const real = new MockVideoHostService(realOptions)
  assert.deepEqual((await real.getTaskVideo('task-a')).jobs, [])
  f.state.runtime.executionMode = 'real'
  assert.equal((await f.host.getTaskVideo('task-a')).jobs[0].jobId, mockJob.jobId)
  assert.deepEqual((await real.getTaskVideo('task-a')).jobs, [])
  const before = { ...f.gateway.calls }
  await assert.rejects(real.resume('task-a', mockJob.jobId), { code: 'PERMISSION_DENIED' })
  await assert.rejects(real.preview('task-a', mockJob.jobId, 'output-a'))
  assert.deepEqual(f.gateway.calls, before)
  assert.equal((await f.store.listJobs(scope)).length, 1)
  await f.host.stopAll(); await real.stopAll()
})

test('mode revoked during real approval prevents dispatch and leaves frozen unsubmitted evidence', async () => {
  const f = await realSetup()
  let count = 0
  const host = new MockVideoHostService({ ...f.options, requestApproval: async () => { if (++count === 2) f.state.runtime.executionMode = 'mock'; return true } })
  await assert.rejects(host.generate('task-a', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.gateway.calls.submit, 0)
  assert.equal((await f.store.listJobs(scope))[0].executionMode, 'real')
  assert.equal((await f.store.listJobs(scope))[0].submission, 'NOT_SENT')
  await host.stopAll()
})

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const scope: VideoScope = { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' }
const bytes = Buffer.from('mock reference image')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const input = (): VideoGenerationInput => ({
  profileId: 'mock-video-from-image', operation: 'image-to-video', localAssetIds: ['asset-a'],
  creativeBrief: 'Slow product movement', parameters: { ...fixture.quoteRequest.parameters, resolution: '720p', outputFormat: 'video/mp4' },
})
async function setup(overrides: Partial<MockVideoHostOptions> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-host-'))
  directories.push(root)
  const store = new VideoStore(root)
  const gateway = new MockVideoMediaGateway()
  const state = { scope: { enterpriseId: scope.enterpriseId, memberId: scope.memberId } as { enterpriseId: string; memberId: string } | null,
    runtime: videoRuntimeSchema.parse(fixture.runtime), subscriptionId: scope.subscriptionId, approve: true, uploads: 0, authorizations: 0 }
  const approvals: Parameters<MockVideoHostOptions['requestApproval']>[0][] = []
  const options: MockVideoHostOptions = {
    mock: true, scope: { currentScope: () => state.scope }, store, authorizationRevision: () => 0,
    getTask: async () => ({ subscriptionId: state.subscriptionId }),
    authorize: async id => { assert.equal(id, scope.subscriptionId); state.authorizations++; return state.runtime },
    readReference: async (owner, taskId, assetId) => {
      assert.deepEqual(owner, scope); assert.equal(taskId, 'task-a'); assert.equal(assetId, 'asset-a')
      return { bytes, sha256 }
    },
    gateway: () => ({
      quote: gateway.quote.bind(gateway), submit: gateway.submit.bind(gateway),
      findReceipt: gateway.findReceipt.bind(gateway), getReceipt: gateway.getReceipt.bind(gateway), content: gateway.content.bind(gateway),
      uploadReference: async (value, signal) => {
        signal.throwIfAborted(); assert.deepEqual(value, bytes); state.uploads++
        return { mock: true, referenceId: 'reference-a', expiresAt: new Date(Date.now() + 60_000).toISOString(), mimeType: 'image/png', byteLength: bytes.length, sha256, width: 1, height: 1 }
      },
    }),
    requestApproval: async value => { approvals.push(structuredClone(value)); return state.approve },
    ...overrides,
  }
  return { root, state, store, gateway, approvals, options, host: new MockVideoHostService(options) }
}

async function arrangementOutput(real: boolean, overrides: Partial<ArrangementMediaLink> = {}) {
  const f = await (real ? realSetup() : setup())
  const job = await f.host.generate('task-a', input(), undefined, { runId: 'video-node-run', requestApproval: f.options.requestApproval })
  await f.host.resume('task-a', job.jobId)
  const saved = await f.host.resume('task-a', job.jobId)
  const outputId = saved.outputs[0].outputId
  const asset = (await f.store.getAsset(scope, 'task-a', job.jobId, outputId))!
  const links = new ArrangementMediaLinkStore(f.root)
  const link: ArrangementMediaLink = {
    version: 1, owner: f.state.scope!, taskId: 'task-a', arrangementRunId: 'arrangement-run',
    nodeId: 'video-node', nodeRunId: 'video-node-run', attempt: 1, subscriptionId: scope.subscriptionId,
    kind: 'video', operation: 'image-to-video', jobId: job.jobId, inputs: [],
    outputs: [{ artifactId: asset.localAssetId, sha256: asset.output.sha256, status: 'saved' }],
    materializations: [], createdAt: 1, updatedAt: 1, ...overrides,
  }
  await links.upsert(f.state.scope!, link)
  await f.host.stopAll()
  f.state.subscriptionId = 'image-employee'
  return { ...f, job, outputId, asset, links, link }
}

for (const real of [false, true]) {
  test(`${real ? 'real' : 'mock'} arrangement preview resolves the persisted video employee without network authorization`, async () => {
    const f = await arrangementOutput(real)
    const calls = { ...f.gateway.calls }
    let opened = 0
    const host = new MockVideoHostService({ ...f.options, arrangementMediaLinks: f.links,
      authorize: async () => { assert.fail('Saved arrangement outputs must remain available offline') },
      openOutput: async (actualScope, taskId, jobId, outputId, signal, validate) => {
        signal.throwIfAborted(); validate(); opened++
        assert.deepEqual(actualScope, scope)
        assert.ok(await f.store.verifiedAssetPath(actualScope, taskId, jobId, outputId))
      },
    })
    try {
      const preview = await host.preview('task-a', f.job.jobId, f.outputId)
      assert.equal((await host.outputInfo('task-a', f.job.jobId, f.outputId)).outputId, f.outputId)
      if (real) { assert.equal(preview.opened, true); assert.equal('bytes' in preview, false); assert.equal(opened, 1) }
      else assert.deepEqual(preview.bytes, await f.store.readAsset(scope, 'task-a', f.job.jobId, f.outputId))
      assert.deepEqual(f.gateway.calls, calls)
    } finally { await host.stopAll() }
  })

  test(`${real ? 'real' : 'mock'} arrangement export uses the video employee after the native dialog`, async () => {
    const f = await arrangementOutput(real)
    let exports = 0
    const host = new MockVideoHostService({ ...f.options, arrangementMediaLinks: f.links,
      exportOutput: async (actualScope, taskId, jobId, outputId, _path, signal, validate) => {
        signal.throwIfAborted(); validate(); exports++
        assert.deepEqual(actualScope, scope)
        assert.ok(await f.store.verifiedAssetPath(actualScope, taskId, jobId, outputId))
      },
    })
    try {
      const selection = await host.nativeSelection('task-a')
      await selection.export(f.job.jobId, f.outputId, '/native/video.mp4')
      assert.equal(exports, 1)
      f.state.subscriptionId = 'different-task-employee'
      await assert.rejects(selection.export(f.job.jobId, f.outputId, '/native/video.mp4'), { code: 'AUTH_REQUIRED' })
      assert.equal(exports, 1)
    } finally { await host.stopAll() }
  })
}

test('arrangement output resolution rejects foreign tasks, owners and unknown outputs', async () => {
  const f = await arrangementOutput(false)
  const host = new MockVideoHostService({ ...f.options, arrangementMediaLinks: f.links })
  try {
    await assert.rejects(host.preview('other-task', f.job.jobId, f.outputId), { code: 'NOT_FOUND' })
    await assert.rejects(host.preview('task-a', 'unknown-job', f.outputId), { code: 'NOT_FOUND' })
    await assert.rejects(host.preview('task-a', f.job.jobId, 'unknown-output'), { code: 'NOT_FOUND' })
    f.state.scope = { enterpriseId: scope.enterpriseId, memberId: 'other-member' }
    await assert.rejects(host.preview('task-a', f.job.jobId, f.outputId), { code: 'NOT_FOUND' })
  } finally { await host.stopAll() }
})

for (const overrides of [{ nodeRunId: 'unrelated-run' }, { outputs: [] },
  { outputs: [{ artifactId: 'unrelated-artifact', sha256: 'a'.repeat(64), status: 'saved' as const }] },
]) test(`arrangement output requires original run and output evidence: ${JSON.stringify(overrides)}`, async () => {
  const f = await arrangementOutput(false, overrides)
  const host = new MockVideoHostService({ ...f.options, arrangementMediaLinks: f.links })
  try { await assert.rejects(host.preview('task-a', f.job.jobId, f.outputId), { code: 'NOT_FOUND' }) }
  finally { await host.stopAll() }
})

test('arrangement output rejects a mismatched hash for the original artifact', async () => {
  const f = await arrangementOutput(false)
  const host = new MockVideoHostService({ ...f.options, arrangementMediaLinks: {
    get: async () => ({ ...f.link, outputs: [{ ...f.link.outputs[0], sha256: 'a'.repeat(64) }] }),
    list: f.links.list.bind(f.links), upsert: f.links.upsert.bind(f.links),
  } })
  try { await assert.rejects(host.preview('task-a', f.job.jobId, f.outputId), { code: 'NOT_FOUND' }) }
  finally { await host.stopAll() }
})

for (const change of ['owner', 'revision', 'task', 'stop'] as const) test(`arrangement output fences ${change} changes during link lookup`, async () => {
  const f = await arrangementOutput(true)
  let revision = 0, opened = 0
  const host = new MockVideoHostService({ ...f.options, localAuthorizationRevision: () => revision,
    arrangementMediaLinks: {
      list: f.links.list.bind(f.links), upsert: f.links.upsert.bind(f.links),
      get: async (...args) => {
        const link = await f.links.get(...args)
        if (change === 'owner') f.state.scope = { ...f.state.scope!, memberId: 'other-member' }
        else if (change === 'revision') revision++
        else if (change === 'task') f.state.subscriptionId = 'other-employee'
        else await host.stopTask('task-a')
        return link
      },
    },
    openOutput: async () => { opened++ },
  })
  try {
    await assert.rejects(host.preview('task-a', f.job.jobId, f.outputId), error => change === 'stop'
      ? error instanceof Error && (error.name === 'AbortError' || error.message === 'Mock video task stopped.')
      : error instanceof AppError && error.code === 'AUTH_REQUIRED')
    assert.equal(opened, 0)
  } finally { await host.stopAll() }
})

test('mock host approves upload and durable zero quote, then submits only once and projects safe views', async () => {
  const f = await setup()
  const view = await f.host.generate('task-a', input())
  assert.equal(f.approvals.length, 2)
  assert.equal((f.approvals[0].input as Record<string, unknown>).operation, 'upload-references')
  assert.equal(f.approvals[1].toolName, 'video_from_image')
  assert.deepEqual((f.approvals[1].input as Record<string, unknown>).quote, { amount: '0.000000', currency: 'MOCK', expiresAt: (await f.store.listJobs(scope))[0].quote.expiresAt })
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.state.uploads, 1)
  assert.equal(view.generationStatus, 'QUEUED')
  await f.host.resume('task-a', view.jobId)
  assert.equal((await f.host.resume('task-a', view.jobId)).saveStatus, 'SAVED')
  const task = await f.host.getTaskVideo('task-a')
  assert.equal(task.jobs.length, 1)
  assert.equal(task.jobs[0].generationStatus, 'SUCCEEDED')
  const serialized = JSON.stringify(task)
  for (const forbidden of ['reference-a', 'clientRequestId', 'receiptId', 'relativePath', 'creativeBrief', 'quoteId', 'modelId']) assert.equal(serialized.includes(forbidden), false)
  await f.host.stopAll()
})

test('reference transmission denial prevents reads, uploads, quotes and submissions', async () => {
  const f = await setup({ readReference: async () => { throw new Error('must not read unapproved bytes') } })
  f.state.approve = false
  await assert.rejects(f.host.generate('task-a', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.state.uploads, 0)
  assert.equal(f.gateway.calls.quote, 0)
  assert.equal(f.gateway.calls.submit, 0)
  assert.deepEqual(await f.store.listJobs(scope), [])
})

test('generation denial leaves durable NOT_SENT and recovery cannot submit it', async () => {
  const f = await setup()
  let count = 0
  const host = new MockVideoHostService({ ...f.options, requestApproval: async () => ++count === 1 })
  await assert.rejects(host.generate('task-a', input()), { code: 'PERMISSION_DENIED' })
  const [job] = await f.store.listJobs(scope)
  assert.equal(job.submission, 'NOT_SENT')
  const reopened = new MockVideoHostService(f.options)
  assert.equal((await reopened.resume('task-a', job.jobId)).trackingStatus, 'STOPPED')
  assert.equal(f.gateway.calls.submit, 0)
})

for (const change of ['logout', 'member', 'subscription', 'config', 'disabled'] as const) {
  test(`rejects ${change} changed during generation approval`, async () => {
    const f = await setup()
    let count = 0
    const host = new MockVideoHostService({ ...f.options, requestApproval: async () => {
      if (++count === 2) {
        if (change === 'logout') f.state.scope = null
        if (change === 'member') f.state.scope = { enterpriseId: scope.enterpriseId, memberId: 'other' }
        if (change === 'subscription') f.state.subscriptionId = 'other'
        if (change === 'config') f.state.runtime.profiles[0].configVersion = 'changed-version'
        if (change === 'disabled') f.state.runtime = { ...f.state.runtime, executionAvailable: false, tools: [] }
      }
      return true
    } })
    await assert.rejects(host.generate('task-a', input()), error => error instanceof AppError)
    assert.equal(f.gateway.calls.submit, 0)
    assert.equal((await f.store.listJobs(scope))[0].submission, 'NOT_SENT')
  })
}

test('uses a frozen generation input while approvals are pending and deduplicates concurrent clicks', async () => {
  const f = await setup()
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const host = new MockVideoHostService({ ...f.options, requestApproval: async () => { entered(); await gate; return true } })
  const mutable = input()
  const pending = host.generate('task-a', mutable)
  await waiting
  mutable.creativeBrief = 'changed'; mutable.parameters.durationSeconds = 10; mutable.localAssetIds[0] = 'other'
  await assert.rejects(host.generate('task-a', input()), { code: 'CONFLICT' })
  release()
  await pending
  const [job] = await f.store.listJobs(scope)
  assert.equal(job.request.creativeBrief, 'Slow product movement')
  assert.equal(job.request.parameters.durationSeconds, 5)
  assert.equal(f.gateway.calls.submit, 1)
})

test('stopAll aborts an unresponsive approval without sending a request and supports a new session', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  let stalled = true
  const host = new MockVideoHostService({ ...f.options, requestApproval: async () => {
    if (stalled) { entered(); return new Promise<boolean>(() => undefined) }
    return true
  } })
  const pending = host.generate('task-a', input())
  const rejected = assert.rejects(pending)
  await waiting
  await host.stopAll()
  await rejected
  assert.equal(f.gateway.calls.submit, 0)
  stalled = false
  await host.generate('task-a', input())
  assert.equal(f.gateway.calls.submit, 1)
})

test('rejects unavailable capabilities, policies, path inputs and invalid reference hashes before submit', async () => {
  const f = await setup()
  await assert.rejects(f.host.generate('task-a', { ...input(), localAssetIds: ['/tmp/private.png'] }))
  await assert.rejects(f.host.generate('../task', input()))
  await assert.rejects(f.host.generate('task-a', { ...input(), parameters: { ...input().parameters, audio: true } }), { code: 'INVALID_ARGUMENT' })
  const readOnly = new MockVideoHostService({ ...f.options, policy: async () => ({ preset: 'read-only', allowedTools: [], workspaceDir: '/unused', allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled', approvalMode: 'confirm-each' }) })
  await assert.rejects(readOnly.generate('task-a', input()), { code: 'PERMISSION_DENIED' })
  const corrupt = new MockVideoHostService({ ...f.options, readReference: async () => ({ bytes, sha256: 'a'.repeat(64) }) })
  await assert.rejects(corrupt.generate('task-a', input()), { code: 'INVALID_ARGUMENT' })
  assert.equal(f.gateway.calls.submit, 0)
  assert.equal(f.state.uploads, 0)
})

test('reauthorizes before every original query; revoked runtime never reaches the gateway', async () => {
  const f = await setup()
  let revoked = false
  const host = new MockVideoHostService({ ...f.options, authorize: async () => {
    if (revoked) throw new AppError('PERMISSION_DENIED')
    return f.state.runtime
  } })
  const job = await host.generate('task-a', input())
  revoked = true
  const paused = await host.resume('task-a', job.jobId)
  assert.equal(paused.trackingStatus, 'AUTH_REQUIRED')
  assert.equal(paused.error, 'PERMISSION_DENIED')
  assert.equal(f.gateway.calls.getReceipt, 0)
  assert.equal(f.gateway.calls.submit, 1)
})

test('host tracker restores disk jobs without another quote or submit', async () => {
  const f = await setup()
  const submitted = await f.host.generate('task-a', input())
  await f.host.stopAll()
  const reopened = new MockVideoHostService({ ...f.options, tracker: { floorMs: 1 } })
  await reopened.track('task-a')
  const view = await reopened.getTaskVideo('task-a')
  assert.equal(view.jobs[0].jobId, submitted.jobId)
  assert.equal(view.jobs[0].saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.gateway.calls.content, 1)
  await reopened.stopAll()
})

test('host tracker remains paused after revocation until explicit resume', async context => {
  const f = await setup()
  const job = await f.host.generate('task-a', input())
  const denied = context.mock.method(f.gateway, 'getReceipt', async () => { throw new AppError('PERMISSION_DENIED') })
  const host = new MockVideoHostService({ ...f.options, tracker: { floorMs: 1 } })
  await host.track('task-a')
  assert.equal(denied.mock.callCount(), 1)
  await host.track('task-a')
  assert.equal(denied.mock.callCount(), 1)
  denied.mock.restore()
  await host.stopAll()
  const resumedHost = new MockVideoHostService({ ...f.options, tracker: { floorMs: 1 } })
  const resumed = await resumedHost.resume('task-a', job.jobId)
  assert.equal(resumed.generationStatus, 'RUNNING')
  await resumedHost.track('task-a')
  assert.equal((await resumedHost.getTaskVideo('task-a')).jobs[0].saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  await resumedHost.stopAll()
})

test('stopping host tracking aborts a stalled query and preserves the original disk request', async () => {
  const f = await setup()
  const job = await f.host.generate('task-a', input())
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const original = f.options.gateway
  const stalled = new MockVideoHostService({ ...f.options, gateway: owner => ({
    ...original(owner), getReceipt: async () => { entered(); return new Promise(() => undefined) },
  }) })
  const tracking = stalled.track('task-a')
  await started
  await stalled.stopAll()
  await tracking
  const [stored] = await f.store.listJobs(scope)
  assert.equal(stored.jobId, job.jobId)
  assert.equal(stored.submission, 'RECEIPTED')
  assert.equal(f.gateway.calls.submit, 1)
  const reopened = new MockVideoHostService({ ...f.options, tracker: { floorMs: 1 } })
  await reopened.track('task-a')
  assert.equal((await reopened.getTaskVideo('task-a')).jobs[0].saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  await reopened.stopAll()
})

test('rechecks policy after generation approval and at the actual upload boundary', async () => {
  for (const stage of ['upload', 'generation'] as const) {
    const f = await setup()
    let approvals = 0
    const host = new MockVideoHostService({ ...f.options,
      policy: async () => ({ preset: approvals >= (stage === 'upload' ? 1 : 2) ? 'read-only' : 'full-local', allowedTools: [], workspaceDir: '/unused', allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled', approvalMode: 'confirm-each' }),
      requestApproval: async () => { approvals++; return true },
    })
    // A denied submit is conservatively MAYBE_SENT, but the source is never called.
    if (stage === 'upload') await assert.rejects(host.generate('task-a', input()), { code: 'PERMISSION_DENIED' })
    else assert.equal((await host.generate('task-a', input())).trackingStatus, 'AUTH_REQUIRED')
    assert.equal(f.gateway.calls.submit, 0)
    assert.equal(f.state.uploads, stage === 'upload' ? 0 : 1)
  }
})

test('checks policy after a delayed task binding, before the actual side effect', async () => {
  const f = await setup()
  let revoked = false
  const host = new MockVideoHostService({ ...f.options,
    getTask: async () => { revoked = true; return { subscriptionId: scope.subscriptionId } },
    policy: async () => ({ preset: revoked ? 'read-only' : 'full-local', allowedTools: [], workspaceDir: '/unused', allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled', approvalMode: 'confirm-each' }),
  })
  await assert.rejects(host.generate('task-a', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.gateway.calls.submit, 0)
})

test('rejects changes during final policy lookup using the synchronous host revision', async () => {
  const f = await setup()
  let revision = 0, approvals = 0
  const host = new MockVideoHostService({ ...f.options,
    authorizationRevision: () => revision,
    requestApproval: async () => { approvals++; return true },
    policy: async () => {
      if (approvals === 2) { f.state.subscriptionId = 'subscription-b'; revision++ }
      return undefined
    },
  })
  await host.generate('task-a', input())
  assert.equal(f.gateway.calls.submit, 0)
  assert.equal((await f.store.listJobs(scope))[0].trackingStatus, 'AUTH_REQUIRED')
})

test('a task rebound during final runtime authorization cannot reach the submit adapter', async () => {
  const f = await setup()
  let approvals = 0
  const host = new MockVideoHostService({ ...f.options,
    requestApproval: async () => { approvals++; return true },
    authorize: async () => {
      if (approvals === 2) f.state.subscriptionId = 'subscription-b'
      return f.state.runtime
    },
  })
  await assert.rejects(host.generate('task-a', input()), { code: 'AUTH_REQUIRED' })
  assert.equal(f.gateway.calls.submit, 0)
  assert.equal((await f.store.listJobs(scope))[0].submission, 'NOT_SENT')
})

test('never returns old-scope results when logout happens during receipt persistence', async context => {
  const f = await setup()
  const update = f.store.updateJob.bind(f.store)
  context.mock.method(f.store, 'updateJob', async (...args: Parameters<typeof update>) => {
    const job = await update(...args)
    if (job.submission === 'RECEIPTED') f.state.scope = null
    return job
  })
  await assert.rejects(f.host.generate('task-a', input()), { code: 'AUTH_REQUIRED' })
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal((await f.store.listJobs(scope))[0].submission, 'RECEIPTED')
})

test('native selection lease rejects changed authorization before import or export', async () => {
  const f = await setup()
  let revision = 1, imports = 0, exports = 0
  const host = new MockVideoHostService({ ...f.options, authorizationRevision: () => revision,
    references: { list: async () => [], import: async () => { imports++; return [] } },
    exportOutput: async () => { exports++ },
  })
  const selection = await host.nativeSelection('task-a')
  revision++
  await assert.rejects(selection.import(['/native/reference.png']), { code: 'AUTH_REQUIRED' })
  await assert.rejects(selection.export('job-a', 'output-a', '/native/export.mp4'), { code: 'AUTH_REQUIRED' })
  assert.equal(imports, 0); assert.equal(exports, 0)
  const current = await host.nativeSelection('task-a')
  await current.import(['/native/reference.png'])
  const generated = await host.generate('task-a', input())
  await host.resume('task-a', generated.jobId)
  const saved = await host.resume('task-a', generated.jobId)
  await current.export(generated.jobId, saved.outputs[0].outputId, '/native/export.mp4')
  assert.equal(imports, 1); assert.equal(exports, 1)
  await host.stopAll()
})

test('preview reads verified saved bytes and rejects output identities from another task', async () => {
  const f = await setup({ tracker: { floorMs: 1 } })
  const job = await f.host.generate('task-a', input())
  await f.host.track('task-a')
  const saved = (await f.host.getTaskVideo('task-a')).jobs[0]
  const preview = await f.host.preview('task-a', job.jobId, saved.outputs[0].outputId)
  assert.equal(preview.mime, 'video/mp4')
  assert.ok(preview.bytes)
  assert.equal(createHash('sha256').update(preview.bytes).digest('hex'), fixture.mediaFixture.sha256)
  await assert.rejects(f.host.preview('other-task', job.jobId, saved.outputs[0].outputId))
  await assert.rejects(f.host.preview('task-a', job.jobId, '../output'))
  await f.host.stopAll()
})

for (const change of ['disabled', 'empty-tools', 'missing-runtime'] as const) {
  test(`${change} capabilities preserve local previews, history and exports without waking recovery`, async () => {
    const f = await setup({ tracker: { floorMs: 1 } })
    const job = await f.host.generate('task-a', input())
    await f.host.track('task-a')
    const saved = (await f.host.getTaskVideo('task-a')).jobs[0]
    const calls = { ...f.gateway.calls }
    f.state.runtime = change === 'missing-runtime' ? undefined as unknown as typeof f.state.runtime
      : { ...f.state.runtime, executionAvailable: change !== 'disabled', tools: [] }
    const authorizations = f.state.authorizations
    let exported = 0
    const offline = new MockVideoHostService({ ...f.options,
      localRuntime: () => f.state.runtime,
      authorize: async () => { assert.fail('Local reads must not authorize over the network') },
      exportOutput: async (_scope, _task, _job, _output, _path, _signal, validate) => { validate(); exported++ },
    })
    const preview = await offline.preview('task-a', job.jobId, saved.outputs[0].outputId)
    assert.ok(preview.bytes)
    assert.equal((await offline.getTaskVideo('task-a')).jobs[0].saveStatus, 'SAVED')
    assert.deepEqual(await offline.getReferences('task-a'), [])
    const selection = await offline.nativeSelection('task-a')
    await selection.export(job.jobId, saved.outputs[0].outputId, '/native/saved.mp4')
    assert.equal(exported, 1)
    assert.equal(f.state.authorizations, authorizations)
    assert.deepEqual(f.gateway.calls, calls)
    await offline.stopAll(); await f.host.stopAll()
  })
}

test('stopTask cancels only its own approval and leaves sibling tracking and receipts intact', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const host = new MockVideoHostService({ ...f.options, tracker: { floorMs: 1 },
    requestApproval: async request => { if (request.taskId === 'stalled-task') { entered(); return new Promise<boolean>(() => undefined) }; return true },
  })
  const job = await host.generate('task-a', input())
  const rejected = assert.rejects(host.generate('stalled-task', input()))
  await waiting
  await host.stopTask('stalled-task')
  await rejected
  await host.track('task-a')
  assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  await host.stopAll()
})

test('startup recovery queries original pending jobs but never auto-resumes persisted grant failures', async context => {
  const f = await setup({ tracker: { floorMs: 1 } })
  const generated = await f.host.generate('task-a', input())
  await f.host.stopAll()
  const reopened = new MockVideoHostService({ ...f.options, tracker: { floorMs: 1 } })
  await reopened.resumePending(['task-a'])
  await reopened.track('task-a')
  assert.equal((await f.store.getJob(scope, 'task-a', generated.jobId))?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  await reopened.stopAll()
  await f.store.updateJob(scope, 'task-a', generated.jobId, job => ({ ...job, trackingStatus: 'AUTH_REQUIRED', error: 'PERMISSION_DENIED' }))
  const fresh = new MockVideoHostService(f.options)
  const tracker = context.mock.method(fresh, 'track', async () => { assert.fail('Startup must not resume a grant failure') })
  await fresh.resumePending(['task-a'])
  assert.equal(tracker.mock.callCount(), 0)
  assert.equal(f.gateway.calls.submit, 1)
  await fresh.stopAll()
})

test('separate run and IPC hosts cannot concurrently submit for the same task', async () => {
  const f = await setup()
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = new MockVideoHostService({ ...f.options, requestApproval: async () => { entered(); await gate; return true } })
  const second = new MockVideoHostService(f.options)
  const pending = first.generate('task-a', input())
  await waiting
  try {
    await assert.rejects(second.generate('task-a', input()), { code: 'CONFLICT' })
  } finally { release(); await pending; await first.stopAll(); await second.stopAll() }
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.gateway.calls.quote, 1)
})

test('runtime grant denial during automatic recovery persists pause until explicit resume', async () => {
  const f = await setup({ tracker: { floorMs: 1 } })
  const job = await f.host.generate('task-a', input())
  let revoked = true
  const host = new MockVideoHostService({ ...f.options, tracker: { floorMs: 1 }, authorize: async () => {
    if (revoked) throw new AppError('PERMISSION_DENIED')
    return f.state.runtime
  } })
  await host.track('task-a')
  assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.trackingStatus, 'AUTH_REQUIRED')
  revoked = false
  await host.track('task-a')
  assert.equal(f.gateway.calls.getReceipt, 0)
  await host.resume('task-a', job.jobId)
  await host.track('task-a')
  assert.equal((await host.getTaskVideo('task-a')).jobs[0].saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  await host.stopAll()
})

test('local projections fence ownership revision changes during cached runtime or reference lookup', async () => {
  const f = await setup()
  let revision = 1
  const changedRuntime = new MockVideoHostService({ ...f.options, authorizationRevision: () => revision,
    localRuntime: () => { revision++; return f.state.runtime },
  })
  await assert.rejects(changedRuntime.getTaskVideo('task-a'), { code: 'AUTH_REQUIRED' })
  const changedReference = new MockVideoHostService({ ...f.options, authorizationRevision: () => revision,
    references: { list: async () => { revision++; return [] }, import: async () => [] },
  })
  await assert.rejects(changedReference.getReferences('task-a'), { code: 'AUTH_REQUIRED' })
  await changedRuntime.stopAll(); await changedReference.stopAll()
})

test('catalog changes do not cancel local leases but identity revocation does', async () => {
  const f = await setup({ tracker: { floorMs: 1 } })
  const generated = await f.host.generate('task-a', input())
  await f.host.track('task-a')
  const saved = (await f.host.getTaskVideo('task-a')).jobs[0]
  let catalogRevision = 1, identityRevision = 1, exports = 0
  const host = new MockVideoHostService({ ...f.options,
    authorizationRevision: () => catalogRevision, localAuthorizationRevision: () => identityRevision,
    localRuntime: () => f.state.runtime,
    exportOutput: async (_scope, _task, _job, _output, _path, _signal, validate) => { validate(); exports++ },
  })
  const selection = await host.nativeSelection('task-a')
  catalogRevision++
  f.state.runtime = { ...f.state.runtime, executionAvailable: false, defaultProfileId: null, profiles: [], tools: [] }
  await selection.export(generated.jobId, saved.outputs[0].outputId, '/native/video.mp4')
  assert.equal(exports, 1)
  identityRevision++
  await assert.rejects(selection.export(generated.jobId, saved.outputs[0].outputId, '/native/video.mp4'), { code: 'AUTH_REQUIRED' })
  assert.equal(exports, 1)
  f.state.scope = null
  await assert.rejects(host.getTaskVideo('task-a'), { code: 'AUTH_REQUIRED' })
  assert.equal((await f.store.getJob(scope, 'task-a', generated.jobId))?.saveStatus, 'SAVED')
  await host.stopAll(); await f.host.stopAll()
})

test('real saved outputs reopen and export offline with unavailable generation runtime', async () => {
  const f = await realSetup()
  const generated = await f.host.generate('task-a', input())
  await f.host.resume('task-a', generated.jobId)
  const saved = await f.host.resume('task-a', generated.jobId)
  await f.host.stopAll()
  const calls = { ...f.gateway.calls }
  let opens = 0, exports = 0
  const host = new MockVideoHostService({ ...f.options,
    localRuntime: () => undefined,
    authorize: async () => { assert.fail('Offline delivery must not fetch runtime') },
    openOutput: async (_scope, _task, _job, _output, _signal, validate) => { validate(); opens++ },
    exportOutput: async (_scope, _task, _job, _output, _path, _signal, validate) => { validate(); exports++ },
  })
  assert.equal((await host.getTaskVideo('task-a')).runtime.executionAvailable, false)
  const result = await host.preview('task-a', generated.jobId, saved.outputs[0].outputId)
  assert.equal(result.opened, true)
  await (await host.nativeSelection('task-a')).export(generated.jobId, saved.outputs[0].outputId, '/native/video.mp4')
  assert.equal(opens, 1); assert.equal(exports, 1)
  assert.deepEqual(f.gateway.calls, calls)
  await host.stopAll()
})

test('original recovery accepts catalog changes, preserves frozen parameters, and persists server revocation', async () => {
  const f = await setup()
  const generated = await f.host.generate('task-a', input())
  const [original] = await f.store.listJobs(scope)
  await f.host.stopAll()
  let denied = true, recoveryChecks = 0, catalogRevision = 0
  const host = new MockVideoHostService({ ...f.options, localAuthorizationRevision: () => 1,
    authorizationRevision: () => catalogRevision,
    authorize: async () => { assert.fail('Recovery must not require current generation runtime') },
    authorizeRecovery: async id => { assert.equal(id, scope.subscriptionId); recoveryChecks++; catalogRevision++ },
    gateway: owner => ({ ...f.options.gateway(owner), getReceipt: async (id, signal) => {
      if (denied) throw new AppError('PERMISSION_DENIED')
      return f.gateway.getReceipt(id, signal)
    } }),
    tracker: { floorMs: 1 },
  })
  await host.track('task-a')
  assert.equal((await f.store.getJob(scope, 'task-a', generated.jobId))?.trackingStatus, 'AUTH_REQUIRED')
  const before = recoveryChecks
  denied = false
  await host.track('task-a')
  assert.equal(recoveryChecks, before)
  await host.resume('task-a', generated.jobId)
  await host.track('task-a')
  const [restored] = await f.store.listJobs(scope)
  assert.equal(restored.saveStatus, 'SAVED')
  assert.deepEqual(restored.request, original.request)
  assert.equal(restored.receipt?.receiptId, original.receipt?.receiptId)
  assert.equal(f.gateway.calls.quote, 1); assert.equal(f.gateway.calls.submit, 1)
  await host.stopAll()
})

test('fallback recovery permits a disabled runtime and never substitutes the new default profile', async () => {
  const f = await setup()
  const generated = await f.host.generate('task-a', input())
  const [original] = await f.store.listJobs(scope)
  f.state.runtime = { ...f.state.runtime, executionAvailable: false, defaultProfileId: null, profiles: [], tools: [] }
  await f.host.resume('task-a', generated.jobId)
  const saved = await f.host.resume('task-a', generated.jobId)
  assert.equal(saved.saveStatus, 'SAVED')
  assert.deepEqual((await f.store.listJobs(scope))[0].request, original.request)
  await assert.rejects(f.host.generate('task-a', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.gateway.calls.quote, 1); assert.equal(f.gateway.calls.submit, 1)
  await f.host.stopAll()
})

test('execution refresh is explicit and local history never silently refreshes it', async () => {
  const f = await setup()
  assert.equal((await f.host.getTaskVideo('task-a')).runtime.executionAvailable, false)
  assert.equal(f.state.authorizations, 0)
  const runtime = await f.host.authorizeExecution('task-a')
  assert.equal(runtime.executionAvailable, true)
  assert.equal(f.state.authorizations, 1)
  assert.equal((await f.host.getTaskVideo('task-a')).runtime.defaultProfileId, runtime.defaultProfileId)
  assert.equal(f.state.authorizations, 1)
  f.state.runtime = { ...f.state.runtime, executionAvailable: false, tools: [] }
  await assert.rejects(f.host.authorizeExecution('task-a'), { code: 'PERMISSION_DENIED' })
  assert.equal((await f.host.getTaskVideo('task-a')).runtime.executionAvailable, false)
  await f.host.stopAll()
})

test('native export rejects task rebinding while retaining the original local file', async () => {
  const f = await setup({ tracker: { floorMs: 1 } })
  const generated = await f.host.generate('task-a', input())
  await f.host.track('task-a')
  const saved = (await f.host.getTaskVideo('task-a')).jobs[0]
  let exports = 0
  const host = new MockVideoHostService({ ...f.options, exportOutput: async () => { exports++ } })
  const selection = await host.nativeSelection('task-a')
  f.state.subscriptionId = 'subscription-b'
  await assert.rejects(selection.export(generated.jobId, saved.outputs[0].outputId, '/native/video.mp4'), { code: 'AUTH_REQUIRED' })
  assert.equal(exports, 0)
  assert.equal((await f.store.getAsset(scope, 'task-a', generated.jobId, saved.outputs[0].outputId))?.status, 'SAVED')
  assert.deepEqual((await host.getTaskVideo('task-a')).jobs, [])
  await host.stopAll(); await f.host.stopAll()
})

for (const version of [1, 2] as const) {
  for (const mode of ['mock', 'real'] as const) {
    for (const allowed of [false, true]) {
      test(`v${version} ${mode} validates explicit audio=${allowed} without rewriting the frozen request`, async () => {
        const f = await setup()
        const profile = fixture.runtime.profiles[0]
        f.state.runtime = videoRuntimeSchema.parse({ ...fixture.runtime, protocolVersion: version, executionMode: mode,
          tools: ['video_generate', 'video_get_job'], profiles: [{ ...profile, operations: ['text-to-video'], capabilities: {
            ...profile.capabilities, supportsTextToVideo: true, supportsImageToVideo: false, maxReferenceCount: 0, supportsAudio: allowed,
            ...(version === 2 ? { audioModes: [allowed], defaultAudio: allowed, defaults: { ...fixture.quoteRequest.parameters, audio: allowed } } : {}),
          } }] })
        const quoted: boolean[] = [], submitted: boolean[] = []
        const mock = mode === 'mock'
        const host = new MockVideoHostService({ ...f.options, mock, gateway: owner => ({ ...f.options.gateway(owner),
          quote: async value => {
            quoted.push(value.parameters.audio!)
            return { quoteId: 'audio-quote', requestHash: 'a'.repeat(64), status: 'quoted' as const,
              expiresAt: Date.now() + 60_000, amount: mock ? '0.000000' : '0.900000', currency: mock ? 'MOCK' : 'CNY' }
          },
          submit: async (value): Promise<VideoReceipt> => {
            submitted.push(value.parameters.audio!)
            const receipt = { ...fixture.receipt, clientRequestId: value.clientRequestId, profileId: value.profileId, configVersion: value.configVersion,
              operation: value.operation }
            return mock
              ? videoReceiptSchema.parse({ ...receipt, mock: true, billingStatus: 'MOCK_NOT_CHARGED' })
              : videoReceiptSchema.parse({ ...receipt, mock: false, billingStatus: 'RESERVED', amountCny: '0.900000', amountUsd: '0.12' })
          },
        }) })
        const expected = version === 1 ? mode === 'real' ? [true] : allowed ? [false, true] : [false] : [allowed]
        for (const audio of [false, true]) {
          const value: VideoGenerationInput = { ...input(), operation: 'text-to-video', localAssetIds: [], parameters: { ...input().parameters, audio } }
          if (expected.includes(audio)) {
            const job = await host.generate('task-a', value)
            assert.equal(job.parameters.audio, audio)
            const stored = await f.store.getJob(scope, 'task-a', job.jobId)
            assert.equal(stored?.request.parameters.audio, audio)
          } else {
            const count = quoted.length
            await assert.rejects(host.generate('task-a', value), { code: 'INVALID_ARGUMENT' })
            assert.equal(quoted.length, count, 'Invalid audio must fail before quote or submit')
          }
          assert.equal(value.parameters.audio, audio)
        }
        assert.deepEqual(quoted, expected)
        assert.deepEqual(submitted, expected)
        await host.stopAll(); await f.host.stopAll()
      })
    }
  }
}

test('V3 tool preserves partial model specifications outside advisory capability lists', async () => {
  const f = await realSetup()
  f.state.runtime = videoRuntimeSchema.parse({ ...f.state.runtime, protocolVersion: 3,
    profiles: f.state.runtime.profiles.map(profile => ({ ...profile, operations: ['text-to-video'], capabilities: {
      ...fixture.runtime.profiles[0].capabilities, supportsTextToVideo: true,
      durationsSeconds: [], aspectRatios: [], resolutions: [], frameRates: [], outputFormats: [], audioModes: [],
    } })), tools: ['video_generate', 'video_get_job'] })
  const requestedSpec = { durationSeconds: 720, aspectRatio: '9:16', resolution: '8k', audio: false }
  const metadata = { protocolVersion: 3, specRevision: 2, parameterSources: { durationSeconds: 'model', aspectRatio: 'user', resolution: 'model', audio: 'user' } }
  let quotes = 0, submits = 0
  const base = f.options.gateway(scope)
  const host = new MockVideoHostService({ ...f.options, gateway: () => ({ ...base,
    quote: async request => { quotes++; assert.equal('requirementId' in request, false); assert.deepEqual(request.parameters, requestedSpec); assert.deepEqual(request.requestedSpec, requestedSpec)
      return { protocolVersion: 3, specRevision: 2, effectiveSpec: requestedSpec, quoteId: 'v3-quote', requestHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000, status: 'quoted', amount: '0.900000', currency: 'CNY' } },
    submit: async request => { submits++; assert.deepEqual(request.requestedSpec, requestedSpec)
      return { ...realReceipt(videoReceiptSchema.parse(fixture.receipt)), protocolVersion: 3, semanticHashVersion: 3, specRevision: 2, effectiveSpec: requestedSpec,
        billingDimensions: { model: 'provider-video-v1', operation: 'text-to-video', durationSeconds: requestedSpec.durationSeconds, resolution: requestedSpec.resolution }, deliveryStatus: 'matched',
        clientRequestId: request.clientRequestId, profileId: request.profileId, configVersion: request.configVersion, operation: request.operation } },
  }) })
  const raw = { creativeBrief: 'portrait cinematic story', requirementId: 'video-requirement', localAssetIds: [], requestedSpec, ...metadata }
  const job = await host.generateTool('task-a', 'video_generate', raw)
  assert.deepEqual(job.requestedSpec, requestedSpec)
  assert.equal(job.parameters.audio, false)
  assert.equal('frameRate' in job.parameters, false)
  assert.equal(quotes, 1); assert.equal(submits, 1)
  await assert.rejects(host.generateTool('task-a', 'video_generate', { creativeBrief: 'missing spec', localAssetIds: [] }), (error: unknown) => error instanceof AppError && error.code === 'MISSING_SPEC')
  await assert.rejects(host.generateTool('task-a', 'video_generate', { ...raw, parameterSources: { frameRate: 'model' } }), (error: unknown) => error instanceof AppError && error.code === 'SPEC_CONFLICT')
  assert.equal(quotes, 1)
  await host.stopAll()
})

test('legacy video tools require complete explicit specifications and reject V3 negotiation', async () => {
  const f = await setup()
  const raw = { creativeBrief: 'make a video', localAssetIds: ['asset-a'] }
  await assert.rejects(f.host.generateTool('task-a', 'video_from_image', raw), (error: unknown) => error instanceof AppError && error.code === 'MISSING_SPEC')
  await assert.rejects(f.host.generateTool('task-a', 'video_from_image', { ...raw, protocolVersion: 3, specRevision: 1, parameterSources: {}, requestedSpec: {} }), (error: unknown) => error instanceof AppError && error.code === 'UPGRADE_REQUIRED')
  assert.equal(f.gateway.calls.quote, 0)
  await f.host.stopAll()
})

test('V3 submit failures expose persisted diagnostics while host recovery blocks another paid generation', async () => {
  const f = await realSetup()
  f.state.runtime = videoRuntimeSchema.parse({ ...fixture.runtime, protocolVersion: 3, executionMode: 'real',
    profiles: fixture.runtime.profiles.map(profile => ({ ...profile, operations: ['text-to-video'], capabilities: { ...profile.capabilities, supportsTextToVideo: true } })),
    tools: ['video_generate', 'video_get_job'] })
  const spec = { resolution: '8k' }
  let quotes = 0, submissions = 0
  const remote = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: scope.subscriptionId, token: async () => 'test-token', fetch: async () => {
    submissions++
    return new Response(JSON.stringify({ error: { code: 'UPSTREAM_SPEC_UNSUPPORTED', field: 'resolution', requestedValue: '8k', source: 'provider',
      alternatives: [{ resolution: '1080p' }], submissionState: 'not_submitted', billingState: 'not_reserved', message: 'private-secret' } }), { status: 422, headers: { 'Content-Type': 'application/json' } })
  } })
  const options: MockVideoHostOptions = { ...f.options, gateway: () => ({ ...f.options.gateway(scope),
    quote: async () => { quotes++; return { protocolVersion: 3, specRevision: 2, effectiveSpec: spec, quoteId: 'v3-quote', requestHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000, status: 'quoted', amount: '0.900000', currency: 'CNY' } },
    submit: remote.submit.bind(remote), findReceipt: async () => null,
  }) }
  const raw = { creativeBrief: 'cinematic product story', protocolVersion: 3, specRevision: 2, requestedSpec: spec, parameterSources: { resolution: 'user' } }
  const host = new MockVideoHostService(options)
  const first = await host.generateTool('task-a', 'video_generate', raw)
  assert.equal(first.generationStatus, 'SUBMISSION_UNKNOWN'); assert.equal(first.billingStatus, 'RECONCILING')
  assert.equal(first.specFailure?.requestedValue, '8k'); assert.deepEqual(first.specFailure?.alternatives, [{ resolution: '1080p' }])
  await assert.rejects(host.generateTool('task-a', 'video_generate', raw), { code: 'CONFLICT' })
  await host.stopAll()
  const reopened = new MockVideoHostService(options)
  const saved = (await reopened.getTaskVideo('task-a')).jobs.find(job => job.jobId === first.jobId)!
  assert.deepEqual(saved.specFailure, first.specFailure)
  await assert.rejects(reopened.generateTool('task-a', 'video_generate', { ...raw, specRevision: 3, requestedSpec: { resolution: '1080p' } }), { code: 'CONFLICT' })
  assert.equal(quotes, 1); assert.equal(submissions, 1)
  assert.doesNotMatch(JSON.stringify(saved), /private-secret/)
  await reopened.stopAll()
})
