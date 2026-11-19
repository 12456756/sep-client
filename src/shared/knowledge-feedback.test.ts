import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { knowledgeDegradationMessage } from './knowledge-feedback'

it('explains known degradation without turning successful search into failure', () => {
  const message = knowledgeDegradationMessage({ degraded: true, actualStrategy: 'LEXICAL', degradationReason: 'QUERY_EMBEDDING_UNAVAILABLE' })!
  assert.match(message, /向量检索暂不可用.*关键词检索.*覆盖能力可能受限/)
  assert.doesNotMatch(message, /生成失败|没有资料|QUERY_EMBEDDING_UNAVAILABLE/)
})

it('does not invent a vector failure or keyword fallback for an unknown degradation', () => {
  const message = knowledgeDegradationMessage({ degraded: true, actualStrategy: null, degradationReason: 'private unknown reason' })!
  assert.match(message, /部分检索能力暂不可用/)
  assert.doesNotMatch(message, /向量|关键词|private/)
  assert.equal(knowledgeDegradationMessage({ degraded: false, actualStrategy: 'HYBRID' }), null)
})
