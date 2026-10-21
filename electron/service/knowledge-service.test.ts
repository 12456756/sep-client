import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { KnowledgeService } from './knowledge-service'
import { KnowledgeApi, KnowledgeApiError } from '../common/platform/knowledge-api'

const requestId = 'c49b8f02-2143-4a61-9d62-459c2cb82193'
const search = { requestId, action: 'search' as const, query: '制度', topK: 5 }
describe('knowledge service identity and cancellation', () => {
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
