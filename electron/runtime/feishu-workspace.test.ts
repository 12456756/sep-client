import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorStore } from '../data/connector-store'
import { ConnectorProcessDirectories } from '../data/connector-process-directories'
import type { TaskOwnerScope } from '../data/scope-path'
import { FeishuWorkspaceRuntime } from './feishu-workspace'
import { feishuSchemaArgs, runFeishu, validateFeishuArgs, type FeishuRunner } from './feishu-command'
import type { FeishuToken } from './feishu-oauth'

const owner = { enterpriseId: 'e', memberId: 'a' }
const other = { enterpriseId: 'e', memberId: 'b' }
const token = (): FeishuToken => ({ accessToken: 'private-user-token', refreshToken: 'private-refresh-token', expiresAt: Date.now() + 3600000, refreshExpiresAt: Date.now() + 86400000, scope: 'docs:document:read' })
async function fixture() {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'feishu-'))
  const store = new ConnectorStore(root, { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }, 'feishu')
  const calls: Parameters<FeishuRunner>[0][] = []
  let scope: TaskOwnerScope | null = owner
  let complete!: () => void
  let refreshes = 0
  let revokes = 0
  const runtime = new FeishuWorkspaceRuntime({ store, directories: new ConnectorProcessDirectories(root, 'feishu'), binary: 'fixture', currentScope: () => scope, open: async () => {},
    oauth: {
      register: async open => { await open('https://open.feishu.cn/page/cli?user_code=fixture'); return { clientId: 'own-app', clientSecret: 'private-app-secret' } },
      login: async (_app, open, signal) => {
        await open('https://accounts.feishu.cn/oauth/verify')
        await new Promise<void>(resolve => { complete = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) })
        return token()
      },
      refresh: async () => { refreshes++; return { ...token(), accessToken: 'rotated-access-token' } },
      revoke: async () => { revokes++ },
    },
    runner: async options => { calls.push(options); return { text: options.args[0] === 'skills' ? '{"content":"official Feishu instructions"}' : '{"ok":true,"data":[],"next_page_token":"next-page"}', isError: false } },
  })
  const finish = async (): Promise<void> => {
    for (let i = 0; i < 100 && !complete; i++) await new Promise(resolve => setTimeout(resolve, 5))
    complete()
    for (let i = 0; i < 100 && (await runtime.state(owner)).status === 'authorizing'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  }
  return { runtime, store, root, calls, finish, get loginStarted() { return typeof complete === 'function' }, get refreshes() { return refreshes }, get revokes() { return revokes }, set scope(value: TaskOwnerScope | null) { scope = value } }
}

test('Feishu uses the owner encrypted store, private CLI identity, and revocable bindings', async () => {
  const f = await fixture()
  assert.equal((await f.runtime.state(owner)).status, 'disconnected')
  await f.runtime.connect(owner)
  assert.equal((await f.runtime.state(owner)).status, 'authorizing')
  await f.finish()
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  assert.equal(await f.store.read(other), undefined)
  const binding = await f.runtime.binding(owner)
  assert.ok(binding?.commands?.[0])
  const commands = binding.commands[0]
  assert.equal(await commands.reference('lark-shared/SKILL.md'), 'official Feishu instructions')
  assert.equal((await commands.execute(['calendar', '+agenda'], f.root)).isError, false)
  assert.deepEqual(f.calls.at(-1)?.args, ['calendar', '+agenda', '--as', 'user', '--format', 'json'])
  assert.equal(f.calls.at(-1)?.identity?.token.accessToken, 'private-user-token')
  assert.doesNotMatch(await readFile(join(f.root, 'task-data', 'v3', 'ZQ', 'YQ', 'connectors', 'feishu.json'), 'utf8'), /private-user-token|private-app-secret/)
  await assert.rejects(commands.reference('lark-shared/../../secrets.md'))
  await assert.rejects(async () => commands.schema('calendar +agenda -- --help'))
  await f.runtime.disconnect(owner)
  assert.equal(f.revokes, 1)
  assert.equal(await f.runtime.binding(owner), undefined)
  assert.equal((await commands.execute(['calendar', '+agenda'], f.root)).isError, true)
  const count = f.calls.length
  assert.equal(count, 2)
})

