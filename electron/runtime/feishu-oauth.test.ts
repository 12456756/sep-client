import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { FeishuOAuth } from './feishu-oauth'

test('Feishu uses official app registration/device OAuth, validates URLs, and rotates/revokes tokens', async () => {
  const opened: string[] = []
  const calls: { url: string; init?: RequestInit }[] = []
  const request: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    assert.equal(init?.redirect, 'error')
    const form = new URLSearchParams(String(init?.body ?? ''))
    if (url.endsWith('/registration')) return Response.json(form.get('action') === 'begin'
      ? { device_code: 'register-code', user_code: 'u+code', interval: 1, expires_in: 10 }
      : { client_id: 'own-app', client_secret: 'own-secret', user_info: { tenant_brand: 'feishu' } })
    if (url.endsWith('/scopes.json')) return Response.json({ scopes: { docs: { user_scopes: ['docx:document:readonly'] }, calendar: { user_scopes: ['calendar:calendar:read', 'docx:document:readonly'] } } })
    if (url.endsWith('/device_authorization')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('own-app:own-secret').toString('base64')}`)
      assert.equal(form.get('scope'), 'calendar:calendar:read docx:document:readonly offline_access')
      return Response.json({ verification_uri_complete: 'https://accounts.feishu.cn/oauth/verify?code=abc', device_code: 'device-code', interval: 1, expires_in: 10 })
    }
    if (url.endsWith('/token')) return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, refresh_token_expires_in: 86400, scope: 'docx:document:readonly', token_type: 'Bearer' })
    if (url.endsWith('/revoke')) { assert.equal(form.get('token'), 'new-refresh'); return Response.json({}) }
    throw new Error('Unexpected network request')
  }
  const oauth = new FeishuOAuth(request)
  const open = async (url: string): Promise<void> => { opened.push(url) }
  const signal = new AbortController().signal
  const app = await oauth.register(open, signal)
  const token = await oauth.login(app, open, signal)
  assert.equal(app.clientId, 'own-app'); assert.equal(token.accessToken, 'new-access')
  assert.match(opened[0], /user_code=u%2Bcode$/)
  assert.equal(opened[1], 'https://accounts.feishu.cn/oauth/verify?code=abc')
  const refreshed = await oauth.refresh(app, token, signal)
  assert.equal(refreshed.refreshToken, 'new-refresh')
  await oauth.revoke(app, refreshed)
  assert.ok(calls.every(call => ['accounts.feishu.cn', 'open.feishu.cn'].includes(new URL(call.url).hostname)))
})

test('Feishu rejects foreign authorization origins before opening the browser', async () => {
  const oauth = new FeishuOAuth(async input => String(input).endsWith('/scopes.json')
    ? Response.json({ scopes: { docs: { user_scopes: ['docx:document:readonly'] } } })
    : Response.json({ verification_uri_complete: 'https://accounts.feishu.cn.evil.test/login', device_code: 'code' }))
  let opened = false
  await assert.rejects(oauth.login({ clientId: 'app', clientSecret: 'secret' }, async () => { opened = true }, new AbortController().signal))
  assert.equal(opened, false)
})

test('Feishu pending device authorization stops on cancellation without issuing another token request', async () => {
  const controller = new AbortController()
  let requests = 0
  const oauth = new FeishuOAuth(async () => { requests++; return Response.json({ device_code: 'code', user_code: 'u', interval: 1 }) })
  await assert.rejects(oauth.register(async () => { controller.abort() }, controller.signal))
  assert.equal(requests, 1)
})
