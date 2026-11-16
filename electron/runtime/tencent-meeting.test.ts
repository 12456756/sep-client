import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorStore } from '../data/connector-store'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { MeetingApiError, TencentMeetingApi, meetingPublicResult, type MeetingIdentity } from './tencent-meeting-api'
import { meetingRequest, meetingSchema } from './tencent-meeting-command'
import { TencentMeetingWorkspaceRuntime } from './tencent-meeting-workspace'

const owner = { enterpriseId: 'e', memberId: 'a' }
const other = { enterpriseId: 'e', memberId: 'b' }
const identity = (): MeetingIdentity => ({ deviceId: 'a'.repeat(48), sdkId: 'sdk', openId: 'own-user', accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000, refreshExpiresAt: Date.now() + 86400000 })
const tokenData = () => { const t = identity(); return { access_token: t.accessToken, refresh_token: t.refreshToken, access_token_expire_time: String(Math.floor(t.expiresAt / 1000)), refresh_token_expire_time: String(Math.floor(t.refreshExpiresAt / 1000)), open_id: t.openId, sdk_id: t.sdkId } }
const argv = (service: string, method: string, data: unknown = {}): string[] => [service, method, '--json', JSON.stringify(data)]
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('Condition did not complete')
}
async function fixture() {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'tmeet-'))
  const store = new ConnectorStore(root, { available: () => true, encrypt: v => Buffer.from(v).toString('base64'), decrypt: v => Buffer.from(v, 'base64').toString('utf8') }, 'tmeet')
  let scope: TaskOwnerScope | null = owner
  let complete: (() => void) | undefined
  let refreshes = 0
  const opened: string[] = []
  const calls: Parameters<TencentMeetingApi['execute']>[1][] = []
  let failOpen = false
  const api: Pick<TencentMeetingApi, 'login' | 'refresh' | 'execute'> = {
    login: async (deviceId, open, signal) => {
      assert.match(deviceId, /^[A-Za-z0-9]{48}$/)
      await open('https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture')
      await new Promise<void>(resolve => { complete = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) })
      return { ...identity(), deviceId }
    },
    refresh: async () => { refreshes++; return { ...identity(), accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } },
    execute: async (_identity, request) => { calls.push(request); return { meeting_info_list: [{ meeting_id: 'm1', meeting_type: 0 }], page_token: 'next-page' } },
  }
  const runtime = new TencentMeetingWorkspaceRuntime({ store, currentScope: () => scope, api,
    open: async url => { opened.push(url); if (failOpen) throw new Error('sensitive browser error') },
  })
  return { root, store, runtime, opened, api, calls,
    async finish() { await until(() => !!complete); complete!(); await until(async () => (await runtime.state(owner)).status !== 'authorizing'); await until(() => opened.length >= 2) },
    set scope(value: TaskOwnerScope | null) { scope = value },
    set failOpen(value: boolean) { failOpen = value },
    get refreshes() { return refreshes },
  }
}

test('Tencent device OAuth uses fixed official URLs, polling and rotating refresh contracts', async () => {
  const calls: { url: URL; init?: RequestInit }[] = []
  const replies = [{ code: 0, data: { auth_code: 'a+b&c' } }, { code: 0, data: {} }, { code: 0, data: tokenData() }, { code: 0, data: { ...tokenData(), access_token: 'rotated' } }]
  const api = new TencentMeetingApi(async (url, init) => { calls.push({ url: new URL(String(url)), init }); return Response.json(replies.shift()) }, async () => {})
  const opened: string[] = []
  const t = await api.login(identity().deviceId, async url => { opened.push(url) }, new AbortController().signal)
  assert.equal(new URL(opened[0]).origin, 'https://meeting.tencent.com')
  assert.equal(new URL(opened[0]).searchParams.get('code'), 'a+b&c')
  assert.deepEqual(calls.map(c => c.url.pathname), ['/v2/oauth2/oauth/cli-oauth-init', '/v2/oauth2/oauth/cli-oauth-poll', '/v2/oauth2/oauth/cli-oauth-poll'])
  assert.ok(calls.every(c => c.url.origin === 'https://work.medialab.qq.com' && c.init?.redirect === 'error'))
  const rotated = await api.refresh(t, new AbortController().signal)
  assert.equal(rotated.accessToken, 'rotated')
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { device_id: t.deviceId, refresh_token: t.refreshToken, open_id: t.openId, sdk_id: t.sdkId })
})

