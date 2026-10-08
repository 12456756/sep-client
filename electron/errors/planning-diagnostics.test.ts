import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AppError } from './app-error'
import { planningErrorFields } from './planning-diagnostics'

describe('planning diagnostic error metadata', () => {
  for (const status of [401, 403, 429, 500, 503]) {
    it(`recognizes provider ${status} without logging its body`, () => {
      const error = new Error(`${status}: {"token":"private-token","message":"private-response"}`)
      const fields = planningErrorFields(new AppError('PLANNING_FAILED', { cause: error }))
      assert.equal(fields.providerStatus, status)
      assert.equal(fields.causeType, 'Error')
      assert.doesNotMatch(JSON.stringify(fields), /private-token|private-response/)
    })
  }

  it('finds network errors inside the cause chain', () => {
    const cause = Object.assign(new Error('private-network-info'), { code: 'ETIMEDOUT' })
    const fields = planningErrorFields(new TypeError('fetch failed', { cause }))
    assert.equal(fields.causeCode, 'ETIMEDOUT')
    assert.equal(fields.reason, 'network-error')
    assert.doesNotMatch(JSON.stringify(fields), /private-network-info/)
  })

  it('does not infer provider status from arbitrary backend text', () => {
    assert.equal(planningErrorFields(new Error('index 503 is out of bounds')).providerStatus, undefined)
  })

  it('does not log raw non-Error objects or multiline syntax-error snippets', () => {
    const error = new SyntaxError('private-model-response\nprivate-prompt')
    error.stack = 'SyntaxError: private-model-response\nprivate-prompt\n    at parse (parser.ts:2:3)'
    assert.doesNotMatch(JSON.stringify(planningErrorFields(error)), /private-model-response|private-prompt/)
    assert.doesNotMatch(JSON.stringify(planningErrorFields({ token: 'private-token', prompt: 'private-prompt' })), /private-token|private-prompt/)
  })
})
