import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import * as api from './platform-api'
import { config } from '../config'

const originalFetch = globalThis.fetch
const item = { id: 'n1', type: 'INFO', title: '系统通知', message: '消息', read: false, category: 'SYSTEM', severity: 'INFO', relatedType: null, relatedId: null, actionUrl: null, createdAt: '2026-10-08T08:30:00.000Z' }
afterEach(() => { globalThis.fetch = originalFetch })
describe('notification REST v1', () => {
  it('retains Retry-After from a real 429 response for bounded renderer retries', async () => {
    globalThis.fetch = async () => Response.json({ statusCode: 429, message: 'rate limited' }, { status: 429, headers: { 'Retry-After': '65' } })
    await assert.rejects(() => api.listNotifications('access'), error => error instanceof api.AuthApiError && error.statusCode === 429 && error.error.retryAfterMs === 65_000)
  })
  it('accepts a retry HTTP date and ignores invalid cooldowns even without JSON', async () => {
    const retryAt = new Date(Date.now() + 90_000).toUTCString()
    globalThis.fetch = async () => new Response('limited', { status: 429, headers: { 'Retry-After': retryAt } })
    await assert.rejects(() => api.listNotifications('access'), error => error instanceof api.AuthApiError && (error.error.retryAfterMs ?? 0) > 88_000)
    for (const value of ['invalid', '-1', '0']) {
      globalThis.fetch = async () => Response.json({ message: 'limited' }, { status: 429, headers: { 'Retry-After': value } })
      await assert.rejects(() => api.listNotifications('access'), error => error instanceof api.AuthApiError && error.error.retryAfterMs === undefined)
    }
  })
  it('bounds employee catalog, version and subscription reads with abort signals', async () => {
    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.signal instanceof AbortSignal)
      return Response.json([])
    }
    await api.getEmployeeSkills('employee', 'access')
    await api.listSkillVersions({ capabilityId: 'capability' }, 'access')
    await api.getSubscriptions('access')
  })
  it('maps actual transport timeouts to retryable network failures', async () => {
    globalThis.fetch = async () => { throw new DOMException('private upstream diagnostic', 'TimeoutError') }
    for (const request of [() => api.getEmployeeSkills('employee', 'access'), () => api.listNotifications('access')]) {
      await assert.rejects(request, error => error instanceof api.AuthApiError && error.statusCode === 0 && !error.message.includes('private'))
    }
  })
  it('reads page envelope, uses accessToken and serializes boolean/category/offset', async () => {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access-only')
      assert.equal(new Headers(init?.headers).get('Origin'), config.SEP_WEB_ORIGIN)
      assert.ok(init?.signal instanceof AbortSignal)
      if (url.pathname.endsWith('/unread-count')) {
        assert.equal(url.searchParams.get('category'), 'APPROVAL')
        return Response.json({ count: 3 })
      }
      assert.equal(url.searchParams.get('limit'), '50')
      assert.equal(url.searchParams.get('offset'), '50')
      assert.equal(url.searchParams.get('unreadOnly'), 'false')
      assert.equal(url.searchParams.get('category'), 'SYSTEM')
      return Response.json({ items: [item], total: 51 })
    }
    assert.equal((await api.listNotifications('access-only', { limit: 50, offset: 50, category: 'SYSTEM', unreadOnly: false })).total, 51)
    assert.deepEqual(await api.getUnreadNotificationCount('access-only', { category: 'APPROVAL' }), { count: 3 })
  })
  it('handles 204 on all mutations without reading JSON', async () => {
    const calls: { path: string; method?: string }[] = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname + url.search, method: init?.method })
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('Authorization'), 'Bearer access')
      assert.equal(headers.get('Origin'), config.SEP_WEB_ORIGIN)
      assert.ok(init?.signal instanceof AbortSignal)
      return new Response(null, { status: 204 })
    }
    await api.markNotificationRead('n/1', 'access')
    await api.markAllNotificationsRead('access', { category: 'APPROVAL' })
    await api.deleteNotification('n/1', 'access')
    await api.clearReadNotifications('access', { category: 'SYSTEM' })
    assert.ok(calls[0].path.endsWith('/notifications/n%2F1/read'))
    assert.ok(calls[1].path.endsWith('/notifications/read-all?category=APPROVAL'))
    assert.ok(calls[2].path.endsWith('/notifications/n%2F1'))
    assert.ok(calls[3].path.endsWith('/notifications/clear-read?category=SYSTEM'))
    assert.deepEqual(calls.map(call => call.method), ['POST', 'POST', 'DELETE', 'DELETE'])
  })
  it('validates inputs before I/O and rejects malformed external responses', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return Response.json([]) }
    await assert.rejects(() => api.listNotifications('access', { limit: 101 }))
    assert.equal(calls, 0)
    await assert.rejects(() => api.listNotifications('access'))
    globalThis.fetch = async () => Response.json({ count: -1 })
    await assert.rejects(() => api.getUnreadNotificationCount('access'))
  })
})