test('Tencent API rejects malformed authorization, changed identity, aborted polling and oversized responses', async () => {
  const signal = new AbortController().signal
  await assert.rejects(new TencentMeetingApi(async () => Response.json({ code: 0, data: { ...tokenData(), open_id: 'other' } })).refresh(identity(), signal), /identity changed/)
  await assert.rejects(new TencentMeetingApi(async () => Response.json({ code: 0, data: { auth_code: '' } })).login(identity().deviceId, async () => {}, signal))
  const controller = new AbortController()
  let count = 0
  const cancelled = new TencentMeetingApi(async () => { count++; return Response.json({ code: 0, data: { auth_code: 'fixture' } }) }, async () => { controller.abort() })
  await assert.rejects(cancelled.login(identity().deviceId, async () => {}, controller.signal))
  assert.equal(count, 1)
  const large = new TencentMeetingApi(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)))
  await assert.rejects(large.execute(identity(), meetingRequest(argv('meeting', 'list'), identity().openId), signal), /too large/)
})

test('Tencent business headers fix user identity and auth errors never expose upstream secrets', async () => {
  let seen: RequestInit | undefined
  let target: URL | undefined
  const api = new TencentMeetingApi(async (url, init) => { target = new URL(String(url)); seen = init; return Response.json({ error_info: { new_error_code: 200190303, message: 'private-access' } }, { status: 401 }) })
  await assert.rejects(api.execute(identity(), meetingRequest(argv('meeting', 'list'), 'own-user'), new AbortController().signal), error => error instanceof MeetingApiError && error.code === 200190303 && !error.message.includes('private-access'))
  assert.equal(target?.origin, 'https://api.meeting.qq.com')
  assert.equal(target?.searchParams.get('userid'), 'own-user')
  const headers = new Headers(seen?.headers)
  assert.equal(headers.get('AccessToken'), 'private-access')
  assert.equal(headers.get('OpenId'), 'own-user')
  assert.equal(headers.get('Tmeet-Unique-ID'), `own-user*${'a'.repeat(48)}`)
  assert.equal(seen?.redirect, 'error')
  assert.deepEqual(JSON.parse(meetingPublicResult({ page_token: 'cursor', nested: { access_token: 'other-secret', content: 'private-access' } }, identity())), { page_token: 'cursor', nested: { access_token: '[redacted]', content: '[redacted]' } })
})

test('Tencent adapter validates bounded commands, identity, paths, pagination and explicit timezones', () => {
  for (const path of ['tmeet', 'meeting', 'record', 'identity', 'meeting.create', 'meeting update']) assert.doesNotThrow(() => JSON.parse(meetingSchema(path)))
  assert.deepEqual(meetingRequest(argv('meeting', 'list', { page_token: 'next' }), 'own').data, { userid: 'own', instanceid: 1, page_type: 1, page_size: 20, page_token: 'next' })
  const created = meetingRequest(argv('meeting', 'create', { subject: 'Planning', start: '2026-12-01T09:00:00+08:00', end: '2026-12-01T10:00:00+08:00' }), 'own')
  assert.equal(created.data.start_time, String(Date.parse('2026-12-01T09:00:00+08:00') / 1000))
  assert.equal(created.data.userid, 'own'); assert.equal(created.data.meeting_type, 0)
  assert.equal(meetingRequest(argv('record', 'transcript', { record_file_id: 'r', pid: 'cursor', limit: 50 }), 'own').data.pid, 'cursor')
  for (const args of [argv('auth', 'login'), argv('meeting', 'list', { userid: 'other' }), argv('meeting', 'list', { page_size: 21 }), argv('meeting', 'get', { meeting_id: '../token' }), argv('meeting', 'update', { meeting_id: 'm1' }), argv('meeting', 'update', { meeting_id: 'm1', start: '2026-12-01T09:00:00+08:00' }), argv('meeting', 'cancel', { meeting_id: 'm1', meeting_type: 1 }), argv('meeting', 'create', { subject: 'x', start: '2026-12-01T10:00:00', end: '2026-12-01T09:00:00' }), argv('meeting', 'search', { from: '2026-12-02T09:00:00Z', to: '2026-12-01T09:00:00Z' }), ['meeting', 'list', '--json', '{}', '--token=x']]) assert.throws(() => meetingRequest(args, 'own'))
})

