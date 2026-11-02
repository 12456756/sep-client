import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AppError } from './app-error'
import { mediaToolFailureFrom } from './media-tool-error'
import { videoToolFailureFrom } from './video-tool-error'

describe('media tool error projection', () => {
  it('keeps only safe business metadata from AppError details', () => {
    const result = mediaToolFailureFrom(new AppError('INVALID_ARGUMENT', {
      message: '规格不可用',
      details: { businessCode: 'MEDIA_SIZE_UNSUPPORTED', field: 'parameters.size', stage: 'image-quote', recovery: 'query_original', secret: 'private-token' },
    }))
    assert.deepEqual(result, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '规格不可用', businessCode: 'MEDIA_SIZE_UNSUPPORTED', field: 'parameters.size', stage: 'image-quote', recovery: 'query_original' } })
    assert.doesNotMatch(JSON.stringify(result), /private-token|secret/)
  })

  it('preserves safe specification failure context for image and video tools', () => {
    const details = { field: 'requestedSpec.durationSeconds', source: 'provider', stage: 'video-quote',
      requestedValue: 8, submissionState: 'not_submitted', billingState: 'not_reserved', retryable: false,
      secret: 'private-token', rawResponse: 'private response', reason: 'raw provider response with private-token' }
    const error = new AppError('UPSTREAM_SPEC_UNSUPPORTED', { details })
    for (const result of [mediaToolFailureFrom(error), videoToolFailureFrom(error)]) {
      assert.equal(result.error.code, 'UPSTREAM_SPEC_UNSUPPORTED')
      assert.equal(result.error.field, details.field)
      assert.equal(result.error.source, 'provider')
      assert.equal(result.error.requestedValue, 8)
      assert.equal(result.error.submissionState, 'not_submitted')
      assert.equal(result.error.billingState, 'not_reserved')
      assert.doesNotMatch(JSON.stringify(result), /private-token|rawResponse|raw provider/)
    }
  })

  it('missing specifications ask for a decision instead of suggesting host defaults', () => {
    const error = new AppError('MISSING_SPEC', { details: { field: 'requestedSpec.durationSeconds', stage: 'video-quote' } })
    const result = videoToolFailureFrom(error)
    assert.equal(result.error.code, 'MISSING_SPEC')
    assert.equal(result.error.field, 'requestedSpec.durationSeconds')
    assert.doesNotMatch(result.error.message, /host defaults|use defaults|默认规格/)
  })

  it('keeps evidence-based alternatives and reason codes while discarding transport-shaped suggestions', () => {
    const result = mediaToolFailureFrom(new AppError('UPSTREAM_SPEC_UNSUPPORTED', { details: {
      field: 'requestedSpec.durationSeconds', reasonCode: 'UNSUPPORTED_DURATION',
      alternatives: [{ durationSeconds: 6 }, { apiKey: 'secret', url: 'https://private.test' }, {}],
    } }))
    assert.equal(result.error.reasonCode, 'UNSUPPORTED_DURATION')
    assert.deepEqual(result.error.alternatives, [{ durationSeconds: 6 }])
    assert.doesNotMatch(JSON.stringify(result), /secret|private/)
  })
})
