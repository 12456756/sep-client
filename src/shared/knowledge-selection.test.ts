import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { knowledgeSelectionSchema, noKnowledgeSelection } from './knowledge-selection'

describe('knowledge selection boundary', () => {
  it('supports none, scoped automatic search and explicit manual citations', () => {
    for (const value of [noKnowledgeSelection(), { mode: 'auto', knowledgeBaseIds: ['kb-a', 'kb-b'] },
      { mode: 'manual', knowledgeBaseIds: ['kb-a'], manualQuery: '差旅制度', sources: [{ knowledgeBaseId: 'kb-a', sourceId: 'source-a' }] }]) {
      assert.deepEqual(knowledgeSelectionSchema.parse(value), value)
    }
  })
  it('rejects scope widening, malformed modes and untrusted document bodies', () => {
    for (const value of [
      { mode: 'auto', knowledgeBaseIds: [] }, { mode: 'none', knowledgeBaseIds: ['kb-a'] },
      { mode: 'auto', knowledgeBaseIds: ['kb-a', 'kb-a'] },
      { mode: 'manual', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-b', sourceId: 's' }] },
      { mode: 'manual', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-a', sourceId: 's', content: 'fake' }] },
      { mode: 'auto', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-a', sourceId: 's' }] },
      { mode: 'manual', knowledgeBaseIds: ['kb-a'], manualQuery: 'x'.repeat(1001) },
      { mode: 'all', knowledgeBaseIds: ['kb-a'] },
    ]) assert.equal(knowledgeSelectionSchema.safeParse(value).success, false)
  })
})
