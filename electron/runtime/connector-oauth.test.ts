import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ConnectorOAuthRuntime, dingtalkFetch } from './connector-oauth'
import { ConnectorStore } from '../data/connector-store'
import type { TaskOwnerScope } from '../data/scope-path'

const owner = { enterpriseId: 'enterprise', memberId: 'member' }
const endpoint = 'https://mcp-gw.dingtalk.com/oauth/server/doc'
const issuer = 'https://mcp-gw2.dingtalk.com'

function fixture() {
  let stored: unknown
  let scope: TaskOwnerScope | null = owner
  let opened: URL | undefined
  let tokenCalls = 0
  let holdToken: (() => Promise<void>) | undefined
  let unauthorized = false
  let invalidRefresh = false
  const store = new ConnectorStore('.', { available: () => true, encrypt: value => value, decrypt: value => value })
  store.read = async () => structuredClone(stored)
  store.write = async (_scope, value) => { stored = structuredClone(value) }
  const json = (value: unknown): Response => Response.json(value)
  const request: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ['user'] })
    if (url.pathname.includes('oauth-authorization-server')) return json({ issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token', registration_endpoint: issuer + '/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'], scopes_supported: ['user'] })
    if (url.pathname === '/oauth/register') return json({ ...JSON.parse(String(init?.body)), client_id: 'test-client', client_secret: 'test-secret' })
    if (url.pathname === '/oauth/token') {
      tokenCalls++
      if (invalidRefresh) return Response.json({ error: 'invalid_grant', error_description: 'sensitive-upstream-content' }, { status: 400 })
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('client_secret'), 'test-secret')
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('redirect_uri'), opened?.searchParams.get('redirect_uri'))
        assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), opened?.searchParams.get('code_challenge'))
      } else assert.equal(body.get('refresh_token'), 'test-refresh')
      await holdToken?.()
      init?.signal?.throwIfAborted()
      return json({ access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer', expires_in: 3600 })
    }
    if (url.href === endpoint) {
      if (unauthorized) return new Response('', { status: 401 })
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-access')
      if (init?.method !== 'POST') return new Response('', { status: 405 })
      const body = JSON.parse(String(init.body))
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })
      if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: (body.params?.cursor ? ['get_document_info', 'get_document_content'] : ['search_documents']).map(name => ({ name, inputSchema: { type: 'object' } })), ...(body.params?.cursor ? {} : { nextCursor: 'second' }) } })
      return new Response(null, { status: 202 })
    }
    throw new Error('Unexpected fixture request: ' + url.pathname)
  }
  const runtime = new ConnectorOAuthRuntime({ store, currentScope: () => scope, open: async url => { opened = new URL(url) }, fetch: request })
  const callback = (valid = true): string => {
    assert.ok(opened)
    const url = new URL(opened.searchParams.get('redirect_uri')!)
    url.searchParams.set('state', valid ? opened.searchParams.get('state')! : 'wrong')
    url.searchParams.set('code', 'test-code')
    return url.href
  }
  return { runtime, callback, get stored() { return stored }, set stored(value: unknown) { stored = value }, get opened() { return opened }, get tokenCalls() { return tokenCalls }, set scope(value: TaskOwnerScope | null) { scope = value }, set holdToken(value: () => Promise<void>) { holdToken = value }, set unauthorized(value: boolean) { unauthorized = value }, set invalidRefresh(value: boolean) { invalidRefresh = value } }
}

