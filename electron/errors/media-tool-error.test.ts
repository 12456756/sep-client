import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AppError } from './app-error'
import { mediaToolFailureFrom } from './media-tool-error'
import { videoToolFailureFrom } from './video-tool-error'
import { mediaJobFailure } from './media-job-error'
import { VideoRequestError } from './video-request-error'

describe('media tool error projection', () => {
  it('preserves safe request diagnostics for jobs and tools while rejecting malformed fields', () => {
    const error = new VideoRequestError({ gatewayCode: 'VIDEO_HTTP_ERROR', statusCode: 503, stage: 'video-submit',
      businessCode: 'UPSTREAM_TIMEOUT', source: 'upstream', requestId: 'req-diagnostic' })
    assert.equal(error.definitelyRejected, false)
    const diagnostic = mediaJobFailure(error, 'video-query')
    assert.deepEqual(diagnostic, { code: 'SERVICE_UNAVAILABLE', stage: 'video-submit', businessCode: 'UPSTREAM_TIMEOUT',
      gatewayCode: 'VIDEO_HTTP_ERROR', source: 'upstream', requestId: 'req-diagnostic', httpStatus: 503 })
    for (const failure of [mediaToolFailureFrom(error), videoToolFailureFrom(error)]) {
      assert.equal(failure.error.businessCode, 'UPSTREAM_TIMEOUT')
      assert.equal(failure.error.requestId, 'req-diagnostic')
      assert.equal(failure.error.httpStatus, 503)
      assert.equal(failure.error.stage, 'video-submit')
    }
    const invalid = new AppError('SERVICE_UNAVAILABLE', { details: { businessCode: 'private https://secret', requestId: 'Bearer secret',
      statusCode: 999, stage: 'https://secret', source: 'secret', gatewayCode: 'secret /private/file', rawResponse: 'private' } })
    assert.deepEqual(mediaJobFailure(invalid, 'image-query'), { code: 'SERVICE_UNAVAILABLE', stage: 'image-query' })
    assert.doesNotMatch(JSON.stringify(mediaToolFailureFrom(invalid)), /Bearer|https:|rawResponse/)
  })
  it('keeps only safe business metadata from AppError details', () => {
    const result = mediaToolFailureFrom(new AppError('INVALID_ARGUMENT', {
      message: '规格不可用',
      details: { businessCode: 'MEDIA_SIZE_UNSUPPORTED', field: 'parameters.size', stage: 'image-quote', recovery: 'query_original', secret: 'private-token' },
    }))
    assert.deepEqual(result, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '生成服务不支持指定尺寸；请查看原任务状态；持续失败请联系平台管理员，勿重复生成。', businessCode: 'MEDIA_SIZE_UNSUPPORTED', field: 'parameters.size', stage: 'image-quote', recovery: 'query_original' } })
    assert.doesNotMatch(JSON.stringify(result), /private-token|secret/)
  })

  it('uses a specific Chinese reason for generic media service failures', () => {
    const result = mediaToolFailureFrom(new AppError('SERVICE_UNAVAILABLE'))
    assert.match(result.error.message, /生成服务暂时不可用/)
    assert.match(result.error.message, /查看原任务状态/)
    assert.doesNotMatch(result.error.message, /SERVICE_UNAVAILABLE|操作未能完成/)
  })

  it('persists only a bounded redacted upstream explanation, never arbitrary exception text', () => {
    const error = new AppError('SERVICE_UNAVAILABLE', { details: { source: 'upstream',
      upstreamMessage: 'Supplier account disabled; Bearer secret-value https://private.invalid/path?token=secret-value' } })
    const failure = mediaJobFailure(error, 'video-submit')
    assert.match(failure.message!, /Supplier account disabled/)
    assert.doesNotMatch(failure.message!, /secret-value|private.invalid/)
    const long = mediaJobFailure(new AppError('SERVICE_UNAVAILABLE', { details: { source: 'upstream', upstreamMessage: 'Bearer x '.repeat(300) } }), 'image-query')
    assert.ok(long.message!.length <= 1000)
    assert.equal(mediaJobFailure(new Error('private arbitrary message'), 'image-submit').message, undefined)
    const disk = mediaJobFailure(Object.assign(new Error('private path must not escape'), { code: 'ENOSPC' }), 'image-save')
    assert.equal(disk.reasonCode, 'ENOSPC')
    assert.doesNotMatch(JSON.stringify(disk), /private path/)
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
