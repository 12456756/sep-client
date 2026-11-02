import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { KnowledgeService } from './knowledge-service'
import { KnowledgeApi, KnowledgeApiError } from '../common/platform/knowledge-api'
import type { KnowledgeApiPort } from '../common/platform/knowledge-api'

const requestId = 'c49b8f02-2143-4a61-9d62-459c2cb82193'
const search = { requestId, action: 'search' as const, query: '制度', topK: 5 }
describe('knowledge service identity and cancellation', () => {
  it('keeps runtime search scoped and re-fetches only explicitly cited source identities', async () => {
    const calls: Array<{ action: string; knowledgeBaseIds?: string[]; sourceId?: string }> = []
    const service = new KnowledgeService({ scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) }, api: new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async (url, init) => {
      const path = String(url)
      if (path.endsWith('/sources/s1')) { calls.push({ action: 'source', sourceId: 's1' }); return Response.json({ sourceId: 's1', knowledgeBaseId: 'kb-a', documentId: 'd', documentName: '制度.md', versionId: 'v', content: 'trusted body', location: {}, isCurrent: true }) }
      if (path.endsWith('/search')) { const body = JSON.parse(String(init?.body)); calls.push({ action: 'search', knowledgeBaseIds: body.knowledgeBaseIds }); return Response.json({ status: 'NO_MATCH', results: [], actualStrategy: 'LEXICAL', degraded: false, partial: false, durationMs: 1 }) }
      return Response.json({ id: 'kb-a', name: '员工手册', permissions: {} })
    } }) })
    await service.searchForRuntime({ query: '公司制度', knowledgeBaseIds: ['kb-a'] })
    const result = await service.searchForRuntime({ query: '公司制度', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-a', sourceId: 's1' }] })
    assert.deepEqual(calls, [{ action: 'search', knowledgeBaseIds: ['kb-a'] }, { action: 'source', sourceId: 's1' }])
    assert.equal(result.results[0]?.content, 'trusted body')
    assert.equal(result.results[0]?.knowledgeBaseName, '员工手册')
  })
  it('rejects empty runtime scopes and out-of-scope citations before I/O', async () => {
    let calls = 0
    const service = new KnowledgeService({ scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) }, api: { execute: async () => { calls++; throw new Error('must not call') } } })
    await assert.rejects(service.searchForRuntime({ query: 'policy', knowledgeBaseIds: [] }))
    await assert.rejects(service.searchForRuntime({ query: 'policy', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-b', sourceId: 's' }] }))
    assert.equal(calls, 0)
  })
  it('rejects mismatched source identities and out-of-scope search results', async () => {
    const item = { sourceId: 's', knowledgeBaseId: 'kb-b', knowledgeBaseName: 'Other', documentId: 'd', documentName: 'guide.md', versionId: 'v', content: 'private', location: {} }
    const service = new KnowledgeService({ scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) }, api: new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async url => {
      if (String(url).endsWith('/search')) return Response.json({ status: 'MATCHED', results: [item], actualStrategy: 'HYBRID', degraded: false, partial: false, durationMs: 1 })
      if (String(url).includes('/sources/')) return Response.json({ ...item, isCurrent: true })
      return Response.json({ id: 'kb-a', name: 'Policies', permissions: {} })
    } }) })
    const invalid = (error: unknown): boolean => error instanceof KnowledgeApiError && error.platformCode === 'INVALID_RESPONSE'
    await assert.rejects(service.searchForRuntime({ query: 'policy', knowledgeBaseIds: ['kb-a'] }), invalid)
    await assert.rejects(service.searchForRuntime({ query: 'policy', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-a', sourceId: 's' }] }), invalid)
  })
  it('preserves source revocation and does not retry with a wider scope', async () => {
    const paths: string[] = []
    const service = new KnowledgeService({ scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) }, api: new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async url => {
      paths.push(String(url))
      if (String(url).includes('/sources/')) return new Response('{}', { status: 404 })
      return Response.json({ id: 'kb-a', name: 'Policies', permissions: {} })
    } }) })
    await assert.rejects(service.searchForRuntime({ query: 'policy', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-a', sourceId: 's' }] }), (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 404)
    assert.equal(paths.length, 2)
    assert.equal(paths.some(path => path.endsWith('/search')), false)
  })
  it('does not continue citation resolution under the next account', async () => {
    let scope = { memberId: 'a', enterpriseId: 'e' }
    let calls = 0
    const service = new KnowledgeService({ scope: { currentScope: () => scope }, api: new KnowledgeApi({ getAccessToken: async () => 'token', fetch: async () => {
      calls++; scope = { memberId: 'b', enterpriseId: 'e' }
      return Response.json({ id: 'kb-a', name: '员工手册', permissions: {} })
    } }) })
    await assert.rejects(service.searchForRuntime({ query: 'policy', knowledgeBaseIds: ['kb-a'], sources: [{ knowledgeBaseId: 'kb-a', sourceId: 's' }] }))
    assert.equal(calls, 1)
  })
  it('does not invalidate authentication for an externally cancelled late 401', async () => {
    let invalidations = 0
    let reject!: (error: unknown) => void
    const api = { execute: () => new Promise((_resolve, fail) => { reject = fail }) } as KnowledgeApiPort
    const service = new KnowledgeService({
      scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) }, api,
      onAuthenticationRequired: () => { invalidations++ },
    })
    const controller = new AbortController()
    const pending = service.execute(search, controller.signal)
    controller.abort()
    reject(new KnowledgeApiError(401))
    await assert.rejects(pending, (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 499)
    assert.equal(invalidations, 0)
  })
  it('rejects a pre-cancelled request as cancellation without invoking the API', async () => {
    let calls = 0
    const service = new KnowledgeService({
      scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) },
      api: { execute: async () => { calls++; throw new KnowledgeApiError(401) } },
    })
    await assert.rejects(service.execute(search, AbortSignal.abort()), (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 499)
    assert.equal(calls, 0)
  })
  it('still invalidates a live current-account request after a terminal 401', async () => {
    let invalidations = 0
    const service = new KnowledgeService({
      scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) },
      api: { execute: async () => { throw new KnowledgeApiError(401) } },
      onAuthenticationRequired: () => { invalidations++ },
    })
    await assert.rejects(service.execute(search), (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 401)
    assert.equal(invalidations, 1)
  })
  it('does not replay a rate-limited write using the next account token after clear', async () => {
    let scope = { memberId: 'a', enterpriseId: 'e' }
    let calls = 0
    let waiting!: () => void
    const started = new Promise<void>(resolve => { waiting = resolve })
    const api = new KnowledgeApi({
      getAccessToken: async () => scope.memberId,
      fetch: async () => { calls++; return new Response('{}', { status: 429 }) },
      sleep: () => { waiting(); return new Promise(() => undefined) },
    })
    const service = new KnowledgeService({ scope: { currentScope: () => scope }, api })
    const pending = service.execute({ requestId, action: 'grant', kbId: 'kb', memberIds: ['member'] })
    await started
    service.clear()
    scope = { memberId: 'b', enterpriseId: 'e' }
    await assert.rejects(pending, (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 499)
    assert.equal(calls, 1)
  })
  it('refuses unauthenticated calls before platform I/O', async () => {
    let calls = 0
    const service = new KnowledgeService({ scope: { currentScope: () => null }, api: new KnowledgeApi({ getAccessToken: async () => { calls++; return 'token' } }) })
    await assert.rejects(service.execute(search), /登录/)
    assert.equal(calls, 0)
  })
  it('discards old-account responses even if a transport ignores abort', async () => {
    let scope = { memberId: 'a', enterpriseId: 'enterprise' }
    let release!: (value: Response) => void
    const service = new KnowledgeService({ scope: { currentScope: () => scope }, api: new KnowledgeApi({ getAccessToken: async () => 'token', fetch: () => new Promise(resolve => { release = resolve }) }) })
    const pending = service.execute(search)
    await new Promise(resolve => setTimeout(resolve, 5))
    scope = { ...scope, memberId: 'b' }
    release(Response.json({ status: 'NO_MATCH', results: [], actualStrategy: 'LEXICAL', degraded: false, partial: false, durationMs: 1 }))
    await assert.rejects(pending)
  })
  it('cancels an in-flight token wait and releases the request slot', async () => {
    const service = new KnowledgeService({ scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) }, api: new KnowledgeApi({ getAccessToken: () => new Promise(() => undefined) }) })
    const pending = service.execute(search)
    service.cancel([requestId])
    await assert.rejects(pending, (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 499)
    service.clear()
  })
  it('propagates a task abort signal to an in-flight search request', async () => {
    const service = new KnowledgeService({
      scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) },
      api: new KnowledgeApi({ getAccessToken: async () => 'token', fetch: () => new Promise(() => undefined) }),
    })
    const controller = new AbortController()
    const pending = service.execute(search, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await assert.rejects(pending, (error: unknown) => error instanceof KnowledgeApiError && error.statusCode === 499)
  })
  it('forbids duplicate active request ids and clears pending requests on logout', async () => {
    const service = new KnowledgeService({ scope: { currentScope: () => ({ memberId: 'a', enterpriseId: 'e' }) }, api: new KnowledgeApi({ getAccessToken: () => new Promise(() => undefined) }) })
    const pending = service.execute(search)
    await assert.rejects(service.execute(search), /请求/)
    service.clear()
    await assert.rejects(pending)
  })
})
