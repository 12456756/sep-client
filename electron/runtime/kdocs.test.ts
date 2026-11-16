import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorStore } from '../data/connector-store'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { KdocsApi, KdocsApiError, kdocsPublicResult } from './kdocs-api'
import { kdocsCommands, kdocsRequest, kdocsSchema } from './kdocs-command'
import { KdocsWorkspaceRuntime } from './kdocs-workspace'

const owner = { enterpriseId: 'e', memberId: 'a' }
const other = { enterpriseId: 'e', memberId: 'b' }
const identity = { token: 'private-kdocs-token' }
const args = (service: string, action: string, data: unknown = {}): string[] => [service, action, '--json', JSON.stringify(data)]
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 300; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('Condition did not complete')
}
async function fixture() {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'kdocs-'))
  const store = new ConnectorStore(root, { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }, 'kdocs')
  let scope: TaskOwnerScope | null = owner
  let finish!: () => void
  const opened: string[] = []
  let calls = 0
  let failOpen = false
  const api: Pick<KdocsApi, 'login' | 'execute'> = {
    login: async (open, signal) => {
      await open('https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=fixture')
      await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) })
      return identity
    },
    execute: async () => { calls++; return { items: [], next_page_token: 'cursor' } },
  }
  const runtime = new KdocsWorkspaceRuntime({ store, currentScope: () => scope, api, open: async url => { opened.push(url); if (failOpen) throw new Error('private browser detail') } })
  return { runtime, store, root, api, opened,
    async finish() { await until(() => !!finish); finish(); await until(async () => (await runtime.state(owner)).status !== 'authorizing') },
    set scope(value: TaskOwnerScope | null) { scope = value }, set failOpen(value: boolean) { failOpen = value }, get calls() { return calls },
  }
}

test('Kdocs browser login uses a fresh opaque code, fixed official endpoints and 202 polling', async () => {
  const seen: { url: string; init?: RequestInit }[] = []
  let waits = 0
  const api = new KdocsApi(async (input, init) => {
    seen.push({ url: String(input), init })
    return Response.json(seen.length === 1 ? { code: 202 } : { code: 200, data: identity })
  }, async () => { waits++ })
  let opened = ''
  assert.deepEqual(await api.login(async url => { opened = url }, new AbortController().signal), identity)
  const page = new URL(opened)
  assert.equal(page.origin, 'https://mcp-center.wps.cn')
  assert.equal(page.pathname, '/kdocs-auth/auth-guide')
  assert.match(page.searchParams.get('auth_code')!, /^[0-9a-f-]{36}$/)
  assert.equal(waits, 1)
  for (const call of seen) {
    assert.equal(call.url, 'https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange')
    assert.deepEqual(JSON.parse(String(call.init?.body)), { code: page.searchParams.get('auth_code') })
    assert.equal(new Headers(call.init?.headers).has('authorization'), false)
    assert.equal(call.init?.redirect, 'error'); assert.equal(call.init?.credentials, 'omit')
  }
})

test('Kdocs cancellation, denied auth, malformed tokens and oversized responses fail closed', async () => {
  for (const reply of [{ code: 409, data: identity }, { code: 403001 }, { code: 200, data: { token: '' } }, { code: 200, data: { token: 'header\ninjection' } }]) {
    await assert.rejects(new KdocsApi(async () => Response.json(reply)).login(async () => {}, new AbortController().signal))
  }
  const controller = new AbortController()
  const api = new KdocsApi(async () => Response.json({ code: 202 }), async () => { controller.abort() })
  await assert.rejects(api.login(async () => {}, controller.signal))
  await assert.rejects(new KdocsApi(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))).execute(identity, kdocsRequest(args('drive', 'list-my-files')), new AbortController().signal), /too large/)
})

test('Kdocs tool protocol preserves official tool names, pagination and credentials only in headers', async () => {
  const requests: { url: string; init?: RequestInit }[] = []
  const api = new KdocsApi(async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ code: 0, data: { next_page_token: 'next', content: identity.token, token: 'secret' } }) })
  for (const command of [args('drive', 'search-files', { keyword: '周报', page_token: 'cursor' }), args('otl', 'block-query', { file_id: 'file' }), args('sheet', 'get-sheets-info', { file_id: 'file' })]) {
    const output = await api.execute(identity, kdocsRequest(command), new AbortController().signal)
    assert.deepEqual(JSON.parse(kdocsPublicResult(output, identity)), { next_page_token: 'next', content: '[redacted]', token: '[redacted]' })
  }
  assert.deepEqual(requests.map(request => JSON.parse(String(request.init?.body)).tool), ['search_files', 'otl.block_query', 'sheet.get_sheets_info'])
  assert.equal(JSON.parse(String(requests[0].init?.body)).args.page_token, 'cursor')
  for (const request of requests) {
    assert.equal(request.url, 'https://mcp-center.wps.cn/skill_hub/api/v1/tool')
    assert.equal(new Headers(request.init?.headers).get('Authorization'), `Bearer ${identity.token}`)
    assert.doesNotMatch(String(request.init?.body), /private-kdocs-token/)
  }
  assert.equal(JSON.parse(kdocsPublicResult({ content: 'x'.repeat(130000) }, identity)).truncated, true)
})

