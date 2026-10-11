import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ClientMonitorApi, ClientMonitorApiError } from './client-monitor-api'
import { config } from '../config'

type Call = { url: string; init: RequestInit }

function response(status: number, body: unknown = {}): Response {
  return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('ClientMonitorApi', () => {
  it('uses SEP monitor routes, bearer auth, and preserves encoded mirror ids', async () => {
    const calls: Call[] = []
    const api = new ClientMonitorApi({
      baseUrl: 'https://sep.example/api/',
      getAccessToken: async () => 'access-token',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return response(204)
      },
    })

    await api.updateStatus('mirror/a?b', { status: 'RUNNING' })
    await api.sendHeartbeat('mirror/a?b', { clientVersion: '1.0.0' })
    await api.sendEvent('mirror/a?b', {
      sequence: 1,
      type: 'run_started',
      occurredAt: '2026-09-22T00:00:00.000Z',
    })

    assert.deepEqual(calls.map(call => [call.url, call.init.method]), [
      ['https://sep.example/api/client/tasks/mirror%2Fa%3Fb/status', 'PATCH'],
      ['https://sep.example/api/client/tasks/mirror%2Fa%3Fb/heartbeat', 'POST'],
      ['https://sep.example/api/client/tasks/mirror%2Fa%3Fb/events', 'POST'],
    ])
    assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization, 'Bearer access-token')
    for (const call of calls) {
      const headers = new Headers(call.init.headers)
      assert.equal(headers.get('Origin'), config.SEP_WEB_ORIGIN)
      assert.equal(headers.get('Referer'), config.SEP_WEB_ORIGIN + '/')
    }
    assert.equal(JSON.parse(String(calls[0].init.body)).status, 'RUNNING')
    assert.equal(JSON.stringify(calls[0].init.body).includes('access-token'), false)
  })

  it('uses the normalized injected Web origin for all four writes across separate API domains', async () => {
    const calls: Call[] = []
    const api = new ClientMonitorApi({
      baseUrl: 'https://api.example/api/', webOrigin: 'https://WEB.example:443/workspace?secret=ignored',
      getAccessToken: async () => 'access-token',
      fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return response(200, { id: 'mirror' }) },
    })
    await api.createTask({ clientTaskId: 'task', clientRunId: 'run', subscriptionId: 'sub', title: 'Task' })
    await api.updateStatus('mirror', { status: 'RUNNING' })
    await api.sendHeartbeat('mirror', { clientVersion: '1.0.0' })
    await api.sendEvent('mirror', { sequence: 1, type: 'run_started', occurredAt: '2026-10-09T00:00:00.000Z' })
    assert.equal(calls.length, 4)
    for (const call of calls) {
      assert.ok(call.url.startsWith('https://api.example/api/client/tasks'))
      const headers = new Headers(call.init.headers)
      assert.equal(headers.get('Origin'), 'https://web.example')
      assert.equal(headers.get('Referer'), 'https://web.example/')
      assert.equal(headers.get('Authorization'), 'Bearer access-token')
    }
  })

  it('exposes only exact known 403 reasons and retains HTTP and Retry-After metadata', async () => {
    for (const [message, reason] of [
      ['Missing Origin or Referer header', 'Missing Origin or Referer header'],
      ['Invalid Origin or Referer header', 'Invalid Origin or Referer header'],
      ['Origin https://web.example not allowed. CSRF protection.', 'Origin not allowed. CSRF protection.'],
      ['Subscription unavailable', 'Subscription unavailable'],
      ['没有有效的员工使用授权', '没有有效的员工使用授权'],
    ]) {
      const api = new ClientMonitorApi({
        webOrigin: 'https://web.example', getAccessToken: async () => 'token',
        fetch: async () => new Response(JSON.stringify({ message, private: 'Bearer remote-secret' }), { status: 403, headers: { 'Retry-After': '7' } }),
      })
      await assert.rejects(api.updateStatus('mirror', { status: 'RUNNING' }), (error: unknown) => {
        assert.ok(error instanceof ClientMonitorApiError)
        assert.equal(error.message, 'SEP monitor HTTP 403: ' + reason)
        assert.equal(error.statusCode, 403)
        assert.equal(error.retryAfterMs, 7000)
        assert.equal(error.isRetryable, false)
        return true
      })
    }
  })

  it('discards unknown, malformed, oversized and lookalike 403 bodies', async () => {
    for (const body of [
      'Bearer remote-secret', '{broken',
      JSON.stringify({ message: 'Missing Origin or Referer header Bearer remote-secret' }),
      JSON.stringify({ message: 'Origin https://other.example not allowed. CSRF protection.' }),
      JSON.stringify({ message: ['Subscription unavailable', 'remote-secret'] }),
      JSON.stringify({ message: 'Subscription unavailable', private: 'x'.repeat(5000) }),
    ]) {
      const api = new ClientMonitorApi({
        webOrigin: 'https://web.example', getAccessToken: async () => 'token',
        fetch: async () => new Response(body, { status: 403 }),
      })
      await assert.rejects(api.updateStatus('mirror', { status: 'RUNNING' }), (error: unknown) => {
        assert.ok(error instanceof ClientMonitorApiError)
        assert.equal(error.statusCode, 403)
        assert.equal(error.message, 'SEP monitor HTTP 403')
        return true
      })
    }
  })

  it('accepts flat and enveloped create responses', async () => {
    let index = 0
    const api = new ClientMonitorApi({
      baseUrl: 'https://sep.example/api',
      getAccessToken: async () => 'token',
      fetch: async () => response(200, index++ === 0 ? { id: 'flat-id' } : { data: { id: 'enveloped-id' } }),
    })
    const request = { clientTaskId: 'task', clientRunId: 'run', subscriptionId: 'sub', title: 'Task' }
    assert.equal((await api.createTask(request)).id, 'flat-id')
    assert.equal((await api.createTask(request)).id, 'enveloped-id')
  })

  it('refreshes the token path by retrying one 401 and rejects a second 401', async () => {
    let calls = 0
    let tokenCalls = 0
    const headers: Headers[] = []
    const api = new ClientMonitorApi({
      baseUrl: 'https://sep.example/api',
      getAccessToken: async () => `token-${++tokenCalls}`,
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers))
        calls += 1
        return calls === 1 ? response(401, { message: 'expired' }) : response(200, { id: 'mirror' })
      },
    })
    assert.equal((await api.createTask({ clientTaskId: 'task', clientRunId: 'run', subscriptionId: 'sub', title: 'Task' })).id, 'mirror')
    assert.equal(calls, 2)
    assert.equal(tokenCalls, 2)
    assert.deepEqual(headers.map(value => value.get('Authorization')), ['Bearer token-1', 'Bearer token-2'])
    assert.ok(headers.every(value => value.get('Origin') === config.SEP_WEB_ORIGIN && value.get('Referer') === config.SEP_WEB_ORIGIN + '/'))

    const failing = new ClientMonitorApi({
      baseUrl: 'https://sep.example/api',
      getAccessToken: async () => 'token',
      fetch: async () => response(401),
    })
    await assert.rejects(() => failing.createTask({ clientTaskId: 'task', clientRunId: 'run', subscriptionId: 'sub', title: 'Task' }), (error: unknown) => {
      assert.ok(error instanceof ClientMonitorApiError)
      assert.equal(error.statusCode, 401)
      return true
    })
  })

  it('does not treat permanent client errors as retryable', async () => {
    const api = new ClientMonitorApi({
      getAccessToken: async () => 'token',
      fetch: async () => response(403),
    })
    await assert.rejects(() => api.updateStatus('mirror', { status: 'RUNNING' }), (error: unknown) => {
      assert.ok(error instanceof ClientMonitorApiError)
      assert.equal(error.isRetryable, false)
      return true
    })
  })
  it('parses Retry-After seconds and HTTP dates without reading error bodies', async () => {
    for (const [header, expected] of [['12', 12000], ['Thu, 08 Oct 2026 00:01:00 GMT', 60000]] as const) {
      const api = new ClientMonitorApi({
        now: () => Date.parse('2026-10-08T00:00:00Z'),
        getAccessToken: async () => 'token',
        fetch: async () => new Response('private remote body', { status: 429, headers: { 'Retry-After': header } }),
      })
      await assert.rejects(api.updateStatus('mirror', { status: 'RUNNING', clientRunId: 'run' }), (error: unknown) => {
        assert.ok(error instanceof ClientMonitorApiError)
        assert.equal(error.retryAfterMs, expected)
        assert.equal(error.message.includes('private'), false)
        return true
      })
    }
  })

  it('never sends an old request with a token obtained after a scope switch', async () => {
    let current = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
    let fetches = 0
    const api = new ClientMonitorApi({
      scopeProvider: () => current,
      getAccessToken: async () => { current = { enterpriseId: 'enterprise-b', memberId: 'member-b' }; return 'new-token' },
      fetch: async () => { fetches++; return response(204) },
    })
    await assert.rejects(api.updateStatus('old-mirror', { status: 'RUNNING' }))
    assert.equal(fetches, 0)
  })

  it('also checks scope after the 401 forced-refresh await', async () => {
    let scope = { enterpriseId: 'a', memberId: 'a' }
    let calls = 0
    const api = new ClientMonitorApi({
      scopeProvider: () => scope,
      getAccessToken: async force => { if (force) scope = { enterpriseId: 'b', memberId: 'b' }; return 'mock' },
      fetch: async () => { calls++; return response(401) },
    })
    await assert.rejects(api.updateStatus('old', { status: 'RUNNING' }))
    assert.equal(calls, 1)
  })

})
