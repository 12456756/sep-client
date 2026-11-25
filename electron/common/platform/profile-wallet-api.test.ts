import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import * as api from './platform-api'
import { config } from '../config'

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
      user: { ...profile.user, avatar: `${config.SEP_BASE_URL}/users/avatars/u.png` },
      enterprise: { ...profile.enterprise, logo: `${config.SEP_BASE_URL}/enterprise/logos/e.png` },
    })
  })

  for (const kind of ['avatar', 'logo'] as const) {
    it(`uploads ${kind} with authorization, web source headers and a multipart file`, async () => {
      const endpoint = kind === 'avatar' ? '/users/me/avatar' : '/enterprise/logo'
      const assetPath = kind === 'avatar' ? '/users/avatars/a.png' : '/enterprise/logos/l.png'
      const bytes = new Uint8Array([1, 2])
      let calls = 0
      globalThis.fetch = async (input, init) => {
        calls++
        assert.equal(String(input), `${config.SEP_BASE_URL}${endpoint}`)
        assert.equal(init?.method, 'POST')
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('Authorization'), 'Bearer access')
        assert.equal(headers.get('Origin'), config.SEP_WEB_ORIGIN)
        assert.equal(headers.get('Referer'), `${config.SEP_WEB_ORIGIN}/`)
        assert.equal(headers.get('Content-Type'), null)
        assert.ok(init?.body instanceof FormData)
        const request = new Request(String(input), init)
        assert.match(request.headers.get('Content-Type')!, /^multipart\/form-data; boundary=/)
        const file = (await request.formData()).get('file')
        assert.ok(file instanceof File)
        assert.equal(file.name, 'avatar.png')
        assert.equal(file.type, 'image/png')
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes)
        return response({ [kind]: `/api${assetPath}` }, 201)
      }
      const upload = kind === 'avatar' ? api.uploadUserAvatar : api.uploadEnterpriseLogo
      assert.deepEqual(await upload({ bytes, filename: 'avatar.png', contentType: 'image/png' }, 'access'), {
        [kind]: `${config.SEP_BASE_URL}${assetPath}`,
      })
      assert.equal(calls, 1)
    })
  }

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