test('Kdocs adapter rejects credential overrides, arbitrary commands, URLs and invalid ranges', () => {
  for (const path of ['kdocs', 'drive', 'otl', 'sheet', ...Object.keys(kdocsCommands)]) assert.doesNotThrow(() => JSON.parse(kdocsSchema(path)))
  for (const command of [
    args('auth', 'login'), args('drive', 'delete-file', { file_id: 'x' }), args('drive', 'read-file'),
    args('drive', 'read-file', { url: 'https://evil.example/l/file' }), args('drive', 'read-file', { url: 'https://www.kdocs.cn/l/x?token=secret' }),
    args('drive', 'list-my-files', { token: 'override' }), args('drive', 'list-my-files', { page_size: 501 }),
    args('drive', 'list-files', { parent_id: '0' }), args('drive', 'move-file', { file_ids: ['x'], dst_parent_id: '0' }),
    args('drive', 'create-file-with-content', { name: 'x.otl', file_extension: 'otl', content: 'x' }),
    args('sheet', 'get-range-data', { file_id: 'x', worksheet_id: 1, range: { rowFrom: 3, rowTo: 2, colFrom: 0, colTo: 1 } }),
    args('sheet', 'update-range-data', { file_id: 'x', rangeData: [] }),
    ['drive', 'list-my-files', '--json', '{}', '--endpoint=evil'],
  ]) assert.throws(() => kdocsRequest(command))
  assert.equal(kdocsRequest(args('drive', 'read-file', { url: 'https://www.kdocs.cn/l/file', task_id: 'pending_id' })).data.task_id, 'pending_id')
  assert.equal(kdocsRequest(args('otl', 'insert-content', { file_id: 'f', content: '正文', format: 'markdown', mode: 'append' })).tool, 'otl.insert_content')
})

test('Kdocs accepts WPS SSE results after progress and preserves split UTF-8, pagination and API errors', async () => {
  const text = '\uFEFF: keepalive\r\nevent: progress\r\ndata: {"type":"progress"}\r\n\r\nevent: result\r\ndata: {"code":0,\r\ndata: "data":{"items":[{"name":"周报"}],"next_page_token":"next"}}\r\n\r\nevent: finish\r\ndata: {"code":0,"msg":"done","type":"finish"}\r\n\r\ndata: [DONE]\r\n\r\n'
  const bytes = new TextEncoder().encode(text)
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  const api = new KdocsApi(async () => response)
  assert.deepEqual(await api.execute(identity, kdocsRequest(args('drive', 'list-my-files')), new AbortController().signal), { items: [{ name: '周报' }], next_page_token: 'next' })
  const denied = new KdocsApi(async () => new Response('data: {"code":0,"data":{"progress":true}}\n\ndata: {"code":403001}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  await assert.rejects(denied.execute(identity, kdocsRequest(args('drive', 'list-my-files')), new AbortController().signal), error => error instanceof KdocsApiError && error.code === 403001)
})

test('Kdocs rejects empty, incomplete, malformed and oversized SSE without treating authorization as connected', async () => {
  for (const text of [': keepalive\n\n', 'data: {"type":"progress"}\n\n', 'event: finish\ndata: {"code":0,"type":"finish"}\n\n', 'data: {"code":0,"data":{}}', 'data: invalid\n\n', 'data: {"code":"0","data":{}}\n\n', 'data: ' + 'x'.repeat(2 * 1024 * 1024)]) {
    const api = new KdocsApi(async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }))
    await assert.rejects(api.execute(identity, kdocsRequest(args('drive', 'list-my-files')), new AbortController().signal))
  }
  const rejected = new KdocsApi(async () => new Response('data: {"code":0,"data":{}}\n\n', { status: 401, headers: { 'content-type': 'text/event-stream' } }))
  await assert.rejects(rejected.execute(identity, kdocsRequest(args('drive', 'list-my-files')), new AbortController().signal), error => error instanceof KdocsApiError && error.status === 401)
})