test('Tencent login saves encrypted per-owner credentials before opening the shared success page', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.runtime.connect(owner); await f.finish()
  assert.equal(f.opened.length, 2)
  assert.equal((await f.runtime.state(owner)).coverage, 'meetings')
  assert.equal(await f.store.read(other), undefined)
  const disk = await readFile(join(new ScopePath(f.root).ownerRoot(owner), 'connectors', 'tmeet.json'), 'utf8')
  assert.doesNotMatch(disk, /private-access|private-refresh/)
  const success = await fetch(f.opened[1])
  assert.equal(success.status, 200); assert.match(await success.text(), /授权成功/)
  const command = (await f.runtime.binding(owner))!.commands![0]
  assert.match(await command.reference('tmeet/SKILL.md'), /connected user's/)
  await assert.rejects(command.reference('../secrets'))
  await f.runtime.disconnect(owner)
  assert.equal(await f.store.read(owner), null)
  assert.equal((await command.execute(argv('meeting', 'list'), f.root)).isError, true)
  assert.equal(f.calls.length, 0)
})

test('Tencent rotating refresh is serialized and persisted before any concurrent business calls', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.finish()
  const stored = await f.store.read(owner) as { identity: MeetingIdentity }
  stored.identity.expiresAt = Date.now() - 1
  await f.store.write(owner, stored)
  let executed = 0
  f.api.execute = async token => {
    executed++
    assert.equal(token.accessToken, 'rotated-access')
    assert.equal((await f.store.read(owner) as typeof stored).identity.refreshToken, 'rotated-refresh')
    return { page_token: 'next' }
  }
  const command = (await f.runtime.binding(owner))!.commands![0]
  const results = await Promise.all([command.execute(argv('meeting', 'list'), f.root), command.execute(argv('record', 'search'), f.root)])
  assert.ok(results.every(result => !result.isError))
  assert.equal(f.refreshes, 1); assert.equal(executed, 2)
})

test('Tencent cancellation, signout and failed browser launch cannot save late authorization', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner)
  await f.runtime.disconnect(owner)
  assert.equal(await f.store.read(owner), null)
  await f.runtime.connect(owner)
  f.scope = null; f.runtime.cancel(); f.scope = owner
  await until(async () => (await f.store.read(owner)) == null)
  assert.equal(await f.runtime.binding(owner), undefined)
  f.failOpen = true
  await assert.rejects(f.runtime.connect(owner), /无法启动/)
  assert.equal((await f.runtime.state(owner)).status, 'error')
  assert.equal(await f.store.read(owner), null)
})

