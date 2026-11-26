import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { ConnectorStore } from '../data/connector-store'
import { DingTalkWorkspaceStore } from '../data/dingtalk-workspace-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorRuntimePort } from '../domain/connectors'
import { DingTalkWorkspaceRuntime } from './dingtalk-workspace'
import { describeScheduledDingTalkOperation, dingTalkFailureReason, evaluateDingTalkCommand, isScheduledDingTalkReadOnly, validateDingTalkArgs, runDingTalk, type DingTalkRunner } from './dingtalk-command'
import { prepareDingTalkBinary } from './dingtalk-assets'

const owner = { enterpriseId: 'e', memberId: 'a' }
const other = { enterpriseId: 'e', memberId: 'b' }

test('scheduled operation descriptions use known command tokens, never arbitrary positional text', () => {
  const args = ['aitable', 'record', 'group-stats', '--base-id', 'private-base', '--stats', 'private-formula']
  assert.deepEqual(describeScheduledDingTalkOperation(args), { identity: ['command', args], dingTalkAction: 'aitable record group-stats' })
  for (const unknown of [['aitable', 'record group-stats'], ['aitable', 'record', 'private-command']]) {
    assert.deepEqual(describeScheduledDingTalkOperation(unknown), { identity: ['command', unknown] })
  }
  assert.equal(dingTalkFailureReason('{"status":"error","summary":"table not found"}'), 'resource-not-found')
  assert.equal(dingTalkFailureReason('{"error":{"category":"authentication","message":"sensitive payload"}}'), 'authentication-required')
  assert.equal(dingTalkFailureReason('{"summary":"record not found: private record"}'), undefined)
  assert.equal(dingTalkFailureReason('raw connector output'), undefined)
})

test('scheduled AI table reads require a known command and exact flags without changing interactive approval', () => {
  const scope = ['--base-id', 'base', '--table-id=table']
  const reads = [
    ['base', 'search', '--query', 'Sales', '--cursor', 'next'], ['base', 'list'], ['base', 'get', '--base-id', 'base'],
    ['table', 'get', '--base-id', 'base'], ['table', 'list', '--base-id', 'base'], ['field', 'get', ...scope],
    ['record', 'list', ...scope, '--all'], ['record', 'query', ...scope, '--cursor=next', '--limit', '20'],
    ['record', 'get', ...scope, '--record-ids', 'record'], ['record', 'stats', ...scope, '--stats', '[]'],
    ['record', 'group-stats', ...scope, '--stats', '[]'], ['psql', '-d', 'base', '-c', 'SELECT * FROM sales'],
    ['psql', '--database=base', '-l'], ['psql', '-d', 'base', '-t', 'table', '--all-properties'],
  ]
  for (const args of reads) {
    assert.equal(isScheduledDingTalkReadOnly(['aitable', ...args]), true, args.join(' '))
    assert.equal(evaluateDingTalkCommand(['aitable', ...args]), undefined)
  }
  for (const args of [
    ['base', 'search', '--query', 'Sales', '--profile', 'other'], ['base', 'search', '--query', 'Sales', '--query=Other'],
    ['record', 'query', '--base-id', 'base'], ['record', 'query', ...scope, '--unknown'], ['record', 'update', ...scope],
    ['field', 'delete', ...scope], ['psql', '-d', 'base', '--database', 'other', '-l'],
    ['psql', '-d', 'base', '-c', 'DELETE FROM sales'], ['psql', '-d', 'base', '-l', '-t', 'table'],
  ]) assert.equal(isScheduledDingTalkReadOnly(['aitable', ...args]), false, args.join(' '))
})

