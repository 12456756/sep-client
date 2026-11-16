import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorStore } from '../data/connector-store'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { WecomWorkspaceStore } from '../data/wecom-workspace-store'
import { WecomWorkspaceRuntime } from './wecom-workspace'
import { runWecom, validateWecomArgs, wecomAuthorizationUrl, wecomSchemaArgs, type WecomRunner } from './wecom-command'
import { WecomSuccessPage } from './wecom-success-page'

const owner = { enterpriseId: 'enterprise', memberId: 'owner' }
const other = { ...owner, memberId: 'other' }
const url = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=fixture'

async function fixture() {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'wecom-'))
  const raw = new ConnectorStore(root, { available: () => true, encrypt: v => Buffer.from(v).toString('base64'), decrypt: v => Buffer.from(v, 'base64').toString('utf8') }, 'wecom')
  const store = new WecomWorkspaceStore(root, raw)
  let scope: TaskOwnerScope | null = owner
  let finish: (() => void) | undefined
  let response = { text: '{"data":[]}', isError: false }
  let count = 0
  const calls: Parameters<WecomRunner>[0][] = []
  const opened: string[] = []
  let failSuccessOpen = false
  const runtime = new WecomWorkspaceRuntime({ store, binary: 'fixture', currentScope: () => scope, open: async value => {
    opened.push(value)
    if (failSuccessOpen && value.startsWith('http://127.0.0.1:')) throw new Error('Browser unavailable')
  }, runner: async options => {
    calls.push(options)
    assert.equal(await readFile(join(options.cwd, '.env'), 'utf8'), '')
    if (options.args[0] !== 'auth') return response
    if (options.args[1] === 'show') return { text: 'authorized\n', isError: false }
    const pending = new Promise<void>(resolve => { finish = resolve; options.signal.addEventListener('abort', () => resolve(), { once: true }) })
    assert.deepEqual(options.args, ['auth', 'init', '--noninteractive', '--no-browser'])
    options.onOutput?.(`${url}\n`)
    await pending
    count++
    const key = Buffer.from(await readFile(join(options.directory, '.encryption_key'), 'utf8'), 'base64')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const bytes = Buffer.concat([cipher.update(JSON.stringify({ token: `private-token-${count}`, bot: { id: 'bound-bot', secret: 'must-not-import-secret' } })), cipher.final()])
    await writeFile(join(options.directory, 'credentials.enc'), Buffer.concat([iv, bytes, cipher.getAuthTag()]))
    return { text: 'authorized', isError: false }
  } })
  async function complete() {
    assert.ok(finish)
    const before = opened.length
    finish()
    for (let index = 0; index < 100 && (await runtime.state(owner)).status === 'authorizing'; index++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal((await runtime.state(owner)).status, 'connected')
    for (let index = 0; index < 100 && opened.length === before; index++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(opened.length, before + 1)
  }
  return { runtime, store, raw, root, calls, opened, complete, set scope(v: TaskOwnerScope | null) { scope = v }, set response(v: typeof response) { response = v }, set failSuccessOpen(v: boolean) { failSuccessOpen = v } }
}

test('WeCom QR login imports only the bearer credential into the owner store and revokes stale bindings', async () => {
  const f = await fixture()
  assert.equal((await f.runtime.state(owner)).status, 'disconnected')
  await f.runtime.connect(owner)
  await f.runtime.connect(owner)
  assert.deepEqual(f.opened, [url])
  await f.complete()
  const browser = f.opened[1]
  assert.equal(new URL(browser).hostname, '127.0.0.1')
  assert.match(await (await fetch(browser)).text(), /<h1[^>]*>授权成功<\/h1>/)
  assert.equal((await fetch(new URL('./qr', browser))).status, 404)
  assert.equal(await f.store.read(other), undefined)
  assert.equal(await f.store.read({ ...owner, enterpriseId: 'other' }), undefined)
  assert.doesNotMatch(JSON.stringify(await f.raw.read(owner)), /must-not-import-secret/)
  const disk = await readFile(join(new ScopePath(f.root).ownerRoot(owner), 'connectors', 'wecom.json'), 'utf8')
  assert.doesNotMatch(disk, /private-token|must-not-import-secret/)
  await assert.rejects(readFile(join(f.calls[0].directory, 'credentials.enc')))
  assert.doesNotMatch(JSON.stringify(await f.runtime.state(owner)), /private-token|secret/)
  const binding = await f.runtime.binding(owner)
  assert.ok(binding?.commands?.[0])
  const command = binding.commands[0]
  await command.schema('chat')
  assert.equal(f.calls.at(-1)?.token, 'private-token-1')
  await command.execute(['chat', 'messages', '--json', '{"chat_id":"test"}'], f.root)
  assert.notEqual(f.calls.at(-1)?.cwd, f.root)
  assert.match(await command.reference('SKILL.md'), /employee and bot|employee.*bot|bot.*employee/)
  await assert.rejects(command.reference('../credentials.enc'))
  await f.runtime.disconnect(owner)
  assert.equal((await fetch(browser)).status, 404)
  assert.equal(await f.runtime.binding(owner), undefined)
  assert.equal(await f.store.read(owner), undefined)
  const count = f.calls.length
  assert.equal((await command.execute(['identity', 'whoami'], f.root)).isError, true)
  assert.equal(f.calls.length, count)
})

test('WeCom policy denial preserves connection while exact token expiry requires reconnect without replay', async () => {
  const f = await fixture()
  await f.runtime.connect(owner); await f.complete()
  const command = (await f.runtime.binding(owner))!.commands![0]
  f.response = { text: '{"errcode":853006,"errmsg":"policy denied"}', isError: true }
  assert.match((await command.execute(['chat', 'messages'], f.root)).text, /853006/)
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  const count = f.calls.length
  f.response = { text: '{"error":{"code":853004,"type":"AuthError"}}', isError: true }
  await command.execute(['message', 'send', '--json', '{"text":"test"}'], f.root)
  assert.equal(f.calls.length, count + 1)
  assert.equal((await f.runtime.state(owner)).status, 'error')
  assert.equal(await f.runtime.binding(owner), undefined)
  await f.runtime.connect(owner); await f.complete()
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  assert.equal((await command.execute(['identity', 'whoami'], f.root)).isError, true)
  f.runtime.cancel()
})

test('WeCom cancel and account change reject late credentials and old tools', async () => {
  const f = await fixture()
  await f.runtime.connect(owner)
  f.scope = other
  f.runtime.cancel()
  await f.runtime.disconnect(owner)
  assert.deepEqual(f.opened, [url])
  assert.equal(await f.store.read(owner), undefined)
  assert.equal((await f.runtime.state(other)).status, 'disconnected')
  f.scope = owner
  await f.runtime.connect(owner); await f.complete()
  const command = (await f.runtime.binding(owner))!.commands![0]
  f.scope = other
  const count = f.calls.length
  assert.equal((await command.execute(['identity', 'whoami'], f.root)).isError, true)
  assert.equal(f.calls.length, count)
  f.runtime.cancel()
})

test('WeCom serves only the existing success page and revokes it with its connection', async () => {
  let valid = true
  const page = await WecomSuccessPage.start(() => valid)
  try {
    const response = await fetch(page.url)
    const html = await response.text()
    assert.match(html, /授权成功/)
    assert.doesNotMatch(html, /<script|<img|二维码/)
    assert.match(response.headers.get('content-security-policy')!, /style-src 'sha256-/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await fetch(new URL('./qr', page.url))).status, 404)
    assert.equal((await fetch(new URL('/status', page.url))).status, 404)
    valid = false
    assert.equal((await fetch(page.url)).status, 404)
  } finally { page.close() }
})

test('WeCom keeps committed authorization if opening the success page fails', async () => {
  const f = await fixture()
  f.failSuccessOpen = true
  await f.runtime.connect(owner)
  await f.complete()
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  assert.ok(await f.store.read(owner))
  assert.ok(await f.runtime.binding(owner))
  f.runtime.cancel()
})

test('WeCom opens the success page only after credential persistence finishes', async () => {
  const f = await fixture()
  const persist = f.raw.write.bind(f.raw)
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const saving = new Promise<void>(resolve => { entered = resolve })
  f.raw.write = async (scope, value) => {
    if (value) { entered(); await waiting }
    await persist(scope, value)
  }
  await f.runtime.connect(owner)
  const completion = f.complete()
  await saving
  try {
    assert.deepEqual(f.opened, [url])
    assert.equal((await f.runtime.state(owner)).status, 'authorizing')
  } finally { release() }
  await completion
  assert.equal(f.opened.length, 2)
  f.runtime.cancel()
})

test('WeCom schema and argv validation cannot execute through schema or override identity and paths', () => {
  assert.deepEqual(wecomSchemaArgs('message aibot sessions list'), ['message', 'aibot', 'sessions', 'list', '--help'])
  assert.deepEqual(wecomSchemaArgs('chat.messages'), ['schema', 'get', 'chat.messages'])
  assert.deepEqual(validateWecomArgs(['chat', 'messages', '--json', '{ "chat_id": "a" }', '--page-count', '2']), ['chat', 'messages', '--json', '{"chat_id":"a"}', '--page-count', '2'])
  assert.throws(() => validateWecomArgs(['message', 'send', '--page-count', '2']))
  assert.throws(() => validateWecomArgs(['message', 'aibot', 'send', '--json', '{"msg_type":"file"}']))
  for (const path of ['auth', 'chat --json {}', 'message;whoami', 'chat..list', 'contact download', 'identity --help', '../secret']) assert.throws(() => wecomSchemaArgs(path))
  for (const args of [[], ['auth', 'show'], ['chat', 'list', '--output', 'x'], ['message', 'send', '--token=x'], ['chat', 'list', '--json', '{'], ['chat', 'list', '--json', '[]'], ['chat', 'list', '--page-count', '100'], ['chat', 'list', '--json', '{"local_path":"C:/secret"}'], ['chat', 'list', '--json', '{"secret":"x"}'], ['message', 'upload'], ['chat', 'list', '--json', '{}', '--json', '{}']]) assert.throws(() => validateWecomArgs(args))
  assert.equal(wecomAuthorizationUrl(`${url}\n`), url)
  assert.equal(wecomAuthorizationUrl(`${url}`), undefined)
  assert.equal(wecomAuthorizationUrl('https://evil.example/ai/qc/gen?scode=x\n'), undefined)
  assert.throws(() => wecomAuthorizationUrl('https://work.weixin.qq.com/ai/qc/gen?source=evil&scode=x\n'))
})

test('WeCom failed authorization settles connect and never leaves usable credentials', async () => {
  const f = await fixture()
  const runtime = new WecomWorkspaceRuntime({ store: f.store, binary: 'fixture', currentScope: () => owner,
    open: async () => { throw new Error('Browser unavailable') },
    runner: async options => {
      options.onOutput?.(`${url}\n`)
      return { text: 'private-auth-error', isError: true }
    },
  })
  await assert.rejects(runtime.connect(owner), /无法启动/)
  assert.equal((await runtime.state(owner)).status, 'error')
  assert.equal(await f.store.read(owner), undefined)
  assert.equal(await runtime.binding(owner), undefined)
  await runtime.disconnect(owner)
  assert.equal((await runtime.state(owner)).status, 'disconnected')
})

test('WeCom native runner preserves error JSON, removes inherited credentials, and redacts tokens', async () => {
  const f = await fixture()
  const previous = process.env.WECOM_CLI_ADDITIONAL_HEADERS
  process.env.WECOM_CLI_ADDITIONAL_HEADERS = '{"authorization":"inherited-secret"}'
  try {
    const result = await runWecom({ binary: process.execPath, directory: f.root, cwd: f.root, token: 'runtime-secret-token', signal: new AbortController().signal,
      args: ['-e', 'process.stderr.write("diagnostic"); process.stdout.write(JSON.stringify({error:{code:853006},echo:process.env.WECOM_CLI_ACCESS_TOKEN,headers:process.env.WECOM_CLI_ADDITIONAL_HEADERS,dir:process.env.WECOM_CLI_CONFIG_DIR}));process.exitCode=1'] })
    const value = JSON.parse(result.text)
    assert.equal(value.error.code, 853006)
    assert.equal(value.dir, f.root)
    assert.equal(value.headers, undefined)
    assert.equal(result.isError, true)
    assert.doesNotMatch(result.text, /runtime-secret-token|inherited-secret|diagnostic/)
  } finally {
    if (previous === undefined) delete process.env.WECOM_CLI_ADDITIONAL_HEADERS
    else process.env.WECOM_CLI_ADDITIONAL_HEADERS = previous
  }
})
