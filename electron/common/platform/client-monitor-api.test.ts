import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ClientMonitorApi, ClientMonitorApiError } from './client-monitor-api'

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
    assert.equal(JSON.parse(String(calls[0].init.body)).status, 'RUNNING')
    assert.equal(JSON.stringify(calls[0].init.body).includes('access-token'), false)
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
    const api = new ClientMonitorApi({
      baseUrl: 'https://sep.example/api',
      getAccessToken: async () => `token-${++tokenCalls}`,
      fetch: async () => {
        calls += 1
        return calls === 1 ? response(401, { message: 'expired' }) : response(200, { id: 'mirror' })
      },
    })
    assert.equal((await api.createTask({ clientTaskId: 'task', clientRunId: 'run', subscriptionId: 'sub', title: 'Task' })).id, 'mirror')
    assert.equal(calls, 2)
    assert.equal(tokenCalls, 2)

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
})
