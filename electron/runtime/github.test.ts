import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitHubCredentialsSchema } from '../../src/shared/connectors'
import { ConnectorStore } from '../data/connector-store'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { GITHUB_ENDPOINT, gitHubTools } from './github-api'
import { GitHubWorkspaceRuntime } from './github-workspace'
import { createMcpRuntime } from '../pi/sdk/pi-mcp-client'

const owner = { enterpriseId: 'e', memberId: 'm' }
const credentials = { token: 'github_pat_private_fixture_token_123456789', readOnly: true }
function fixture() {
  let stored: unknown
  let scope: TaskOwnerScope | null = owner
  let holdIdentity: (() => Promise<void>) | undefined
  let holdWrite: (() => Promise<void>) | undefined
  let holdMcp: (() => Promise<void>) | undefined
  let denied = 0
  let identityDenied = 0
  let missingTools = false
  let repeatedCursor = false
  let requestFailure = false
  const calls: { url: string; headers: Headers; body?: Record<string, unknown> }[] = []
  const store = {
    read: async () => structuredClone(stored),
    write: async (_scope: TaskOwnerScope, value: unknown) => { await holdWrite?.(); stored = structuredClone(value) },
  }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ url: url.href, headers, body })
    assert.equal(headers.get('Authorization'), `Bearer ${credentials.token}`)
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit')
    if (requestFailure) throw new Error(`private network failure ${credentials.token}`)
    if (url.href === 'https://api.github.com/user') {
      await holdIdentity?.()
      return identityDenied ? new Response(credentials.token, { status: identityDenied }) : Response.json({ login: 'fixture-user' })
    }
    assert.equal(url.href, GITHUB_ENDPOINT)
    await holdMcp?.()
    if (denied) return new Response(`private upstream ${credentials.token}`, { status: denied })
    if (init?.method !== 'POST') return new Response(null, { status: 405 })
    if (body?.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'github-fixture', version: '1' } } })
    if (body?.method === 'tools/list') {
      const page = (body.params as { cursor?: string } | undefined)?.cursor
      const tools = missingTools ? ['get_me'] : page ? [...gitHubTools(false), 'delete_repository', 'push_files'].filter(name => name !== 'get_me') : ['get_me']
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: tools.map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })), ...(!page || repeatedCursor ? { nextCursor: 'page-2' } : {}) } })
    }
    if (body?.method === 'tools/call') return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'fixture result' }] } })
    return new Response(null, { status: 202 })
  }
  const runtime = new GitHubWorkspaceRuntime({ store, currentScope: () => scope, request })
  return { store, request, runtime, calls,
    get stored() { return stored }, set stored(value: unknown) { stored = value },
    set scope(value: TaskOwnerScope | null) { scope = value },
    set holdIdentity(value: (() => Promise<void>) | undefined) { holdIdentity = value },
    set holdWrite(value: (() => Promise<void>) | undefined) { holdWrite = value },
    set holdMcp(value: (() => Promise<void>) | undefined) { holdMcp = value },
    set denied(value: number) { denied = value }, set identityDenied(value: number) { identityDenied = value },
    set missingTools(value: boolean) { missingTools = value }, set repeatedCursor(value: boolean) { repeatedCursor = value },
    set requestFailure(value: boolean) { requestFailure = value },
  }
}

test('GitHub credentials reject header injection, arbitrary hosts and missing access modes', () => {
  assert.deepEqual(gitHubCredentialsSchema.parse({ ...credentials, token: ` ${credentials.token} ` }), credentials)
  for (const value of [{ token: credentials.token }, { ...credentials, token: 'password' }, { ...credentials, token: `${credentials.token}\r\nX-Injected: yes` }, { ...credentials, host: 'https://evil.invalid' }, { ...credentials, readOnly: 'false' }]) assert.equal(gitHubCredentialsSchema.safeParse(value).success, false)
})

test('GitHub verifies identity and paged MCP discovery before exposing only allowlisted tools and public state', async t => {
  const f = fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner, credentials)
  assert.equal((await f.runtime.state(owner)).accountLabel, 'fixture-user')
  assert.equal((await f.runtime.state(owner)).readOnly, true)
  assert.doesNotMatch(JSON.stringify(await f.runtime.state(owner)), /github_pat_|token|credentials/)
  const binding = (await f.runtime.binding(owner))!
  assert.deepEqual(binding.servers[0].enabledTools, gitHubTools(true))
  assert.doesNotMatch(JSON.stringify(binding.servers), /github_pat_/)
  for (const call of f.calls.filter(call => call.url === GITHUB_ENDPOINT)) {
    assert.equal(call.headers.get('X-MCP-Readonly'), 'true')
    assert.equal(call.headers.get('X-MCP-Tools'), gitHubTools(true).join(','))
  }
  const before = f.calls.length
  for (const url of ['https://evil.invalid/mcp/', `${GITHUB_ENDPOINT}?token=x`, `${GITHUB_ENDPOINT}other`, 'http://api.githubcopilot.com/mcp/', 'https://user:pass@api.githubcopilot.com/mcp/']) await assert.rejects(binding.fetch(url))
  assert.equal(f.calls.length, before)
  await assert.rejects(binding.fetch(GITHUB_ENDPOINT, { signal: AbortSignal.abort() }))
  assert.equal(f.calls.length, before)
  await binding.fetch(new Request(GITHUB_ENDPOINT, { headers: { Cookie: 'secret', Authorization: 'override', 'Mcp-Session-Id': 'session' } }))
  const last = f.calls.at(-1)!
  assert.equal(last.headers.get('Cookie'), null); assert.equal(last.headers.get('Mcp-Session-Id'), 'session')
  await f.runtime.disconnect(owner)
  assert.equal(f.stored, null)
  await assert.rejects(binding.fetch(GITHUB_ENDPOINT))
})

