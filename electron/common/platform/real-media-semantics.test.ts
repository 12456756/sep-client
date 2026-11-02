import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { realMediaSemanticHash, realMediaParameters } from './real-media-semantics'

const fixture = JSON.parse(readFileSync(new URL('../../../src/shared/fixtures/media-real-semantics.json', import.meta.url), 'utf8'))

describe('real image semantic contract', () => {
  const request = { ...fixture.request, parameters: { aspectRatio: '3:2', ...fixture.request.parameters } }
  it('matches SEP UTF-8 fixture and binds every charged input', () => {
    const hash = realMediaSemanticHash(request)
    assert.equal(hash, fixture.semanticSha256)
    for (const changed of [
      { ...request, profileId: 'image-other' }, { ...request, configVersion: 'cfg-other' },
      { ...request, creativeBrief: '另一张照片' },
      { ...request, parameters: { ...request.parameters, quality: 'low' } },
      { ...request, parameters: { ...request.parameters, count: 1 } },
      { ...request, referenceHashes: [...request.referenceHashes].reverse() },
    ]) assert.notEqual(realMediaSemanticHash(changed), hash)
  })
  it('normalizes omitted defaults and rejects unsupported or conflicting parameters', () => {
    const base = { ...request, parameters: { aspectRatio: '1:1', count: 1 } }
    assert.equal(realMediaSemanticHash(base), realMediaSemanticHash({ ...base, parameters: {
      quality: 'medium', count: 1, size: '1024x1024', aspectRatio: '1:1',
    } }))
    for (const parameters of [
      { aspectRatio: '1:1', count: 1, quality: 'auto' }, { aspectRatio: '1:1', count: 5 },
      { aspectRatio: '16:9', count: 1 }, { aspectRatio: '1:1', size: '1536x1024', count: 1 },
    ]) assert.throws(() => realMediaParameters(parameters))
  })
})

describe('V3 image semantic contract', () => {
  it('retains omitted fields and binds full specifications and revisions without legacy defaults', () => {
    const request = { protocolVersion: 3 as const, profileId: 'image-v3', configVersion: 'cfg', operation: 'generate' as const,
      referenceHashes: [], creativeBrief: 'poster', parameters: {}, requestedSpec: { width: 1600, height: 2400, quality: 'ultra' },
      parameterSources: { width: 'user' as const }, specRevision: 1 }
    const hash = realMediaSemanticHash(request)
    assert.equal(hash, realMediaSemanticHash({ ...request, requestedSpec: { quality: 'ultra', height: 2400, width: 1600 } }))
    assert.notEqual(hash, realMediaSemanticHash({ ...request, requestedSpec: { ...request.requestedSpec, count: 1 } }))
    assert.notEqual(hash, realMediaSemanticHash({ ...request, specRevision: 2 }))
  })
})
