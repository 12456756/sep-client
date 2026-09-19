import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { getEmployeeSkills, getEmploymentToken, getPackageInfo, getSubscriptions, login, refreshAccessToken, saveEmployeeConversationMessage } from './platform-api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SEP final platform API contract', () => {
  it('sends the final login fields and parses devices', async () => {
    let request: RequestInit | undefined
    globalThis.fetch = async (_input, init) => {
      request = init
      return jsonResponse({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresIn: 3600,
        refreshTokenExpiresIn: 2592000,
        user: { id: 'member-1', email: 'a@example.com', name: 'A', role: 'USER' },
        enterprise: { id: 'enterprise-1', name: 'Acme' },
        devices: [{ id: 'device-1', fingerprint: 'fp', platform: 'win32', lastSeenAt: '2026-09-11T07:00:00.000Z' }],
      })
    }

    const response = await login({ email: 'a@example.com', password: 'secret', fingerprint: 'fp', platform: 'win32', clientVersion: '0.1.0' })
    assert.deepEqual(JSON.parse(String(request?.body)), { email: 'a@example.com', password: 'secret', fingerprint: 'fp', platform: 'win32', clientVersion: '0.1.0' })
    assert.equal(response.devices[0]?.id, 'device-1')
  })

  it('sends refreshToken only for access-token refresh', async () => {
    let body = ''
    globalThis.fetch = async (_input, init) => { body = String(init?.body); return jsonResponse({ accessToken: 'access', accessTokenExpiresIn: 3600, user: { id: 'm', email: 'a', name: 'A', role: 'USER' }, enterprise: { id: 'e', name: 'E' } }) }
    await refreshAccessToken('refresh')
    assert.deepEqual(JSON.parse(body), { refreshToken: 'refresh' })
  })

  it('requests subscriptions as a direct array with final identifiers', async () => {
    let url = ''
    globalThis.fetch = async input => { url = String(input); return jsonResponse([{ id: 'row-1', subscriptionId: 'sub-1', employeeId: 'employee-1', name: 'Commerce', status: 'ACTIVE', templateVersion: '1.2.0', template: { id: 'employee-1', name: 'Commerce', avatar: null }, department: null, allowedModels: ['model-a'], upgradeAvailable: false }]) }
    const subscriptions = await getSubscriptions('access')
    assert.match(url, /\/client\/subscriptions$/)
    assert.equal(subscriptions[0]?.subscriptionId, 'sub-1')
    assert.equal(subscriptions[0]?.employeeId, 'employee-1')
  })

  it('sends subscriptionId, never instanceId, for employment tokens', async () => {
    let body = ''
    globalThis.fetch = async (_input, init) => { body = String(init?.body); return jsonResponse({ employmentToken: 'employment', expiresIn: 900, employment: { id: 'sub-1', name: 'Commerce', templateId: 'employee-1', status: 'ACTIVE' } }) }
    const response = await getEmploymentToken({ refreshToken: 'refresh', subscriptionId: 'sub-1' })
    assert.deepEqual(JSON.parse(body), { refreshToken: 'refresh', subscriptionId: 'sub-1' })
    assert.equal(response.employmentToken, 'employment')
    assert.equal(body.includes('instanceId'), false)
  })

  it('keeps the nested skills response unchanged', async () => {
    const payload = { subscriptionId: 'sub-1', canManage: false, skills: [{ capability: { id: 'cap-1', name: 'Orders', description: 'desc', type: 'SKILL' }, currentVersion: { id: 'version-1', capabilityId: 'cap-1', scope: 'PLATFORM', enterpriseId: null, version: '1.0.0', changeSummary: 'initial', status: 'PLATFORM_APPROVED', createdAt: '2026-09-11T07:00:00.000Z', updatedAt: '2026-09-11T07:00:00.000Z' }, versions: [], upgradeAvailable: false }] }
    globalThis.fetch = async () => jsonResponse(payload)
    assert.deepEqual(await getEmployeeSkills('employee/1', 'access'), payload)
  })

  it('uses the final package response without reshaping it', async () => {
    const payload = { version: '1.2.0', packageRef: { type: 'npm', spec: '@sep/employee-commerce@1.2.0' }, zipAvailable: false, sha256: null }
    globalThis.fetch = async () => jsonResponse(payload)
    assert.deepEqual(await getPackageInfo('sub/1', 'access'), payload)
  })

  it('preserves the platform error envelope', async () => {
    globalThis.fetch = async () => jsonResponse({ statusCode: 401, message: 'Invalid or expired refresh token', requestId: 'req-1', timestamp: '2026-09-11T07:00:00.000Z', path: '/api/client/auth/token' }, 401)
    await assert.rejects(() => getEmploymentToken({ refreshToken: 'refresh', subscriptionId: 'sub-1' }), error => {
      assert.equal((error as { error: { statusCode: number; requestId?: string } }).error.statusCode, 401)
      assert.equal((error as { error: { requestId?: string } }).error.requestId, 'req-1')
      return true
    })
  })
})

describe('SEP employee conversation message contract', () => {
  it('uploads an idempotent user or assistant message with encoded client identifiers', async () => {
    let request: RequestInit | undefined
    let url = ''
    globalThis.fetch = async (input, init) => {
      url = String(input)
      request = init
      return jsonResponse({ data: {
        conversationId: 'conversation-1',
        messageId: 'message-1',
        clientConversationId: 'task/1',
        clientMessageId: 'run/1-user',
        duplicate: false,
      } })
    }

    const result = await saveEmployeeConversationMessage('task/1', 'run/1-user', {
      subscriptionId: 'subscription-1',
      role: 'user',
      content: 'hello',
      runId: 'run/1',
      turnId: 'run/1',
      modelId: 'model-1',
      createdAt: '2026-09-19T12:00:00.000Z',
    }, 'access')

    assert.match(url, /\/client\/employee-conversations\/task%2F1\/messages\/run%2F1-user$/)
    assert.equal(request?.method, 'PUT')
    const headers = new Headers(request?.headers)
    assert.equal(headers.get('Authorization'), 'Bearer access')
    assert.equal(headers.get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(String(request?.body)), {
      subscriptionId: 'subscription-1',
      role: 'user',
      content: 'hello',
      runId: 'run/1',
      turnId: 'run/1',
      modelId: 'model-1',
      createdAt: '2026-09-19T12:00:00.000Z',
    })
    assert.equal(result.data.duplicate, false)
  })
})
