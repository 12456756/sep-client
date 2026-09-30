import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import * as api from './platform-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('profile and personal recharge platform APIs', () => {
  it('gets the current profile and validates the response', async () => {
    const profile = { user: { id: 'u1', email: 'u@example.com', name: 'User', avatar: '/api/users/avatars/u.png', role: 'USER' }, enterprise: { id: 'e1', name: 'Enterprise', logo: '/api/enterprise/logos/e.png' } }
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /\/client\/profile$/)
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
      return response(profile)
    }
    assert.deepEqual(await api.getClientProfile('access'), {
      ...profile,
      user: { ...profile.user, avatar: 'https://longdaosep.cn/api/users/avatars/u.png' },
      enterprise: { ...profile.enterprise, logo: 'https://longdaosep.cn/api/enterprise/logos/e.png' },
    })
  })

  it('uploads avatar and enterprise logo as multipart file fields', async () => {
    const calls: string[] = []
    globalThis.fetch = async (input, init) => {
      calls.push(String(input))
      assert.equal(init?.method, 'POST')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
      assert.ok(init?.body instanceof FormData)
      const form = init.body as FormData
      const file = form.get('file')
      assert.ok(file instanceof File || file instanceof Blob)
      assert.equal(file && 'name' in file ? file.name : undefined, 'avatar.png')
      return response(calls.length === 1 ? { avatar: '/api/users/avatars/a.png' } : { logo: '/api/enterprise/logos/l.png' }, 201)
    }
    assert.equal((await api.uploadUserAvatar({ bytes: new Uint8Array([1, 2]), filename: 'avatar.png', contentType: 'image/png' }, 'access')).avatar, 'https://longdaosep.cn/api/users/avatars/a.png')
    assert.equal((await api.uploadEnterpriseLogo({ bytes: new Uint8Array([1, 2]), filename: 'avatar.png', contentType: 'image/png' }, 'access')).logo, 'https://longdaosep.cn/api/enterprise/logos/l.png')
    assert.match(calls[0]!, /\/users\/me\/avatar$/)
    assert.match(calls[1]!, /\/enterprise\/logo$/)
  })

  it('creates, queries, and reconciles a personal recharge order', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init })
      if (init?.method === 'POST' && String(input).endsWith('/recharge')) return response({ orderId: 'o1', orderNo: 'R1', amountCNY: '10.00', payUrl: '<form>' }, 201)
      if (init?.method === 'POST') return response({ status: 'PAID', reconciled: true })
      return response({ orderNo: 'R1', amountCNY: '10.00', status: 'PAID', createdAt: '2026-09-29T00:00:00Z' })
    }
    const created = await api.createPersonalRecharge({ amountCNY: 10, returnUrl: 'https://example.com/result' }, 'access')
    assert.equal(created.orderNo, 'R1')
    assert.equal((await api.getPersonalRecharge('R1', 'access')).status, 'PAID')
    assert.deepEqual(await api.reconcilePersonalRecharge('R1', 'access'), { status: 'PAID', reconciled: true })
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { amountCNY: 10, returnUrl: 'https://example.com/result' })
    assert.match(requests[1]!.url, /\/recharge\/R1$/)
    assert.match(requests[2]!.url, /\/recharge\/R1\/reconcile$/)
  })

  it('rejects invalid upload metadata and recharge input before network calls', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return response({}) }
    await assert.rejects(() => api.uploadUserAvatar({ bytes: new Uint8Array(2 * 1024 * 1024 + 1), filename: 'avatar.png', contentType: 'image/png' }, 'access'))
    await assert.rejects(() => api.uploadEnterpriseLogo({ bytes: new Uint8Array([1]), filename: 'avatar.exe', contentType: 'image/png' }, 'access'))
    await assert.rejects(() => api.createPersonalRecharge({ amountCNY: 0 }, 'access'))
    assert.equal(calls, 0)
  })
})
