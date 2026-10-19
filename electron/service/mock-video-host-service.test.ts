import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import type { VideoGenerationInput } from '../../src/shared/video-host'
import { videoRuntimeSchema } from '../../src/shared/video-media'
import { MockVideoMediaGateway } from '../data/mock-video-media-gateway'
import { VideoStore } from '../data/video-store'
import type { VideoScope } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'

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
  return { state, store, gateway, approvals, options, host: new MockVideoHostService(options) }
}

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
  await assert.rejects(f.host.generate('task-a', { ...input(), parameters: { ...input().parameters, audio: true } }), { code: 'PERMISSION_DENIED' })
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
  await assert.rejects(host.resume('task-a', job.jobId), { code: 'PERMISSION_DENIED' })
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
  let approvals = 0, postApprovalAuthorizations = 0
  const host = new MockVideoHostService({ ...f.options,
    requestApproval: async () => { approvals++; return true },
    authorize: async () => {
      if (approvals === 2 && ++postApprovalAuthorizations === 2) f.state.subscriptionId = 'subscription-b'
      return f.state.runtime
    },
  })
  await host.generate('task-a', input())
  assert.equal(f.gateway.calls.submit, 0)
  assert.equal((await f.store.listJobs(scope))[0].trackingStatus, 'AUTH_REQUIRED')
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
