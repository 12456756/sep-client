import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AppError } from './app-error'
import { planningContractFailure, planningErrorFields, planningCorrectionIssues, planningFailure, planningFieldFailure } from './planning-diagnostics'

describe('planning diagnostic error metadata', () => {
  it('reports contract paths without exposing unknown field names or values', () => {
    const error = planningContractFailure(1, [{ path: ['mediaRequirements', 0, 'preferred', 'private-prompt'], code: 'invalid_type' }])
    assert.match(error.message, /第 2 个节点/)
    assert.deepEqual(planningErrorFields(error).validationIssues, [{ path: 'mediaRequirements.0.preferred.field', code: 'invalid_type' }])
    assert.doesNotMatch(JSON.stringify(planningErrorFields(error)), /private-prompt/)
  })

  it('preserves known attachment and specification paths in corrections while hiding unknown keys', () => {
    for (const path of [['inputRefs', 0, 'attachment', 'sha256'], ['mediaRequirements', 0, 'requiredSpec', 'width'], ['mediaRequirements', 0, 'parameterSources', 'durationSeconds', 'decisionRef']] as const) {
      const error = planningContractFailure(2, [{ path, code: 'invalid_type', expected: 'string' }])
      assert.equal(planningCorrectionIssues(error)[0]!.path, ['nodes', 2, ...path].join('.'))
    }
    const error = planningContractFailure(0, [{ path: ['mediaRequirements', 0, 'preferred', 'PRIVATE_FIELD'], code: 'invalid_value' }])
    assert.doesNotMatch(JSON.stringify(planningCorrectionIssues(error)), /PRIVATE_FIELD/)
  })

  it('carries precise dependency corrections across the planning error wrapper', () => {
    const cause = new AppError('INVALID_ARGUMENT', { details: { correctionIssues: [{ path: 'nodes.0.dependsOn.0', code: 'custom', expectation: 'Use an existing predecessor.' }] } })
    const error = planningFailure('dag-validation', 'invalid-draft', cause)
    assert.deepEqual(planningCorrectionIssues(error), [{ path: 'nodes.0.dependsOn.0', code: 'custom', expectation: 'Use an existing predecessor.' }])
    assert.equal(planningErrorFields(error).reason, 'invalid-draft')
  })

  it('distinguishes parameter provenance from artifact source values in corrections', () => {
    const error = planningContractFailure(0, [{ path: ['mediaRequirements', 0, 'parameterSources', 'durationSeconds', 'source'], code: 'invalid_value' }])
    const issue = planningCorrectionIssues(error)[0]!
    assert.match(issue.expectation, /user.*model.*upstream/)
    assert.doesNotMatch(issue.expectation, /workspace|media-output|either/)
  })

  it('does not copy arbitrary error data into correction issues', () => {
    assert.deepEqual(planningCorrectionIssues(new Error('PRIVATE_PAYLOAD')), [])
    assert.deepEqual(planningCorrectionIssues(new AppError('PLANNING_FAILED', { details: { correctionIssues: [null, 'PRIVATE', { path: 'nodes' }] } })), [])
    const error = planningFieldFailure('output-validation', 'invalid-node', ['nodes', 0, 'PRIVATE_FIELD'], 'Use the defined field.')
    assert.equal(planningCorrectionIssues(error)[0]!.path, 'nodes.0.field')
  })

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
