import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mediaSubmissionEvidence } from './media-submission-evidence'
import type { ApiDiagnostic } from '../../../src/shared/api-diagnostic'

const diagnostic = (status: number): ApiDiagnostic => ({ httpStatus: status, contentType: 'application/json', sepRequestId: 'sep-1',
  body: { requestId: 'sep-1', error: { code: 'INVALID_PARAMETER', source: 'platform', requestId: 'sep-1',
    submissionState: 'not_submitted', billingState: 'not_reserved' } } })

it('recognizes explicit non-submission independently of status and business-code whitelists', () => {
  for (const status of [400, 401, 402, 403, 404, 409, 410, 422, 429, 500, 502, 503, 504]) {
    assert.deepEqual(mediaSubmissionEvidence(diagnostic(status)), { submissionState: 'not_submitted', billingState: 'not_reserved' })
  }
})

it('does not infer non-submission or zero billing from a status or business code', () => {
  for (const status of [400, 401, 402, 403, 409, 422, 429, 500, 502]) {
    assert.deepEqual(mediaSubmissionEvidence({ ...diagnostic(status), body: { error: {
      code: 'INSUFFICIENT_FUNDS', source: 'platform', requestId: 'sep-1' } } }), {})
  }
  const value = diagnostic(503)
  assert.deepEqual(mediaSubmissionEvidence({ ...value, body: { error: { code: 'ANY_FAILURE', source: 'platform',
    requestId: 'sep-1', submissionState: 'not_submitted', billingState: 'unknown' } } }),
  { submissionState: 'not_submitted', billingState: 'unknown' })
})

it('rejects untrusted, truncated, contradictory and malformed submission evidence', () => {
  const valid = diagnostic(422)
  const body = valid.body as { requestId: string; error: Record<string, string> }
  const cases: ApiDiagnostic[] = [
    { ...valid, source: 'upstream' }, { ...valid, source: 'provider' }, { ...valid, readError: 'interrupted' }, { ...valid, truncated: true },
    { ...valid, contentType: 'text/html' }, { ...valid, body: 'not_submitted' },
    ...['upstream', 'provider', null].map(source => ({ ...valid, body: { ...body, error: { ...body.error, source } } })),
    { ...valid, body: { ...body, error: { ...body.error, requestId: 'different' } } },
    { ...valid, sepRequestId: 'different' },
    { ...valid, body: { ...body, error: { ...body.error, submissionState: 'unknown' } } },
    { ...valid, body: { ...body, submissionState: 'submitted' } },
  ]
  for (const value of cases) assert.deepEqual(mediaSubmissionEvidence(value), {})
})