test('Feishu rotating refresh is serialized and committed before concurrent business calls', async () => {
  const f = await fixture()
  await f.runtime.connect(owner); await f.finish()
  const stored = await f.store.read(owner) as { token: FeishuToken }
  stored.token.expiresAt = Date.now() - 1
  await f.store.write(owner, stored)
  const binding = await f.runtime.binding(owner)
  assert.ok(binding?.commands?.[0])
  const commands = binding.commands[0]
  await Promise.all([commands.execute(['calendar', '+agenda'], f.root), commands.execute(['task', '+list'], f.root)])
  assert.equal(f.refreshes, 1)
  assert.ok(f.calls.every(call => call.identity?.token.accessToken === 'rotated-access-token'))
  assert.equal((await f.store.read(owner) as { token: FeishuToken }).token.accessToken, 'rotated-access-token')
  f.runtime.cancel()
})

test('Feishu cancellation and signout prevent late OAuth credentials from being saved', async () => {
  const f = await fixture()
  await f.runtime.connect(owner)
  for (let i = 0; i < 100 && !f.loginStarted; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.loginStarted, true)
  f.scope = null; f.runtime.cancel(); f.scope = owner
  await f.finish()
  const stored = await f.store.read(owner) as { token?: unknown } | undefined
  assert.equal(stored?.token, undefined)
  assert.equal(await f.runtime.binding(owner), undefined)
  assert.equal((await f.runtime.state(other)).status, 'disconnected')
})

test('Feishu command/schema guards prevent identity override and schema execution bypass', () => {
  for (const args of [['auth', 'login'], ['config', 'show'], ['im', 'list', '--as', 'bot'], ['docs', 'read', '--profile=x'], ['drive', 'get', '--access-token=x'], ['calendar', '+agenda', '--'], ['im', 'exec'], ['application', 'secret']]) assert.throws(() => validateFeishuArgs(args))
  for (const path of ['calendar +agenda -- --help', 'calendar +agenda --as bot', 'auth.status', 'calendar;whoami', '../config', 'calendar  +agenda']) assert.throws(() => feishuSchemaArgs(path))
  assert.deepEqual(feishuSchemaArgs('calendar +agenda'), ['calendar', '+agenda', '--help'])
  assert.deepEqual(feishuSchemaArgs('calendar.events.instance_view'), ['schema', 'calendar.events.instance_view'])
  for (const format of [[], ['--format', 'json'], ['--format=json']]) {
    assert.deepEqual(validateFeishuArgs(['im', '+messages-send', '--text', 'literal\n$(not-a-shell)', ...format]), ['im', '+messages-send', '--text', 'literal\n$(not-a-shell)', '--as', 'user', '--format', 'json'])
  }
  assert.throws(() => validateFeishuArgs(['im', 'list', '--format', 'text']))
})

test('Feishu native runner discards inherited identity and keeps JSON separate from diagnostics', async () => {
  const f = await fixture()
  const previous = process.env.LARKSUITE_CLI_APP_SECRET
  process.env.LARKSUITE_CLI_APP_SECRET = 'inherited-secret'
  try {
    const result = await runFeishu({ binary: process.execPath, directory: f.root, cwd: f.root, signal: new AbortController().signal, identity: { clientId: 'own-app', token: token() }, args: ['-e', 'process.stderr.write("diagnostic");process.stdout.write(JSON.stringify({app:process.env.LARKSUITE_CLI_APP_ID,secret:process.env.LARKSUITE_CLI_APP_SECRET,echo:process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,identity:process.env.LARKSUITE_CLI_DEFAULT_AS,dir:process.env.LARKSUITE_CLI_CONFIG_DIR}))'] })
    const value = JSON.parse(result.text)
    assert.equal(value.app, 'own-app'); assert.equal(value.identity, 'user'); assert.equal(value.dir, f.root)
    assert.doesNotMatch(result.text, /inherited-secret|private-user-token|diagnostic/)
  } finally { if (previous === undefined) delete process.env.LARKSUITE_CLI_APP_SECRET; else process.env.LARKSUITE_CLI_APP_SECRET = previous }
})
