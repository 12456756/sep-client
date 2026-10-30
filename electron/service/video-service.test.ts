import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MockVideoMediaGateway, MOCK_VIDEO_BYTES, MOCK_VIDEO_SHA256, type MockVideoScenario } from '../data/mock-video-media-gateway'
import { VideoStore } from '../data/video-store'
import { VideoFiles } from '../data/video-files'
import { VideoService } from './video-service'
import type { LocalVideoJob, VideoScope } from '../domain/video-media'
import type { VideoGatewayPort, VideoReceipt } from '../../src/shared/video-media'
import { ScopePath, encodeTaskScopeSegment } from '../data/scope-path'
import { AppError } from '../errors/app-error'
import { SepRealVideoGateway } from '../data/sep-video-media-gateway'

const scope: VideoScope = { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function input() {
  return { profileId: 'mock-video-from-image', configVersion: 'mock-video-v1', operation: 'image-to-video' as const, referenceIds: ['reference-a'],
    creativeBrief: 'Product animation', parameters: { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p' as const, frameRate: 24, audio: false, outputFormat: 'video/mp4' as const } }
}
async function fixture(scenario: MockVideoScenario = 'success') {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-service-'))
  directories.push(directory)
  const root = join(directory, 'user-data')
  const store = new VideoStore(root)
  const gateway = new MockVideoMediaGateway(scenario)
  const service = new VideoService({ scope, store, gateway })
  const rebuilt = (port: VideoGatewayPort = gateway) => new VideoService({ scope, store: new VideoStore(root), gateway: port })
  const task = join(new ScopePath(root).ownerRoot(scope), 'video', 'v1', encodeTaskScopeSegment(scope.subscriptionId, 'subscriptionId'), 'tasks', 'task-a')
  return { directory, root, task, store, gateway, service, rebuilt }
}

async function finish(service: VideoService, job: LocalVideoJob): Promise<LocalVideoJob> {
  for (let poll = 0; poll < 4 && job.receipt && ['QUEUED', 'RUNNING'].includes(job.receipt.status); poll++) {
    job = await service.resume(job.taskId, job.jobId)
  }
  assert.equal(job.receipt?.status, 'SUCCEEDED')
  return job
}

describe('VideoService mock submission, disk recovery and original delivery', () => {
  for (const [code, status] of [['INSUFFICIENT_FUNDS', 402], ['VIDEO_BUDGET_EXCEEDED', 402], ['QUOTE_EXPIRED', 409], ['VIDEO_CONCURRENCY_LIMIT', 409]] as const) {
    it(`persists definitive ${code} across restarts without querying or resubmitting`, async () => {
      const f = await fixture()
      let submissions = 0
      const rejected = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: scope.subscriptionId,
        token: async () => 'test-token', fetch: async () => {
          submissions++
          return new Response(JSON.stringify({ error: { code, source: 'platform', requestId: 'req-rejected-1', message: 'private response must not persist' } }),
            { status, headers: { 'Content-Type': 'application/json' } })
        } })
      const gateway: VideoGatewayPort = {
        quote: async (value, signal) => ({ ...await f.gateway.quote(value, signal), currency: 'CNY', amount: '28.800000' }),
        submit: rejected.submit.bind(rejected), findReceipt: f.gateway.findReceipt.bind(f.gateway),
        getReceipt: f.gateway.getReceipt.bind(f.gateway), content: f.gateway.content.bind(f.gateway),
      }
      const reopen = () => new VideoService({ scope, executionMode: 'real', store: new VideoStore(f.root), gateway })
      const first = await reopen().generate('task-a', input())
      assert.equal(first.error, code)
      assert.equal(first.trackingStatus, 'STOPPED')
      assert.equal(first.submission, 'MAYBE_SENT')
      assert.equal(first.receipt, null)
      const restored = reopen()
      const [recovered] = await restored.recover()
      assert.deepEqual(recovered, first)
      assert.deepEqual(await restored.resume('task-a', first.jobId), first)
      await assert.rejects(restored.submit('task-a', first.jobId), /already/)
      assert.equal(submissions, 1)
      assert.equal(f.gateway.calls.quote, 1)
      assert.equal(f.gateway.calls.findReceipt, 0)
      assert.equal(f.gateway.calls.getReceipt, 0)
      assert.doesNotMatch(JSON.stringify(first.error), /private/)
    })
  }

  it('preserves a legacy rejection code but keeps querying when the response cannot prove platform rejection', async () => {
    const f = await fixture()
    let submissions = 0
    const rejected = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: scope.subscriptionId,
      token: async () => 'test-token', fetch: async () => {
        submissions++
        return new Response(JSON.stringify({ error: { code: 'VIDEO_BUDGET_EXCEEDED' } }),
          { status: 402, headers: { 'Content-Type': 'application/json' } })
      } })
    const gateway: VideoGatewayPort = {
      quote: async (value, signal) => ({ ...await f.gateway.quote(value, signal), currency: 'CNY', amount: '28.800000' }),
      submit: rejected.submit.bind(rejected), findReceipt: f.gateway.findReceipt.bind(f.gateway),
      getReceipt: f.gateway.getReceipt.bind(f.gateway), content: f.gateway.content.bind(f.gateway),
    }
    const service = new VideoService({ scope, executionMode: 'real', store: f.store, gateway })
    const first = await service.generate('task-a', input())
    assert.equal(first.error, 'VIDEO_BUDGET_EXCEEDED')
    assert.equal(first.trackingStatus, 'INTERRUPTED')
    const restored = new VideoService({ scope, executionMode: 'real', store: new VideoStore(f.root), gateway })
    const [job] = await restored.recover()
    assert.equal(job.error, 'VIDEO_BUDGET_EXCEEDED')
    assert.equal(job.trackingStatus, 'INTERRUPTED')
    assert.equal(job.submission, 'MAYBE_SENT')
    assert.equal(f.gateway.calls.findReceipt, 1)
    assert.equal(submissions, 1)
  })

  it('keeps authorization denial recoverable because funds may already be reserved', async () => {
    const f = await fixture()
    const denied = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: scope.subscriptionId,
      token: async () => 'test-token', fetch: async () => new Response(JSON.stringify({ error: { code: 'MEDIA_FORBIDDEN', source: 'platform' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }) })
    const real = (value: VideoReceipt): VideoReceipt => ({ ...value, mock: false, billingStatus: 'RESERVED' })
    const gateway: VideoGatewayPort = {
      quote: async (value, signal) => ({ ...await f.gateway.quote(value, signal), currency: 'CNY', amount: '28.800000' }),
      submit: async (value, signal) => { await f.gateway.submit(value, signal); return denied.submit(value, signal) },
      findReceipt: async (id, signal) => { const receipt = await f.gateway.findReceipt(id, signal); return receipt && real(receipt) },
      getReceipt: async (id, signal) => real(await f.gateway.getReceipt(id, signal)), content: f.gateway.content.bind(f.gateway),
    }
    const service = new VideoService({ scope, executionMode: 'real', store: f.store, gateway })
    const first = await service.generate('task-a', input())
    assert.equal(first.error, 'MEDIA_FORBIDDEN')
    assert.equal(first.trackingStatus, 'INTERRUPTED')
    await service.recover()
    assert.equal(f.gateway.calls.findReceipt, 1, 'post-reservation authorization errors must reconcile the original receipt')
    const found = await service.resume('task-a', first.jobId)
    assert.equal(found.submission, 'RECEIPTED')
    assert.equal(found.receipt?.billingStatus, 'RESERVED')
    assert.equal(f.gateway.calls.findReceipt, 1)
    assert.equal(f.gateway.calls.submit, 1)
  })

  it('reopens a saved real output and reconciles RESERVED then RECONCILING without regeneration or redownload', async () => {
    const f = await fixture()
    let terminalQueries = 0
    const real = (receipt: VideoReceipt): VideoReceipt => {
      const delivered = receipt.status === 'SUCCEEDED'
      const billingStatus = !delivered || terminalQueries === 1 ? 'RESERVED' : terminalQueries === 2 ? 'RECONCILING' : 'SETTLED'
      return { ...receipt, mock: false, billingStatus, outputs: receipt.outputs.map(output => ({ ...output, width: 1344, height: 768, durationSeconds: 4.458333, frameRate: 24 })),
        recovery: { ...receipt.recovery, canQuery: billingStatus !== 'SETTLED' }, amountCny: '0.900000', amountUsd: '0.12', ...(billingStatus === 'SETTLED' ? { actualCostCny: '0.800000' } : {}) }
    }
    const gateway: VideoGatewayPort = {
      quote: async (request, signal) => ({ ...await f.gateway.quote(request, signal), amount: '0.900000', currency: 'CNY' }),
      submit: async (request, signal) => real(await f.gateway.submit(request, signal)),
      findReceipt: async (id, signal) => { const receipt = await f.gateway.findReceipt(id, signal); return receipt ? real(receipt) : null },
      getReceipt: async (id, signal) => { const receipt = await f.gateway.getReceipt(id, signal); if (receipt.status === 'SUCCEEDED') terminalQueries++; return real(receipt) },
      content: f.gateway.content.bind(f.gateway),
    }
    const reopen = () => new VideoService({ scope, executionMode: 'real', store: new VideoStore(f.root), gateway })
    const service = reopen()
    const original = await service.generate('task-a', input())
    await service.resume('task-a', original.jobId)
    const saved = await service.resume('task-a', original.jobId)
    assert.equal(saved.receipt?.status, 'SUCCEEDED'); assert.equal(saved.receipt?.billingStatus, 'RESERVED')
    assert.equal(saved.saveStatus, 'SAVED'); assert.equal(saved.trackingStatus, 'ACTIVE')
    assert.equal(typeof saved.providerWaitMs, 'number')
    const firstProviderWaitMs = saved.providerWaitMs
    service.close()
    const restored = reopen()
    const [pending] = await restored.recover()
    assert.equal(pending.receipt?.billingStatus, 'RECONCILING'); assert.equal(pending.trackingStatus, 'ACTIVE')
    assert.equal(pending.receipt?.receiptId, saved.receipt?.receiptId)
    const settled = await restored.resume('task-a', original.jobId)
    assert.equal(settled.receipt?.billingStatus, 'SETTLED'); assert.equal(settled.trackingStatus, 'STOPPED')
    assert.equal(settled.providerWaitMs, firstProviderWaitMs)
    assert.equal(settled.receipt?.outputs[0].durationSeconds, 4.458333)
    assert.equal(settled.receipt?.outputs[0].width, 1344); assert.equal(settled.receipt?.outputs[0].height, 768)
    assert.equal(settled.request.parameters.durationSeconds, 5)
    const queries = f.gateway.calls.getReceipt
    await restored.recover()
    assert.equal(f.gateway.calls.getReceipt, queries)
    assert.equal(f.gateway.calls.submit, 1); assert.equal(f.gateway.calls.quote, 1); assert.equal(f.gateway.calls.content, 1)
    restored.close()
  })
  for (const scenario of ['failed', 'partial', 'submission-unknown', 'expired', 'rejected', 'corrupt-download'] as const) {
    it(`restores the ${scenario} gateway scenario from disk without another submission`, async () => {
      const f = await fixture(scenario)
      const first = await f.service.generate('task-a', input())
      const reopened = f.rebuilt()
      let [job] = await reopened.recover()
      for (let poll = 0; poll < 4 && (!job.receipt || ['QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(job.receipt.status)); poll++) {
        job = await reopened.resume('task-a', job.jobId)
      }
      assert.equal(job.request.clientRequestId, first.request.clientRequestId)
      assert.equal(f.gateway.calls.submit, 1)
      assert.equal(f.gateway.calls.quote, 1)
      if (scenario === 'failed') { assert.equal(job.receipt?.status, 'FAILED'); assert.notEqual(job.saveStatus, 'SAVED'); assert.equal(f.gateway.calls.content, 0) }
      if (scenario === 'partial') { assert.equal(job.receipt?.status, 'PARTIAL_SUCCEEDED'); assert.equal(job.saveStatus, 'SAVED') }
      if (scenario === 'submission-unknown') { assert.equal(job.receipt?.status, 'SUCCEEDED'); assert.equal(job.saveStatus, 'SAVED'); assert.equal(f.gateway.calls.findReceipt, 1) }
      if (scenario === 'expired') { assert.equal(job.receipt?.status, 'RESULT_EXPIRED'); assert.equal(job.saveStatus, 'SAVE_FAILED'); assert.equal(f.gateway.calls.content, 0) }
      if (scenario === 'rejected') { assert.equal(job.receipt, null); assert.equal(job.submission, 'MAYBE_SENT'); assert.notEqual(job.saveStatus, 'SAVED') }
      if (scenario === 'corrupt-download') { assert.equal(job.receipt?.status, 'SUCCEEDED'); assert.equal(job.saveStatus, 'SAVE_FAILED'); assert.deepEqual(await reopened.listAssets('task-a'), []) }
    })
  }

  for (const code of ['AUTH_REQUIRED', 'PERMISSION_DENIED', 'RATE_LIMITED', 'NETWORK_ERROR'] as const) {
    it(`persists safe ${code} query state without losing the original receipt`, async context => {
      const f = await fixture()
      const initial = await f.service.generate('task-a', input())
      const unavailable = context.mock.method(f.gateway, 'getReceipt', async () => { throw new AppError(code, { message: 'sensitive upstream detail must not persist' }) })
      const job = await f.service.resume('task-a', initial.jobId)
      assert.equal(job.error, code)
      assert.deepEqual(job.receipt, initial.receipt)
      assert.equal(job.trackingStatus, code === 'AUTH_REQUIRED' || code === 'PERMISSION_DENIED' ? 'AUTH_REQUIRED' : 'INTERRUPTED')
      const before = unavailable.mock.callCount()
      await f.rebuilt().recover()
      if (job.trackingStatus === 'AUTH_REQUIRED') assert.equal(unavailable.mock.callCount(), before)
      unavailable.mock.restore()
      // Explicit resume can retry queries after authorization has been restored.
      assert.equal((await finish(f.rebuilt(), await f.rebuilt().resume('task-a', initial.jobId))).saveStatus, 'SAVED')
      assert.equal(f.gateway.calls.submit, 1)
    })
  }

  for (const [error, code] of [[new Error('Request timed out.'), 'NETWORK_TIMEOUT'], [Object.assign(new Error('private network diagnostics'), { code: 'ECONNRESET' }), 'NETWORK_ERROR']] as const) {
    it(`preserves typed transport ${code} while keeping the original receipt`, async context => {
      const f = await fixture()
      const initial = await f.service.generate('task-a', input())
      context.mock.method(f.gateway, 'getReceipt', async () => { throw error })
      const job = await f.service.resume('task-a', initial.jobId)
      assert.equal(job.error, code)
      assert.equal(job.trackingStatus, 'INTERRUPTED')
      assert.deepEqual(job.receipt, initial.receipt)
      assert.equal(f.gateway.calls.submit, 1)
    })
  }

  it('requires explicit save retry after download authorization is lost and recovers only original bytes', async context => {
    const f = await fixture()
    const denied = context.mock.method(f.gateway, 'content', async () => { throw new AppError('AUTH_REQUIRED') })
    const job = await finish(f.service, await f.service.generate('task-a', input()))
    assert.equal(job.saveStatus, 'SAVE_FAILED')
    assert.equal(job.trackingStatus, 'AUTH_REQUIRED')
    const before = denied.mock.callCount()
    await f.rebuilt().recover()
    assert.equal(denied.mock.callCount(), before)
    denied.mock.restore()
    const restored = await f.rebuilt().retrySave('task-a', job.jobId)
    assert.equal(restored.saveStatus, 'SAVED')
    assert.equal(restored.trackingStatus, 'STOPPED')
    assert.deepEqual(restored.receipt, job.receipt)
    assert.equal(f.gateway.calls.submit, 1)
  })

  it('rechecks AUTH_REQUIRED under the lock when automatic recoveries overlap', async context => {
    const f = await fixture()
    await f.service.generate('task-a', input())
    const denied = context.mock.method(f.gateway, 'getReceipt', async () => { throw new AppError('AUTH_REQUIRED') })
    const restored = await Promise.all([f.rebuilt().recover(), f.rebuilt().recover()])
    assert.equal(denied.mock.callCount(), 1)
    assert.equal(restored[0][0].trackingStatus, 'AUTH_REQUIRED')
    assert.equal(restored[1][0].trackingStatus, 'AUTH_REQUIRED')
  })

  it('quotes -> persists -> submits -> polls -> saves -> reconstructs without generating or downloading twice', async () => {
    const f = await fixture()
    const submitted = await f.service.generate('task-a', input())
    assert.equal(submitted.submission, 'RECEIPTED')
    assert.equal(submitted.receipt?.status, 'QUEUED')
    const done = await finish(f.service, submitted)
    assert.equal(done.saveStatus, 'SAVED')
    const asset = (await f.service.listAssets('task-a'))[0]
    assert.equal(asset.output.sha256, MOCK_VIDEO_SHA256)
    assert.equal(asset.output.byteLength, MOCK_VIDEO_BYTES.length)
    assert.deepEqual(await f.store.readAsset(scope, 'task-a', done.jobId, asset.output.outputId), MOCK_VIDEO_BYTES)
    f.service.close()
    const calls = { ...f.gateway.calls }
    const reopened = f.rebuilt()
    const [restored] = await reopened.recover()
    assert.deepEqual(restored.request, done.request)
    assert.deepEqual(restored.receipt, done.receipt)
    assert.equal(restored.saveStatus, 'SAVED')
    assert.deepEqual(f.gateway.calls, calls)
    assert.deepEqual(await reopened.listAssets('task-a'), [asset])
  })

  for (const code of ['AUTH_REQUIRED', 'PERMISSION_DENIED'] as const) {
    it(`pauses the whole scope after ${code} without querying sibling jobs on recovery`, async context => {
      const f = await fixture()
      await f.service.generate('task-a', input())
      await f.service.generate('task-b', input())
      const denied = context.mock.method(f.gateway, 'getReceipt', async () => { throw new AppError(code) })
      const results = await Promise.all([f.rebuilt().recover(), f.rebuilt().recover()])
      assert.equal(denied.mock.callCount(), 1)
      for (const jobs of results) assert.ok(jobs.every(job => job.trackingStatus === 'AUTH_REQUIRED'))
      await f.rebuilt().recover()
      assert.equal(denied.mock.callCount(), 1)
      denied.mock.restore()
      for (const job of results[0]) await f.rebuilt().resume(job.taskId, job.jobId)
      const restored = await f.rebuilt().recover()
      assert.ok(restored.every(job => job.saveStatus === 'SAVED'))
      assert.equal(f.gateway.calls.submit, 2)
    })
  }

  it('freezes inputs before quote/submit and accepts an opaque server semantic hash', async context => {
    const f = await fixture()
    const quote = f.gateway.quote.bind(f.gateway)
    context.mock.method(f.gateway, 'quote', async (...args: Parameters<typeof quote>) => ({ ...await quote(...args), requestHash: 'a'.repeat(64) }))
    const mutable = input()
    const job = await f.service.prepare('task-a', mutable)
    assert.notEqual(job.quote.requestHash, createHash('sha256').update(JSON.stringify(mutable)).digest('hex'))
    mutable.creativeBrief = 'Changed after confirmation'; mutable.parameters.durationSeconds = 10; mutable.referenceIds.push('other')
    job.request.creativeBrief = 'Changed returned object'
    const originalSubmit = f.gateway.submit.bind(f.gateway)
    context.mock.method(f.gateway, 'submit', async (request: Parameters<typeof originalSubmit>[0], signal: AbortSignal) => {
      const persisted = await new VideoStore(f.root).getJob(scope, 'task-a', job.jobId)
      assert.equal(persisted?.submission, 'MAYBE_SENT')
      assert.deepEqual(persisted?.request, request)
      assert.equal(request.creativeBrief, 'Product animation')
      assert.equal(request.parameters.durationSeconds, 5)
      assert.deepEqual(request.referenceIds, ['reference-a'])
      return originalSubmit(request, signal)
    })
    assert.equal((await f.service.submit('task-a', job.jobId)).submission, 'RECEIPTED')
  })

  it('does not submit when initial persistence or MAYBE_SENT persistence fails', async context => {
    const f = await fixture()
    const create = context.mock.method(f.store, 'createJob', async () => { throw new Error('disk full') })
    await assert.rejects(f.service.generate('task-a', input()), /disk full/)
    assert.equal(f.gateway.calls.submit, 0)
    create.mock.restore()
    const job = await f.service.prepare('task-a', input())
    const update = context.mock.method(f.store, 'updateJob', async () => { throw new Error('marker not durable') })
    try { await assert.rejects(f.service.submit('task-a', job.jobId), /not durable/) } finally { update.mock.restore() }
    assert.equal(f.gateway.calls.submit, 0)
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.submission, 'NOT_SENT')
  })

  it('queries original client ID after a lost submit response and never submits it again', async context => {
    const f = await fixture()
    const submit = f.gateway.submit.bind(f.gateway)
    const losing = context.mock.method(f.gateway, 'submit', async (...args: Parameters<typeof submit>) => { await submit(...args); throw new Error('response lost') })
    const unknown = await f.service.generate('task-a', input())
    assert.equal(unknown.submission, 'MAYBE_SENT')
    assert.equal(unknown.error, 'SUBMISSION_UNKNOWN')
    losing.mock.restore()
    f.service.close()
    const reopened = f.rebuilt()
    const [found] = await reopened.recover()
    assert.equal(found.request.clientRequestId, unknown.request.clientRequestId)
    assert.equal(found.submission, 'RECEIPTED')
    await finish(reopened, found)
    assert.equal(f.gateway.calls.findReceipt, 1)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.gateway.calls.quote, 1)
    await assert.rejects(reopened.submit(found.taskId, found.jobId), /already/)
  })

  it('keeps an unfindable submission unknown across restarts with no automatic POST', async context => {
    const f = await fixture()
    const job = await f.service.prepare('task-a', input())
    context.mock.method(f.gateway, 'submit', async () => { throw new Error('no response') })
    const unknown = await f.service.submit('task-a', job.jobId)
    assert.equal(unknown.receipt, null)
    for (let restart = 0; restart < 3; restart++) {
      const [restored] = await f.rebuilt().recover()
      assert.equal(restored.submission, 'MAYBE_SENT')
      assert.equal(restored.error, 'SUBMISSION_UNKNOWN')
      assert.equal(restored.receipt, null)
    }
    assert.equal(f.gateway.calls.quote, 1)
    assert.equal(f.gateway.calls.findReceipt, 3)
    assert.equal(f.gateway.calls.content, 0)
  })

  it('does not auto-submit NOT_SENT jobs after a restart', async () => {
    const f = await fixture()
    const prepared = await f.service.prepare('task-a', input())
    const [recovered] = await f.rebuilt().recover()
    assert.deepEqual(recovered.request, prepared.request)
    assert.equal(recovered.submission, 'NOT_SENT')
    assert.equal(recovered.trackingStatus, 'STOPPED')
    assert.equal(recovered.error, 'NOT_SUBMITTED')
    assert.equal(f.gateway.calls.submit, 0)
    assert.equal(f.gateway.calls.findReceipt, 0)
  })

  it('recovers a failed receipt write by lookup without losing the original server identity', async context => {
    const f = await fixture()
    const job = await f.service.prepare('task-a', input())
    const update = f.store.updateJob.bind(f.store)
    const failing = context.mock.method(f.store, 'updateJob', async (...args: Parameters<typeof update>) => {
      const current = await f.store.getJob(scope, args[1], args[2])
      if (current?.submission === 'MAYBE_SENT') throw new Error('receipt write failed')
      return update(...args)
    })
    try { await assert.rejects(f.service.submit('task-a', job.jobId), /receipt write/) } finally { failing.mock.restore() }
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.submission, 'MAYBE_SENT')
    const [recovered] = await f.rebuilt().recover()
    assert.equal(recovered.receipt?.clientRequestId, job.request.clientRequestId)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.gateway.calls.findReceipt, 1)
  })

  it('restarts queued/running tasks by original receipt ID without another quote or submit', async () => {
    const f = await fixture()
    const job = await f.service.generate('task-a', input())
    f.service.close()
    const reopened = f.rebuilt()
    const [running] = await reopened.recover()
    assert.equal(running.receipt?.status, 'RUNNING')
    assert.equal(running.receipt?.receiptId, job.receipt?.receiptId)
    assert.equal((await finish(reopened, running)).saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.gateway.calls.findReceipt, 0)
  })

  it('persists SAVE_FAILED and retries only content after interrupted local saving', async context => {
    const f = await fixture()
    const original = f.gateway.content.bind(f.gateway)
    const failing = context.mock.method(f.gateway, 'content', async (...args: Parameters<typeof original>) => {
      await original(...args)
      return (async function* () { yield MOCK_VIDEO_BYTES.subarray(0, 5); throw new Error('download interrupted') })()
    })
    const done = await finish(f.service, await f.service.generate('task-a', input()))
    assert.equal(done.saveStatus, 'SAVE_FAILED')
    assert.equal((await new VideoStore(f.root).getJob(scope, 'task-a', done.jobId))?.saveStatus, 'SAVE_FAILED')
    failing.mock.restore()
    const before = { ...f.gateway.calls }
    const saved = await f.rebuilt().retrySave('task-a', done.jobId)
    assert.equal(saved.saveStatus, 'SAVED')
    assert.deepEqual(saved.receipt, done.receipt)
    assert.equal(f.gateway.calls.content, before.content + 1)
    assert.equal(f.gateway.calls.submit, before.submit)
    assert.equal(f.gateway.calls.quote, before.quote)
    assert.equal(f.gateway.calls.getReceipt, before.getReceipt)
  })

  it('handles PARTIAL_SUCCEEDED as original deliverable outputs without regenerating absent ones', async context => {
    const f = await fixture()
    const get = f.gateway.getReceipt.bind(f.gateway)
    context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof get>) => {
      const receipt = await get(...args)
      return receipt.status === 'SUCCEEDED' ? { ...receipt, status: 'PARTIAL_SUCCEEDED' as const, errorCode: 'ONE_OUTPUT_FAILED' } : receipt
    })
    let job = await f.service.generate('task-a', input())
    job = await f.service.resume('task-a', job.jobId)
    job = await f.service.resume('task-a', job.jobId)
    assert.equal(job.receipt?.status, 'PARTIAL_SUCCEEDED')
    assert.equal(job.saveStatus, 'SAVED')
    assert.equal(job.error, 'ONE_OUTPUT_FAILED')
    const before = { ...f.gateway.calls }
    const [restored] = await f.rebuilt().recover()
    assert.deepEqual(restored.receipt, job.receipt)
    assert.deepEqual(f.gateway.calls, before)
  })

  it('saves partial output sets independently and retries only missing outputs', async context => {
    const f = await fixture()
    const get = f.gateway.getReceipt.bind(f.gateway)
    context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof get>) => {
      const receipt = await get(...args)
      if (receipt.status === 'SUCCEEDED') receipt.outputs.push({ ...receipt.outputs[0], outputId: 'second-output' })
      return receipt
    })
    const content = f.gateway.content.bind(f.gateway)
    const failing = context.mock.method(f.gateway, 'content', async (...args: Parameters<typeof content>) => {
      if (args[1] === 'second-output') throw new Error('second output download failed')
      return content(...args)
    })
    const done = await finish(f.service, await f.service.generate('task-a', input()))
    assert.equal(done.saveStatus, 'SAVE_FAILED')
    assert.equal((await f.service.listAssets('task-a')).length, 1)
    failing.mock.restore()
    let downloads = 0
    context.mock.method(f.gateway, 'content', async (receiptId: string, outputId: string, signal: AbortSignal) => {
      assert.equal(outputId, 'second-output'); assert.equal(receiptId, done.receipt?.receiptId); signal.throwIfAborted(); downloads++
      return (async function* () { yield MOCK_VIDEO_BYTES })()
    })
    assert.equal((await f.rebuilt().retrySave('task-a', done.jobId)).saveStatus, 'SAVED')
    assert.equal(downloads, 1)
    assert.equal(f.gateway.calls.submit, 1)
  })

  it('delivers the available sibling when another original output expired', async () => {
    const f = await fixture('partial-expired')
    let job = await f.service.generate('task-a', input())
    job = await f.service.resume('task-a', job.jobId)
    job = await f.service.resume('task-a', job.jobId)
    assert.equal(job.receipt?.status, 'PARTIAL_SUCCEEDED')
    assert.equal(job.saveStatus, 'SAVE_FAILED')
    const assets = await f.service.listAssets('task-a')
    assert.equal(assets.length, 1)
    assert.equal(assets[0].output.outputId, job.receipt?.outputs[1].outputId)
    const before = { ...f.gateway.calls }
    await f.rebuilt().retrySave('task-a', job.jobId)
    assert.deepEqual(f.gateway.calls, before)
  })

  it('surfaces missing local bytes durably and redownloads the original output only', async () => {
    const f = await fixture()
    const done = await finish(f.service, await f.service.generate('task-a', input()))
    const asset = (await f.service.listAssets('task-a'))[0]
    await rm(join(f.task, asset.relativePath))
    const reopened = f.rebuilt()
    assert.equal((await reopened.listJobs())[0].saveStatus, 'MISSING')
    assert.equal((await f.store.getJob(scope, 'task-a', done.jobId))?.saveStatus, 'MISSING')
    const before = { ...f.gateway.calls }
    assert.equal((await reopened.retrySave('task-a', done.jobId)).saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.content, before.content + 1)
    assert.equal(f.gateway.calls.submit, before.submit)
    assert.equal(f.gateway.calls.getReceipt, before.getReceipt)
  })

  it('never reports a final saved status when its job manifest write fails', async context => {
    const f = await fixture()
    const write = VideoFiles.prototype.writeJson
    const failing = context.mock.method(VideoFiles.prototype, 'writeJson', async function(this: VideoFiles, file: string, value: unknown) {
      if (value && typeof value === 'object' && 'saveStatus' in value && value.saveStatus === 'SAVED') throw new Error('final state not durable')
      return write.call(this, file, value)
    })
    let job = await f.service.generate('task-a', input())
    job = await f.service.resume('task-a', job.jobId)
    try { await assert.rejects(f.service.resume('task-a', job.jobId), /not durable/) } finally { failing.mock.restore() }
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.saveStatus, 'SAVING')
    const before = { ...f.gateway.calls }
    const [restored] = await f.rebuilt().recover()
    assert.equal(restored.saveStatus, 'SAVED')
    assert.deepEqual(f.gateway.calls, before)
  })

  it('explicitly repairs corrupt local bytes from the same receipt and preserves quarantine evidence', async () => {
    const f = await fixture()
    const done = await finish(f.service, await f.service.generate('task-a', input()))
    const asset = (await f.service.listAssets('task-a'))[0]
    const corrupt = Buffer.from(MOCK_VIDEO_BYTES)
    corrupt[corrupt.length - 1] ^= 0xff
    await writeFile(join(f.task, asset.relativePath), corrupt)
    assert.equal((await f.rebuilt().listJobs())[0].saveStatus, 'SAVE_FAILED')
    const before = { ...f.gateway.calls }
    const restored = await f.rebuilt().retrySave('task-a', done.jobId)
    assert.equal(restored.saveStatus, 'SAVED')
    assert.deepEqual(restored.receipt, done.receipt)
    assert.equal(f.gateway.calls.content, before.content + 1)
    assert.equal(f.gateway.calls.submit, before.submit)
    assert.equal(f.gateway.calls.quote, before.quote)
    const quarantine = await readdir(join(f.task, 'quarantine'))
    assert.equal(quarantine.length, 1)
    assert.deepEqual(await readFile(join(f.task, 'quarantine', quarantine[0], 'corrupt.video')), corrupt)
    assert.deepEqual(await f.store.readAsset(scope, 'task-a', done.jobId, asset.output.outputId), MOCK_VIDEO_BYTES)
  })

  it('refuses scope and receipt identity mismatches without downloading or changing identity', async context => {
    const f = await fixture()
    const job = await f.service.generate('task-a', input())
    const wrongScope = new VideoService({ scope: { ...scope, subscriptionId: 'other' }, gateway: f.gateway, store: f.store })
    assert.deepEqual(await wrongScope.recover(), [])
    await assert.rejects(wrongScope.resume('task-a', job.jobId), /scope/)
    const receipt = job.receipt!
    const get = context.mock.method(f.gateway, 'getReceipt', async () => ({ ...receipt, receiptId: 'replacement' }))
    try { await assert.rejects(f.service.resume('task-a', job.jobId), /original/) } finally { get.mock.restore() }
    assert.deepEqual((await f.store.getJob(scope, 'task-a', job.jobId))?.receipt, receipt)
    assert.equal(f.gateway.calls.content, 0)
  })

  it('does not download expired/unavailable results or reclassify them as generation success', async context => {
    const f = await fixture()
    const get = f.gateway.getReceipt.bind(f.gateway)
    context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof get>) => {
      const receipt = await get(...args)
      if (receipt.status === 'SUCCEEDED') return { ...receipt, status: 'RESULT_EXPIRED' as const, recovery: { ...receipt.recovery, canDownload: false }, errorCode: 'RESULT_EXPIRED' }
      return receipt
    })
    let job = await f.service.generate('task-a', input())
    job = await f.service.resume('task-a', job.jobId)
    job = await f.service.resume('task-a', job.jobId)
    assert.equal(job.receipt?.status, 'RESULT_EXPIRED')
    assert.equal(job.saveStatus, 'SAVE_FAILED')
    await f.rebuilt().retrySave('task-a', job.jobId)
    assert.equal(f.gateway.calls.content, 0)
    assert.equal(f.gateway.calls.submit, 1)
  })

  it('rejects expired quotes and arbitrary input paths before sending anything', async context => {
    const f = await fixture()
    const quote = f.gateway.quote.bind(f.gateway)
    context.mock.method(f.gateway, 'quote', async (...args: Parameters<typeof quote>) => ({ ...await quote(...args), expiresAt: 1 }))
    await assert.rejects(f.service.prepare('task-a', input()), /expired/)
    await assert.rejects(f.service.prepare('../elsewhere', input()))
    await assert.rejects(f.service.prepare('task-a', { ...input(), referenceIds: ['/tmp/private.png'] }))
    assert.equal(f.gateway.calls.submit, 0)
    assert.deepEqual(await f.service.listJobs(), [])
  })

  it('serializes submissions across service instances and never posts twice', async () => {
    const f = await fixture()
    const job = await f.service.prepare('task-a', input())
    const results = await Promise.allSettled([f.service.submit('task-a', job.jobId), f.rebuilt().submit('task-a', job.jobId)])
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(results.filter(item => item.status === 'rejected').length, 1)
    assert.equal(f.gateway.calls.submit, 1)
  })

  it('close aborts a stalled download, persists failure and permits original save after restart', async context => {
    const f = await fixture()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const stalled = context.mock.method(f.gateway, 'content', async () => {
      entered()
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }
    })
    let job = await f.service.generate('task-a', input())
    job = await f.service.resume('task-a', job.jobId)
    const pending = f.service.resume('task-a', job.jobId)
    await started
    f.service.close()
    assert.equal((await pending).saveStatus, 'SAVE_FAILED')
    stalled.mock.restore()
    const [restored] = await f.rebuilt().recover()
    assert.equal(restored.saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.submit, 1)
  })

  it('reconstruction uses persisted jobs even when all service-local state is lost', async () => {
    const f = await fixture()
    await f.service.generate('task-a', input())
    const original = JSON.parse(await readFile(join(f.task, 'jobs', (await f.store.listJobs(scope))[0].jobId + '.json'), 'utf8')) as LocalVideoJob
    const receipt = original.receipt!
    const terminal: VideoReceipt = { ...receipt, status: 'SUCCEEDED', pollAfterMs: null, outputs: [{ outputId: 'restored-output', kind: 'video', mimeType: 'video/mp4',
      byteLength: MOCK_VIDEO_BYTES.length, sha256: MOCK_VIDEO_SHA256, durationSeconds: 5, width: 720, height: 1280, frameRate: 24, thumbnailOutputId: null, expiresAt: null }],
      recovery: { canQuery: false, canCancel: false, canDownload: true } }
    let get = 0
    const gateway: VideoGatewayPort = {
      quote: async () => { throw new Error('no new quote') }, submit: async () => { throw new Error('no new submit') },
      findReceipt: async () => { throw new Error('must use known receipt') }, getReceipt: async id => { assert.equal(id, receipt.receiptId); get++; return terminal },
      content: async (id, outputId) => { assert.equal(id, receipt.receiptId); assert.equal(outputId, 'restored-output'); return (async function* () { yield MOCK_VIDEO_BYTES })() },
    }
    const [restored] = await f.rebuilt(gateway).recover()
    assert.equal(restored.saveStatus, 'SAVED')
    assert.equal(restored.receipt?.receiptId, receipt.receiptId)
    assert.equal(get, 1)
  })

  it('does not hide corrupted disk state as an empty successful recovery', async () => {
    const f = await fixture()
    const job = await f.service.generate('task-a', input())
    await writeFile(join(f.task, 'jobs', `${job.jobId}.json`), 'corrupt evidence')
    await assert.rejects(f.rebuilt().recover(), /preserved/)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.gateway.calls.getReceipt, 0)
  })
})

