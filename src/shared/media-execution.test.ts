import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mediaExecutionFields, mediaExecutionSnapshot, mediaGenerationState, mediaReceiptNeedsPoll, refineMediaExecution } from './media-execution'
import { z } from 'zod'
import { mediaReplayJobs } from './media-retry'

const execution = { requestId: 'upstream-request', taskId: null, submissionStatus: 'accepted',
  generationStatus: 'completed', isFinal: true, observedAt: 123, statusSource: 'upstream',
  billing: { status: 'unknown', actualCostUsd: null } }
const schema = z.object(mediaExecutionFields).strict()

it('accepts current CNY execution billing while preserving historical USD receipts', () => {
  const receipt = schema.parse({ receiptVersion: 2, execution: { ...execution,
    billing: { status: 'settled', actualCostCny: '1.400000' } } })
  assert.equal(receipt.execution?.billing.actualCostCny, '1.400000')
  assert.equal(receipt.execution?.billing.actualCostUsd, undefined)
  assert.equal(schema.parse({ execution }).execution?.billing.actualCostUsd, null)
})

it('limits replay protection to the selected run while retaining unassociated legacy evidence', () => {
  const jobs = [{ runId: 'old', id: 1 }, { runId: 'current', id: 2 }, { id: 3 }]
  assert.deepEqual(mediaReplayJobs(jobs, 'current').map(job => job.id), [2, 3])
  assert.equal(mediaReplayJobs(jobs).length, 3)
})

it('keeps completed generation separate from failed delivery and unknown billing', () => {
  const receipt = schema.parse({ receiptVersion: 2, execution, fileStatus: 'download_failed',
    clientActions: { submissionFinished: true, generationFinished: true, shouldPoll: true,
      pollPurpose: 'delivery', canStartNewRequest: true, canRetryDownload: true } })
  assert.equal(mediaGenerationState('RUNNING', receipt), 'SUCCEEDED')
  assert.equal(mediaReceiptNeedsPoll(receipt), true)
  assert.equal(receipt.execution?.billing.actualCostUsd, null)
})

it('closes a rejected submission even without a generation status or settled refund', () => {
  const receipt = schema.parse({ receiptVersion: 2, execution: { ...execution, submissionStatus: 'rejected', generationStatus: null, isFinal: null },
    billingError: { status: 503, body: ['refund pending'] } })
  assert.equal(mediaGenerationState('SUBMISSION_UNKNOWN', receipt), 'FAILED')
})

it('accepts closed protocol errors and preserves original submission diagnostics', () => {
  const receipt = schema.superRefine(refineMediaExecution).parse({ receiptVersion: 2, fileStatus: 'unavailable',
    execution: { ...execution, submissionStatus: 'protocol_error', generationStatus: null, isFinal: null,
      operation: 'query', submissionError: { code: 'video_protocol_error', message: 'Model mismatch' },
      submissionHttpStatus: 502, submissionRecordError: { message: 'Record write failed' }, diagnosticTruncated: true },
    clientActions: { submissionFinished: true, generationFinished: true, shouldPoll: true,
      pollPurpose: 'billing', canStartNewRequest: true, canRetryDownload: false } })
  assert.equal(mediaGenerationState('SUBMISSION_UNKNOWN', receipt), 'FAILED')
  assert.equal(mediaReceiptNeedsPoll(receipt), true)
  assert.equal(mediaExecutionSnapshot(receipt).execution?.submissionHttpStatus, 502)
})

it('does not turn an accepted task with no generation evidence into a terminal success', () => {
  const receipt = schema.parse({ receiptVersion: 2, execution: { ...execution, generationStatus: null, isFinal: null } })
  assert.equal(mediaGenerationState('SUBMISSION_UNKNOWN', receipt), 'QUEUED')
})

it('preserves legacy states and distinguishes submission uncertainty', () => {
  assert.equal(mediaGenerationState('PARTIAL_SUCCEEDED', {}), 'PARTIAL_SUCCEEDED')
  assert.equal(mediaReceiptNeedsPoll({}), undefined)
  const receipt = schema.parse({ receiptVersion: 2, execution: { ...execution, submissionStatus: 'unknown', generationStatus: null, isFinal: null } })
  assert.equal(mediaGenerationState('RUNNING', receipt), 'SUBMISSION_UNKNOWN')
})

it('maps each upstream generation and submission state without inventing billing facts', () => {
  for (const [generationStatus, expected] of [['queued', 'QUEUED'], ['in_progress', 'RUNNING'], ['failed', 'FAILED'], ['cancelled', 'CANCELLED']] as const) {
    const receipt = schema.parse({ receiptVersion: 2, execution: { ...execution, generationStatus } })
    assert.equal(mediaGenerationState('RUNNING', receipt), expected)
  }
  for (const [submissionStatus, expected] of [['not_submitted', 'FAILED'], ['rejected', 'FAILED'], ['failed', 'FAILED'], ['submitting', 'SUBMITTING']] as const) {
    const receipt = schema.parse({ receiptVersion: 2, execution: { ...execution, submissionStatus, generationStatus: null, isFinal: null } })
    assert.equal(mediaGenerationState('RUNNING', receipt), expected)
  }
  const receipt = schema.parse({ receiptVersion: 2, execution, fileStatus: 'available' })
  const snapshot = mediaExecutionSnapshot(receipt)
  assert.deepEqual(snapshot, receipt)
  snapshot.execution!.billing.actualCostUsd = '3'
  assert.equal(receipt.execution?.billing.actualCostUsd, null)
  assert.deepEqual(mediaExecutionSnapshot({}), {})
})

it('validates new state fields instead of accepting malformed provider evidence', () => {
  assert.equal(schema.safeParse({ receiptVersion: 2, execution: { ...execution, observedAt: -1 } }).success, false)
  assert.equal(schema.safeParse({ receiptVersion: 2, execution: { ...execution, billing: { status: 'unknown', actualCostUsd: 0 } } }).success, false)
})

it('rejects missing or conflicting v2 actions rather than deriving permission from ambiguous evidence', () => {
  const complete = { receiptVersion: 2, execution, fileStatus: 'download_failed',
    clientActions: { submissionFinished: true, generationFinished: true, shouldPoll: true,
      pollPurpose: 'delivery', canStartNewRequest: true, canRetryDownload: true } }
  const refined = schema.superRefine(refineMediaExecution)
  assert.equal(refined.safeParse(complete).success, true)
  assert.equal(refined.safeParse({ receiptVersion: 2 }).success, false)
  assert.equal(refined.safeParse({ ...complete, clientActions: { ...complete.clientActions, generationFinished: false } }).success, false)
  assert.equal(refined.safeParse({ ...complete, clientActions: { ...complete.clientActions, shouldPoll: false } }).success, false)
})