async function fixture() {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'dingtalk-'))
  const encrypted = new ConnectorStore(root, { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }, 'dingtalk-workspace')
  const store = new DingTalkWorkspaceStore(root, encrypted)
  let scope: TaskOwnerScope | null = owner
  let release!: () => void
  let loginCount = 0
  let authenticationFailed = false
  const calls: Parameters<DingTalkRunner>[0][] = []
  const runner: DingTalkRunner = async options => {
    calls.push(options)
    if (options.args[0] === 'auth' && options.args[1] === 'login') {
      loginCount++
      await writeFile(join(options.directory, 'account.json'), 'private-account-fixture')
      options.onOutput?.('https://login.dingtalk.com/oauth2/auth?client_id=official&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback\n')
      await new Promise<void>(resolve => {
        release = resolve
        options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { text: '{}', isError: options.signal.aborted }
    }
    if (options.args[0] === 'auth') return { text: '{"authenticated":true}', isError: false }
    if (authenticationFailed) return { text: '{"error":{"category":"authentication"}}', isError: true }
    assert.equal(await readFile(join(options.directory, 'account.json'), 'utf8'), 'private-account-fixture')
    if (options.args[0] === 'chat' && options.args[1] === '+dm') {
      return { text: '{"data":{"openTaskId":"outgoing"}}', isError: false }
    }
    return { text: '{"items":[],"nextCursor":"next-page"}', isError: false }
  }
  const legacy: ConnectorRuntimePort = { state: async () => ({ id: 'dingtalk', status: 'connected' }), connect: async () => {}, disconnect: async () => {}, binding: async () => undefined, cancel: () => {} }
  const require = createRequire(import.meta.url)
  const runtime = new DingTalkWorkspaceRuntime({ store, legacy, binary: 'fixture',
    skillsArchive: require.resolve('dingtalk-workspace-cli/assets/dws-skills.zip'),
    currentScope: () => scope, open: async url => { assert.equal(new URL(url).hostname, 'login.dingtalk.com') }, runner })
  const finish = async (): Promise<void> => {
    release()
    for (let i = 0; i < 100 && (await runtime.state(owner)).status === 'authorizing'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  }
  return { root, store, encrypted, runtime, calls, finish, get loginCount() { return loginCount }, set scope(value: TaskOwnerScope | null) { scope = value }, set authenticationFailed(value: boolean) { authenticationFailed = value } }
}

test('DWS login is private, complete tools survive transient directories, and disconnect invalidates bindings', async () => {
  const f = await fixture()
  assert.equal((await f.runtime.state(owner)).coverage, 'documents')
  await f.runtime.connect(owner)
  await f.runtime.connect(owner)
  assert.equal(f.loginCount, 1)
  assert.equal((await f.runtime.state(owner)).status, 'authorizing')
  await f.finish()
  assert.equal((await f.runtime.state(owner)).coverage, 'workspace')
  const binding = await f.runtime.binding(owner)
  assert.ok(binding?.commands?.[0])
  assert.equal((await f.store.read(other)), undefined)
  const result = await binding.commands[0].execute(['calendar', 'list', '--format', 'json'], f.root)
  assert.equal(result.isError, false)
  assert.match(result.text, /nextCursor/)
  assert.deepEqual(f.calls.at(-1)?.args, ['calendar', 'list', '--format', 'json', '--yes'])
  const reference = await binding.commands[0].reference('SKILL.md')
  assert.match(reference, /[Dd][Ww][Ss]/)
  await assert.rejects(binding.commands[0].schema('profile list'), /profile/)
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  const callsBeforeSend = f.calls.length
  const submitted = await binding.commands[0].execute(['chat', '+dm', '--to', 'Example', '--content', 'test'], f.root)
  assert.deepEqual(submitted, { text: '{"data":{"openTaskId":"outgoing"}}', isError: false })
  assert.equal(f.calls.length, callsBeforeSend + 1)
  await assert.rejects(binding.commands[0].reference('references/../../secret.md'))
  const scopeRoot = join(f.root, 'task-data', 'v3', 'ZQ', 'YQ', 'connectors')
  assert.deepEqual(await readdir(join(scopeRoot, 'dws-runtime')), [])
  assert.doesNotMatch(await readFile(join(scopeRoot, 'dingtalk-workspace.json'), 'utf8'), /private-account-fixture/)
  await f.runtime.disconnect(owner)
  assert.equal(await f.store.read(owner), undefined)
  assert.equal((await binding.commands[0].execute(['todo', 'list'], f.root)).isError, true)
  await assert.rejects(binding.commands[0].reference('SKILL.md'))
  assert.deepEqual(f.calls.at(-1)?.args, ['auth', 'reset', '--yes', '--format', 'json'])
  f.runtime.cancel()
})

test('signout and cancelled OAuth cannot save old credentials after the same member returns', async () => {
  const f = await fixture()
  await f.runtime.connect(owner)
  f.scope = null
  f.runtime.cancel()
  f.scope = owner
  await f.finish()
  assert.equal(await f.store.read(owner), undefined)
  assert.equal(await f.runtime.binding(owner), undefined)
})

test('DWS argv cannot select other credentials, launch a shell, or alter client runtime', () => {
  for (const format of [['--format', 'json'], ['--format=json'], ['--format', 'json', '--format=json']]) {
    assert.deepEqual(validateDingTalkArgs(['contact', 'user', 'get-self', ...format]), ['contact', 'user', 'get-self', '--format', 'json', '--yes'])
  }
  for (const format of [['--format', 'text'], ['--format'], ['--format=table']]) assert.throws(() => validateDingTalkArgs(['contact', 'list', ...format]))
  for (const args of [
    ['auth', 'export'], ['profile', 'switch', 'someone'], ['skill', 'install', 'x'],
    ['doc', 'read', '--profile=other'], ['doc', 'read', '--client-secret', 'x'],
    ['chat', 'send', '--token', 'x'], ['doc', 'read', '--debug'], ['doc', 'read', '--yes'],
    ['dev', 'credentials', 'get'], ['event', 'consume'], ['doc', 'read', '--', 'x'],
  ]) assert.throws(() => validateDingTalkArgs(args), args.join(' '))
  assert.deepEqual(validateDingTalkArgs(['chat', '+messages-send', '--text', 'line one\nline two; $(literal)']), ['chat', '+messages-send', '--text', 'line one\nline two; $(literal)', '--format', 'json', '--yes'])
})

test('native process runner isolates keychains, bounds timeouts, and redacts secrets', async () => {
  const f = await fixture()
  const result = await runDingTalk({ binary: process.execPath, directory: f.root, keychainDirectory: join(f.root, 'keychain'), cwd: f.root,
    args: ['-e', 'process.stdout.write(JSON.stringify({config:process.env.DWS_CONFIG_DIR,keychain:process.env.DWS_KEYCHAIN_DIR,secret:"credential-test",text:"中文"}))'], signal: new AbortController().signal })
  assert.equal(result.isError, false)
  const value = JSON.parse(result.text)
  assert.equal(value.config, f.root)
  assert.equal(value.keychain, join(f.root, 'keychain'))
  assert.equal(value.text, '中文')
  assert.doesNotMatch(result.text, /credential-test/)
  const timeout = await runDingTalk({ binary: process.execPath, directory: f.root, keychainDirectory: f.root, cwd: f.root,
    args: ['-e', 'setTimeout(()=>{},10000)'], signal: new AbortController().signal, timeoutMs: 30 })
  assert.equal(timeout.executionUncertain, true)
})

test('authentication rejection invalidates all old tool bindings and requests reconnect', async () => {
  const f = await fixture()
  await f.runtime.connect(owner)
  await f.finish()
  const binding = await f.runtime.binding(owner)
  f.authenticationFailed = true
  assert.equal((await binding!.commands![0].execute(['todo', 'list'], f.root)).isError, true)
  assert.equal((await f.runtime.state(owner)).status, 'error')
  assert.equal(await f.runtime.binding(owner), undefined)
  const count = f.calls.length
  await binding!.commands![0].execute(['todo', 'list'], f.root)
  assert.equal(f.calls.length, count)
  f.runtime.cancel()
})

test('native runtime is copied independently and a modified cache cannot replace bundled code', async () => {
  const f = await fixture()
  const source = join(f.root, 'source.exe')
  await writeFile(source, 'bundled-code')
  const binary = await prepareDingTalkBinary(source, join(f.root, 'runtime'))
  assert.notEqual(source, binary)
  assert.equal(await readFile(binary, 'utf8'), 'bundled-code')
  await writeFile(binary, 'modified-code')
  assert.equal(await prepareDingTalkBinary(source, join(f.root, 'runtime')), binary)
  assert.equal(await readFile(binary, 'utf8'), 'bundled-code')
})