for (const states of [
  { submissionState: 'not_submitted', billingState: 'not_reserved' },
  { submissionState: 'unknown', billingState: 'unknown' },
  {},
]) {
  it(`persists safe V3 submit diagnostics without treating reported ${JSON.stringify(states)} as trusted rejection`, async () => {
    const f = await fixture()
    const requestedSpec = { resolution: '8k', audio: false }
    const request = { ...input(), protocolVersion: 3 as const, specRevision: 2,
      requestedSpec, parameters: requestedSpec, parameterSources: { resolution: 'user' as const, audio: 'user' as const } }
    let submissions = 0, quotes = 0, queries = 0
    let recoveredReceipt: VideoReceipt | null = null
    const remote = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: scope.subscriptionId,
      token: async () => 'test-token', fetch: async () => {
        submissions++
        return new Response(JSON.stringify({ error: { code: 'UPSTREAM_SPEC_UNSUPPORTED', source: 'provider', field: 'resolution', requestedValue: '8k',
          reasonCode: 'UNSUPPORTED_RESOLUTION', alternatives: [{ resolution: '1080p' }], retryable: false, ...states,
          message: 'Bearer private-secret', reason: 'https://private.invalid', body: { apiKey: 'private-secret' } } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } })
      } })
    const gateway: VideoGatewayPort = {
      quote: async () => { quotes++; return { protocolVersion: 3, specRevision: 2, effectiveSpec: requestedSpec,
        quoteId: 'v3-quote', requestHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000, status: 'quoted', currency: 'CNY', amount: '0.900000' } },
      submit: remote.submit.bind(remote), findReceipt: async () => { queries++; return recoveredReceipt },
      getReceipt: f.gateway.getReceipt.bind(f.gateway), content: f.gateway.content.bind(f.gateway),
    }
    const reopen = () => new VideoService({ scope, executionMode: 'real', store: new VideoStore(f.root), gateway })
    const service = reopen()
    const first = await service.generate('task-a', request)
    assert.equal(first.submission, 'MAYBE_SENT'); assert.equal(first.trackingStatus, 'INTERRUPTED'); assert.equal(first.receipt, null)
    assert.deepEqual(first.specFailure, { code: 'UPSTREAM_SPEC_UNSUPPORTED', source: 'provider', field: 'resolution', requestedValue: '8k', reasonCode: 'UNSUPPORTED_RESOLUTION', alternatives: [{ resolution: '1080p' }], retryable: false, ...states })
    const restored = reopen()
    const [recovered] = await restored.recover()
    assert.deepEqual(recovered.specFailure, first.specFailure)
    assert.deepEqual(recovered.request, first.request); assert.deepEqual(recovered.quote, first.quote)
    await assert.rejects(restored.submit('task-a', first.jobId), /already/)
    assert.equal(quotes, 1); assert.equal(submissions, 1); assert.equal(queries, 1)
    assert.doesNotMatch(JSON.stringify(recovered), /private-secret|private\.invalid|apiKey|Bearer/)
    recoveredReceipt = { mock: false, receiptId: 'recovered-v3-receipt', clientRequestId: first.request.clientRequestId,
      profileId: first.request.profileId, configVersion: first.request.configVersion, operation: first.request.operation,
      protocolVersion: 3, semanticHashVersion: 3, specRevision: 2, effectiveSpec: requestedSpec,
      billingDimensions: { model: 'provider-video-v1', operation: first.request.operation, durationSeconds: 1, resolution: requestedSpec.resolution ?? '8k' }, deliveryStatus: 'matched', status: 'QUEUED', pollAfterMs: 1000,
      outputs: [], billingStatus: 'RESERVED', amountCny: '0.900000', errorCode: null,
      recovery: { canQuery: true, canCancel: false, canDownload: false } }
    const confirmed = await restored.resume('task-a', first.jobId)
    assert.equal(confirmed.specFailure, undefined, 'An authoritative receipt supersedes the earlier submission diagnostic.')
    assert.equal(confirmed.submission, 'RECEIPTED'); assert.equal(confirmed.receipt?.billingStatus, 'RESERVED')
    assert.deepEqual(confirmed.request, first.request); assert.deepEqual(confirmed.quote, first.quote)
    assert.equal(submissions, 1); assert.equal(quotes, 1)
  })
}