test('OAuth uses state and PKCE, discovers paginated tools and exposes only public state', async () => {
  const f = fixture()
  try {
    await f.runtime.connect(owner)
    assert.equal((await f.runtime.state(owner)).status, 'authorizing')
    assert.equal(f.opened?.searchParams.get('code_challenge_method'), 'S256')
    assert.equal((await fetch(f.callback(false))).status, 400)
    const response = await fetch(f.callback())
    assert.equal(response.status, 200)
    const page = await response.text()
    assert.match(page, /<h1[^>]*>授权成功<\/h1>/)
    assert.match(page, /请返回 CSEP 客户端继续使用。你可以关闭此页面。/)
    assert.match(response.headers.get('Content-Security-Policy')!, /style-src 'sha256-/)
    const state = await f.runtime.state(owner)
    assert.equal(state.status, 'connected')
    assert.doesNotMatch(JSON.stringify(state), /test-access|test-refresh|test-secret/)
    const binding = await f.runtime.binding(owner)
    assert.deepEqual(binding?.servers[0].enabledTools, ['search_documents', 'get_document_info', 'get_document_content'])
    assert.equal(f.tokenCalls, 1)
    await f.runtime.disconnect(owner)
    assert.equal(f.stored, null)
    await assert.rejects(binding!.fetch(endpoint), /no longer available/)
  } finally { f.runtime.cancel() }
})

test('cancel during token exchange prevents saving credentials even after same-user login', async () => {
  const f = fixture()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.holdToken = async () => { entered(); await new Promise<void>(resolve => { release = resolve }) }
  try {
    await f.runtime.connect(owner)
    const callback = fetch(f.callback()).catch(() => undefined)
    await started
    f.scope = null
    f.runtime.cancel()
    f.scope = owner
    release()
    await callback
    assert.equal(f.stored, null)
    assert.equal((await f.runtime.state(owner)).status, 'disconnected')
  } finally { f.runtime.cancel() }
})

test('refresh is serialized, logout invalidates old bindings, and 401 requires reconnect', async () => {
  const f = fixture()
  try {
    await f.runtime.connect(owner)
    await (await fetch(f.callback())).text()
    f.stored = { ...(f.stored as object), expiresAt: 1 }
    const binding = (await f.runtime.binding(owner))!
    await Promise.all([binding.fetch(endpoint), binding.fetch(endpoint)])
    assert.equal(f.tokenCalls, 2)
    f.runtime.cancel()
    await assert.rejects(binding.fetch(endpoint), /no longer available/)
    const renewed = (await f.runtime.binding(owner))!
    f.unauthorized = true
    await assert.rejects(renewed.fetch(endpoint), /reconnect/)
    assert.equal((await f.runtime.state(owner)).status, 'error')
    assert.equal(await f.runtime.binding(owner), undefined)
  } finally { f.runtime.cancel() }
})

test('authorization HTTP rejects foreign origins and embedded credentials before any network request', async () => {
  for (const url of ['https://example.com/token', 'https://user:password@mcp-gw2.dingtalk.com/oauth/token', 'https://mcp-gw2.dingtalk.com/oauth/token#secret']) {
    await assert.rejects(dingtalkFetch(url), /Unexpected/)
  }
})

test('concurrent connection starts share one browser flow and denial remains retryable', async () => {
  const f = fixture()
  try {
    await Promise.all([f.runtime.connect(owner), f.runtime.connect(owner)])
    const callback = new URL(f.callback())
    callback.searchParams.delete('code')
    callback.searchParams.set('error', 'access_denied')
    assert.equal((await fetch(callback)).status, 400)
    assert.equal((await f.runtime.state(owner)).status, 'error')
    assert.equal(f.tokenCalls, 0)
    await f.runtime.connect(owner)
    assert.equal((await fetch(f.callback())).status, 200)
  } finally { f.runtime.cancel() }
})

test('invalid refresh grants mark reconnect required and never expose upstream errors', async () => {
  const f = fixture()
  try {
    await f.runtime.connect(owner)
    await (await fetch(f.callback())).text()
    f.stored = { ...(f.stored as object), expiresAt: 1 }
    const binding = (await f.runtime.binding(owner))!
    f.invalidRefresh = true
    await assert.rejects(binding.fetch(endpoint), error => error instanceof Error && !error.message.includes('sensitive-upstream-content'))
    assert.equal((await f.runtime.state(owner)).status, 'error')
  } finally { f.runtime.cancel() }
})