test('Tencent permissions preserve connection, auth expiry invalidates bindings and writes are never replayed', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.finish()
  const command = (await f.runtime.binding(owner))!.commands![0]
  let calls = 0
  f.api.execute = async () => { calls++; throw new MeetingApiError(40301, 403) }
  assert.equal((await command.execute(argv('meeting', 'list'), f.root)).isError, true)
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  f.api.execute = async () => { calls++; throw new Error('private-access transport failure') }
  const uncertain = await command.execute(argv('meeting', 'create', { subject: 'x', start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' }), f.root)
  assert.equal(uncertain.executionUncertain, true); assert.equal(calls, 2)
  assert.doesNotMatch(uncertain.text, /private-access/)
  f.api.execute = async () => { calls++; throw new MeetingApiError(0, 408) }
  assert.equal((await command.execute(argv('meeting', 'create', { subject: 'x', start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' }), f.root)).executionUncertain, true)
  f.api.execute = async () => { calls++; throw new MeetingApiError(200190303, 401) }
  await command.execute(argv('meeting', 'list'), f.root)
  assert.equal((await f.runtime.state(owner)).status, 'error')
  await command.execute(argv('meeting', 'list'), f.root)
  assert.equal(calls, 4)
})

test('Tencent update/cancel preflight refuses recurring or unverified meetings', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.finish()
  const command = (await f.runtime.binding(owner))!.commands![0]
  f.api.execute = async (_identity, request) => { f.calls.push(request); return { meeting_info_list: [{ meeting_id: 'm1', meeting_type: 1 }] } }
  const refused = await command.execute(argv('meeting', 'cancel', { meeting_id: 'm1' }), f.root)
  assert.equal(refused.isError, true); assert.equal(refused.executionUncertain, undefined)
  assert.deepEqual(f.calls.map(call => call.method), ['GET'])
  f.api.execute = async (_identity, request) => { f.calls.push(request); return { meeting_info_list: [{ meeting_id: 'm1', meeting_type: 0 }] } }
  assert.equal((await command.execute(argv('meeting', 'update', { meeting_id: 'm1', subject: 'New' }), f.root)).isError, false)
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'PUT'])
})

test('Tencent success-page browser failure keeps the saved connection usable', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner)
  f.failOpen = true
  await f.finish()
  assert.equal((await f.runtime.state(owner)).status, 'connected')
  assert.ok(await f.runtime.binding(owner))
})

test('Tencent opens success only after durable storage and discards late business results after signout', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  const write = f.store.write.bind(f.store)
  let saving = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.store.write = async (scope, value) => {
    if (value && typeof value === 'object' && 'identity' in value) { saving = true; await gate }
    await write(scope, value)
  }
  await f.runtime.connect(owner)
  const finish = f.finish()
  await until(() => saving)
  assert.equal(f.opened.length, 1)
  assert.equal((await f.runtime.state(owner)).status, 'authorizing')
  release(); await finish
  let launched = false
  let resolveCall!: () => void
  f.api.execute = async () => { launched = true; await new Promise<void>(resolve => { resolveCall = resolve }); return { subject: 'private meeting' } }
  const command = (await f.runtime.binding(owner))!.commands![0]
  const pending = command.execute(argv('meeting', 'list'), f.root)
  await until(() => launched)
  f.scope = null; f.runtime.cancel(); resolveCall()
  const result = await pending
  assert.equal(result.isError, true); assert.doesNotMatch(result.text, /private meeting/)
})

test('Tencent disconnect during rotating refresh prevents credentials and business calls from surviving', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner); await f.finish()
  const stored = await f.store.read(owner) as { identity: MeetingIdentity }
  stored.identity.expiresAt = Date.now() - 1
  await f.store.write(owner, stored)
  let refreshing = false
  let release!: () => void
  f.api.refresh = async () => { refreshing = true; await new Promise<void>(resolve => { release = resolve }); return identity() }
  const command = (await f.runtime.binding(owner))!.commands![0]
  const pending = command.execute(argv('meeting', 'list'), f.root)
  await until(() => refreshing)
  const disconnect = f.runtime.disconnect(owner)
  release()
  assert.equal((await pending).isError, true)
  await disconnect
  assert.equal(await f.store.read(owner), null)
  assert.equal(f.calls.length, 0)
})
