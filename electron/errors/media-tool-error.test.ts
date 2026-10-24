import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AppError } from './app-error'
import { mediaToolFailureFrom } from './media-tool-error'

describe('media tool error projection', () => {
  it('keeps only safe business metadata from AppError details', () => {
    const result = mediaToolFailureFrom(new AppError('INVALID_ARGUMENT', {
      message: '规格不可用',
      details: { businessCode: 'MEDIA_SIZE_UNSUPPORTED', field: 'parameters.size', stage: 'image-quote', recovery: 'query_original', secret: 'private-token' },
    }))
    assert.deepEqual(result, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '规格不可用', businessCode: 'MEDIA_SIZE_UNSUPPORTED', field: 'parameters.size', stage: 'image-quote', recovery: 'query_original' } })
    assert.doesNotMatch(JSON.stringify(result), /private-token|secret/)
  })
})
