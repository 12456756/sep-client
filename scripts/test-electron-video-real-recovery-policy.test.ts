import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as canned from '../src/shared/fixtures/media-video-v1.json'
import { localVideoJobSchema, type LocalVideoJob } from '../electron/domain/video-media'
import { videoRuntimeSchema } from '../src/shared/video-media'
import { recoveryFixtureSchema, recoveryIdentity, type RecoveryFixture } from './electron-video-real-recovery-policy'

// Synthetic metadata only; no real fixture, token, file or transport is used.
function fixture(): RecoveryFixture {
  const tasks = ['a', 'b'].map(suffix => {
    const scope = { enterpriseId: `enterprise-${suffix}`, memberId: `member-${suffix}`, subscriptionId: `subscription-${suffix}` }
    const request = { ...canned.request, clientRequestId: `request-${suffix}`, quoteId: `quote-${suffix}` }
    const job = localVideoJobSchema.parse({ version: 1, scope, taskId: `task-${suffix}`, jobId: `job-${suffix}`, executionMode: 'real',
      request, quote: { quoteId: request.quoteId, requestHash: 'a'.repeat(64), expiresAt: 10_000,
        status: 'quoted', amount: '28.800000', currency: 'CNY', amountUsd: '4.0000000000', pricingVersion: 'test-price-v1' },
      submission: 'RECEIPTED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', error: null, createdAt: 1, updatedAt: 2,
      receipt: { ...canned.receipt, mock: false, receiptId: `receipt-${suffix}`, clientRequestId: request.clientRequestId,
        status: 'SUCCEEDED', pollAfterMs: null, billingStatus: 'SETTLED', amountCny: '28.800000', actualCostCny: '28.800000',
        amountUsd: '4.0000000000', recovery: { canQuery: false, canCancel: false, canDownload: true }, outputs: [{
          outputId: `output-${suffix}`, kind: 'video', mimeType: 'video/mp4', byteLength: 64, sha256: 'b'.repeat(64),
          durationSeconds: 15, width: 1344, height: 768, frameRate: 24, thumbnailOutputId: null, expiresAt: null,
        }] },
    })
    return { scope, taskId: job.taskId, job, runtime: videoRuntimeSchema.parse({ ...canned.runtime, executionMode: 'real' }) }
  })
  return recoveryFixtureSchema.parse({ version: 1, tasks })
}

test('fixture accepts two real-mode saved/settled identities with matching runtime snapshots', () => {
  const value = fixture()
  assert.deepEqual(recoveryFixtureSchema.parse(value), value)
  assert.equal(value.tasks[0].job.request.parameters.durationSeconds, 5)
  assert.equal(value.tasks[0].job.receipt!.outputs[0].durationSeconds, 15)
})

test('fixture refuses unsaved, unsubmitted, unsettled, failed and mock-mode jobs', () => {
  const changes: ((job: LocalVideoJob) => void)[] = [
    job => { job.saveStatus = 'PENDING' }, job => { job.saveStatus = 'SAVE_FAILED' }, job => { job.saveStatus = 'MISSING' },
    job => { job.submission = 'MAYBE_SENT' }, job => { job.receipt!.billingStatus = 'RELEASED' },
    job => { job.receipt!.billingStatus = 'RESERVED'; job.receipt!.recovery.canQuery = true },
    job => { job.receipt!.status = 'PARTIAL_SUCCEEDED' }, job => { job.executionMode = 'mock' },
    job => { job.receipt!.status = 'FAILED'; job.receipt!.outputs = []; job.receipt!.recovery.canDownload = false },
    job => { job.receipt = { ...canned.receipt, mock: true, billingStatus: 'MOCK_NOT_CHARGED',
      operation: job.request.operation, clientRequestId: job.request.clientRequestId, status: 'SUCCEEDED', outputs: job.receipt!.outputs,
      pollAfterMs: null, recovery: { canQuery: false, canCancel: false, canDownload: true } } },
    job => { job.executionMode = undefined }, job => { job.receipt = null }, job => { job.receipt!.outputs = [] },
  ]
  for (const change of changes) {
    const value = fixture(); change(value.tasks[0].job)
    assert.equal(recoveryFixtureSchema.safeParse(value).success, false)
  }
})

test('runtime mode, profile and config version must match the original job', () => {
  const cases: ((value: RecoveryFixture) => void)[] = [
    value => { value.tasks[0].runtime.executionMode = 'mock' },
    value => { value.tasks[0].runtime.profiles[0].configVersion = 'different-version' },
    value => { value.tasks[0].runtime.profiles[0].profileId = 'another-profile'; value.tasks[0].runtime.defaultProfileId = 'another-profile' },
    value => { value.tasks[0].runtime = { protocolVersion: 1, executionMode: 'real', executionAvailable: false,
      defaultProfileId: null, profiles: [], tools: [] } },
  ]
  for (const change of cases) {
    const value = fixture(); change(value)
    assert.equal(recoveryFixtureSchema.safeParse(value).success, false)
  }
})

test('duplicate task, wrong owner and mismatched task identities are rejected', () => {
  const value = fixture()
  value.tasks[1].taskId = value.tasks[0].taskId
  value.tasks[1].job.taskId = value.tasks[0].taskId
  assert.equal(recoveryFixtureSchema.safeParse(value).success, false)
  const wrongOwner = fixture(); wrongOwner.tasks[0].scope.memberId = 'another-member'
  assert.equal(recoveryFixtureSchema.safeParse(wrongOwner).success, false)
  const wrongTask = fixture(); wrongTask.tasks[0].taskId = 'another-task'
  assert.equal(recoveryFixtureSchema.safeParse(wrongTask).success, false)
})

test('immutable digest detects request, quote, scope, receipt, output and creation identity changes', () => {
  const original = fixture().tasks[0].job
  const before = recoveryIdentity(original)
  const changes: ((job: LocalVideoJob) => void)[] = [
    job => { job.jobId = 'replacement-job' }, job => { job.taskId = 'replacement-task' },
    job => { job.scope.subscriptionId = 'replacement-subscription' },
    job => { job.request.creativeBrief = 'changed request' }, job => { job.quote.pricingVersion = 'changed-pricing' },
    job => { job.receipt!.receiptId = 'replacement-receipt' }, job => { job.receipt!.outputs[0].sha256 = 'c'.repeat(64) },
    job => { job.createdAt = 0 },
  ]
  for (const change of changes) {
    const job = structuredClone(original); change(job)
    assert.notEqual(recoveryIdentity(job).immutableSha256, before.immutableSha256)
  }
  assert.deepEqual(recoveryIdentity(structuredClone(original)), before)
})

test('tracking shutdown and observation timestamps do not rewrite frozen identity digest', () => {
  const original = fixture().tasks[0].job
  const changed = { ...original, trackingStatus: 'INTERRUPTED' as const, updatedAt: 3, error: 'local tracking stopped' }
  assert.deepEqual(recoveryIdentity(changed), recoveryIdentity(original))
})
