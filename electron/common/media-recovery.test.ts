import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { MEDIA_RECOVERY_DEFAULTS, mediaRecoveryDelay, mediaSubmissionRecovery } from './media-recovery'
import { AppError } from '../errors/app-error'

it('does not turn a successful receipt historical 429 into another rate-limit wait', () => {
  const upstreamError = { status: 429, body: { error: { message: 'Query throttled' } }, headers: { 'retry-after': '15' } }
  assert.equal(mediaSubmissionRecovery(new AppError('SERVICE_UNAVAILABLE', {
    diagnostic: { httpStatus: 200, source: 'upstream', body: { upstreamError }, headers: { 'retry-after': '600' } },
  }), 'original'), undefined)
})

it('correlates only SEP receipt identifiers and recovers upstream errors without trusting their body', () => {
  const diagnostic = { httpStatus: 429, source: 'upstream', sepReceiptId: 'receipt-original', clientRequestId: 'original',
    headers: { 'retry-after': '7' }, body: 'Busy', truncated: true }
  assert.deepEqual(mediaSubmissionRecovery(new AppError('SERVICE_UNAVAILABLE', { diagnostic }), 'original', 1000),
    { receiptId: 'receipt-original', retryAt: 8000 })
  assert.deepEqual(mediaSubmissionRecovery(new AppError('SERVICE_UNAVAILABLE', { diagnostic }), 'another', 1000), { retryAt: 8000 })
  assert.equal(mediaSubmissionRecovery(new AppError('RATE_LIMITED', { diagnostic: { httpStatus: 429,
    source: 'platform', body: { error: { code: 'PLATFORM_RATE_LIMIT_EXCEEDED' } } } }), 'original'), undefined)
})

it('shares one polling budget and backoff policy for image and video recovery', () => {
  assert.equal(MEDIA_RECOVERY_DEFAULTS.maxAttempts, 120)
  assert.equal(MEDIA_RECOVERY_DEFAULTS.budgetMs, 30 * 60_000)
  assert.equal(mediaRecoveryDelay(1), 1000)
  assert.equal(mediaRecoveryDelay(2), 2000)
  assert.equal(mediaRecoveryDelay(20), 30_000)
  assert.equal(mediaRecoveryDelay(20, 1000, 60_000), 60_000)
})