test('Kdocs encrypts per-owner credentials, probes before connecting and invalidates old tools on disconnect', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.runtime.connect(owner)
  assert.equal(f.opened.length, 1)
  await f.finish()
  assert.equal((await f.runtime.state(owner)).coverage, 'documents'); assert.equal(f.calls, 1)
  assert.equal(await f.store.read(other), undefined)
  const disk = await readFile(join(new ScopePath(f.root).ownerRoot(owner), 'connectors/kdocs.json'), 'utf8')
  assert.doesNotMatch(disk, /private-kdocs-token/)
  const command = (await f.runtime.binding(owner))!.commands![0]
  assert.match(await command.reference('kdocs/SKILL.md'), /personal account/)
  await assert.rejects(command.reference('../secrets'))
  await f.runtime.disconnect(owner)
  assert.equal(await f.store.read(owner), null)
  assert.equal((await command.execute(args('drive', 'list-my-files'), f.root)).isError, true)
  assert.equal(f.calls, 1)
})

test('Kdocs refuses late auth after disconnect, signout or storage failure and keeps errors private', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.runtime.disconnect(owner)
  assert.equal(await f.store.read(owner), null); assert.equal(f.calls, 0)
  await f.runtime.connect(owner); f.scope = null; f.runtime.cancel(); f.scope = owner
  assert.equal(await f.runtime.binding(owner), undefined)
  f.failOpen = true
  await assert.rejects(f.runtime.connect(owner), /无法启动/)
  assert.doesNotMatch(JSON.stringify(await f.runtime.state(owner)), /private/)
})

test('Kdocs permissions keep connection, expired auth clears credentials, uncertain writes are not retried', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.finish()
  const command = (await f.runtime.binding(owner))!.commands![0]
  let calls = 0
  f.api.execute = async () => { calls++; throw new KdocsApiError(403001, 403) }
  assert.equal((await command.execute(args('drive', 'read-file', { file_id: 'f' }), f.root)).isError, true)
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  f.api.execute = async () => { calls++; throw new Error('private-kdocs-token network error') }
  const failure = await command.execute(args('otl', 'insert-content', { file_id: 'f', content: 'x', format: 'markdown', mode: 'append' }), f.root)
  assert.equal(failure.executionUncertain, true); assert.equal(calls, 2); assert.doesNotMatch(failure.text, /private-kdocs-token/)
  f.api.execute = async () => { calls++; throw new KdocsApiError(400006, 200) }
  await command.execute(args('drive', 'list-my-files'), f.root)
  assert.equal(await f.store.read(owner), null)
  await command.execute(args('drive', 'list-my-files'), f.root)
  assert.equal(calls, 3)
})

test('Kdocs drops late document content after signout and detects storage/probe failure', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.finish()
  const command = (await f.runtime.binding(owner))!.commands![0]
  let release!: () => void
  f.api.execute = async () => { await new Promise<void>(resolve => { release = resolve }); return { content: 'private document content' } }
  const pending = command.execute(args('drive', 'read-file', { file_id: 'f' }), f.root)
  await until(() => !!release)
  f.scope = other; f.runtime.cancel(); release()
  const result = await pending
  assert.equal(result.isError, true); assert.doesNotMatch(result.text, /private document/)
  f.scope = owner
  f.api.execute = async () => { throw new KdocsApiError(403001, 403) }
  await f.runtime.connect(owner); await f.finish()
  assert.equal((await f.runtime.state(owner)).status, 'error')
  assert.equal(await f.store.read(owner), null)
})

test('Kdocs durable save precedes success page and cancellation during save removes late credentials', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  const write = f.store.write.bind(f.store)
  let saving = false
  let release!: () => void
  f.store.write = async (scope, value) => {
    if (value) { saving = true; await new Promise<void>(resolve => { release = resolve }) }
    await write(scope, value)
  }
  await f.runtime.connect(owner)
  const finishing = f.finish()
  await until(() => saving)
  assert.equal(f.opened.length, 1)
  const disconnect = f.runtime.disconnect(owner)
  release(); await finishing; await disconnect
  assert.equal(await f.store.read(owner), null)
  assert.equal(f.opened.length, 1)
})

test('Kdocs storage failure cannot report connected and a success-page browser failure keeps saved authorization', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  const write = f.store.write.bind(f.store)
  f.store.write = async (scope, value) => { if (value) throw new Error('private secure storage failure'); await write(scope, value) }
  await f.runtime.connect(owner); await f.finish()
  assert.equal((await f.runtime.state(owner)).status, 'error')
  assert.equal(await f.runtime.binding(owner), undefined)
  assert.equal(f.opened.length, 1)
  f.store.write = write
  await f.runtime.connect(owner)
  f.failOpen = true
  await f.finish()
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  assert.ok(await f.runtime.binding(owner))
})