test('GitHub writes are opt-in, limited to discovered tools and always require approval', async t => {
  const f = fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner, { ...credentials, readOnly: false })
  const binding = (await f.runtime.binding(owner))!
  assert.ok(binding.servers[0].enabledTools.includes('issue_write'))
  assert.ok(binding.servers[0].enabledTools.includes('create_pull_request'))
  assert.ok(!binding.servers[0].enabledTools.includes('push_files'))
  const bridge = await createMcpRuntime(binding.servers, '.', new Map([['github', binding.fetch]]))
  t.after(() => bridge.dispose())
  assert.ok(bridge.tools.some(tool => tool.name === 'mcp__github__issue_write'))
  for (const permission of bridge.permissions.values()) assert.equal(permission, 'confirm-each')
  assert.ok(!f.calls.some(call => call.body?.method === 'tools/call'))
})

test('GitHub connection rejects missing tools, repeating pagination and upstream failures without leaking secrets', async t => {
  for (const failure of ['tools', 'pagination', 'identity401', 'mcp403', 'mcp429', 'network'] as const) {
    const f = fixture(); t.after(() => f.runtime.cancel())
    if (failure === 'tools') f.missingTools = true
    if (failure === 'pagination') f.repeatedCursor = true
    if (failure === 'identity401') f.identityDenied = 401
    if (failure === 'mcp403') f.denied = 403
    if (failure === 'mcp429') f.denied = 429
    if (failure === 'network') f.requestFailure = true
    await assert.rejects(f.runtime.connect(owner, credentials), error => { assert.doesNotMatch(String(error), /github_pat_|private upstream|private network/); return true })
    assert.equal(f.stored, undefined)
    assert.equal(await f.runtime.binding(owner), undefined)
  }
})

test('GitHub disconnect during verification prevents delayed credential persistence', async t => {
  const f = fixture(); t.after(() => f.runtime.cancel())
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.holdIdentity = async () => { entered(); await new Promise<void>(resolve => { release = resolve }) }
  const pending = assert.rejects(f.runtime.connect(owner, credentials))
  await ready
  assert.equal((await f.runtime.state(owner)).status, 'authorizing')
  const disconnect = f.runtime.disconnect(owner)
  release(); await pending; await disconnect
  assert.equal(f.stored, null)
})

test('GitHub cancellation during saving rolls back and invalidates bindings across same-user login', async t => {
  const f = fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner, credentials)
  const binding = (await f.runtime.binding(owner))!
  const previous = structuredClone(f.stored)
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.holdWrite = async () => { f.holdWrite = undefined; entered(); await new Promise<void>(resolve => { release = resolve }) }
  const pending = assert.rejects(f.runtime.connect(owner, { ...credentials, readOnly: false }))
  await ready
  f.runtime.cancel(); f.scope = null; f.scope = owner
  release(); await pending
  assert.deepEqual(f.stored, previous)
  await assert.rejects(binding.fetch(GITHUB_ENDPOINT))
  assert.ok(await f.runtime.binding(owner))
  f.scope = { ...owner, memberId: 'other' }
  assert.equal(await f.runtime.binding(owner), undefined)
  assert.equal((await f.runtime.state(owner)).status, 'disconnected')
})

test('GitHub expired tokens invalidate local bindings while forbidden access preserves the connection', async t => {
  const f = fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner, credentials)
  const binding = (await f.runtime.binding(owner))!
  f.denied = 403
  await assert.rejects(binding.fetch(GITHUB_ENDPOINT), /拒绝访问/)
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  f.denied = 401
  await assert.rejects(binding.fetch(GITHUB_ENDPOINT), /令牌无效/)
  assert.equal(f.stored, null)
  assert.equal(await f.runtime.binding(owner), undefined)
  const count = f.calls.length
  await assert.rejects(binding.fetch(GITHUB_ENDPOINT))
  assert.equal(f.calls.length, count)
})

test('GitHub credential records use existing encrypted, member-scoped storage', async t => {
  const f = fixture()
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'github-'))
  const store = new ConnectorStore(root, { available: () => true, encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString('utf8') }, 'github')
  const runtime = new GitHubWorkspaceRuntime({ store, currentScope: () => owner, request: f.request })
  t.after(() => runtime.cancel())
  await runtime.connect(owner, credentials)
  const disk = await readFile(join(new ScopePath(root).ownerRoot(owner), 'connectors/github.json'), 'utf8')
  assert.doesNotMatch(disk, /github_pat_|fixture-user/)
  assert.equal(await store.read({ ...owner, memberId: 'other' }), undefined)
  await runtime.disconnect(owner)
  assert.equal(await store.read(owner), null)
})

test('GitHub drops delayed MCP responses after signout and never retries uncertain writes', async t => {
  const f = fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner, { ...credentials, readOnly: false })
  const binding = (await f.runtime.binding(owner))!
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.holdMcp = async () => { entered(); await new Promise<void>(resolve => { release = resolve }) }
  const pending = assert.rejects(binding.fetch(GITHUB_ENDPOINT, { method: 'POST', body: JSON.stringify({ method: 'tools/call', params: { name: 'issue_write' } }) }))
  await ready
  f.runtime.cancel(); f.scope = null; f.scope = owner
  release(); await pending
  assert.equal(f.calls.filter(call => call.body?.method === 'tools/call').length, 1)
  f.holdMcp = undefined
  const next = (await f.runtime.binding(owner))!
  f.denied = 503
  await assert.rejects(next.fetch(GITHUB_ENDPOINT), /勿自动重试/)
})
