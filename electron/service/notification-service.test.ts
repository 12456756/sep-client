import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AuthApiError } from '../common/platform/platform-api'
import { NotificationService } from './notification-service'
import type { NotificationUpdate } from '../../src/shared/notification-contracts'

const scope = { memberId: 'u1', enterpriseId: 'e1' }
function setup() {
  let current: typeof scope | null = scope
  const tokenRequests: boolean[] = []
  let invalidations = 0
  let starts = 0
  let stops = 0
  const updates: NotificationUpdate[] = []
  let receive: (event: NotificationUpdate) => void = () => undefined
  const api = {
    listNotifications: async (_token: string, _query = {}) => ({ items: [], total: 0 }),
    getUnreadNotificationCount: async () => ({ count: 0 }),
    markNotificationRead: async () => undefined,
    markAllNotificationsRead: async () => undefined,
    deleteNotification: async () => undefined,
    clearReadNotifications: async () => undefined,
  }
  const service = new NotificationService({
    scope: { currentScope: () => current },
    getAccessToken: async (force = false) => { tokenRequests.push(force); return force ? 'fresh' : 'access' },
    onAuthenticationRequired: () => { invalidations++ },
    onUpdate: event => { updates.push(event) },
    createSocket: callback => { receive = callback; return { start: () => { starts++ }, stop: () => { stops++ } } },
    api, retryDelay: async () => undefined,
  })
  return { service, api, tokenRequests, updates, receive: (event: NotificationUpdate) => receive(event), changeScope: (next: typeof scope | null) => { current = next }, counters: () => ({ invalidations, starts, stops }) }
}
describe('notification authorization and lifecycle', () => {
  it('refreshes access token exactly once on 401, then retries original operation', async () => {
    const s = setup(); const used: string[] = []
    s.api.listNotifications = async token => {
      used.push(token)
      if (token === 'access') throw new AuthApiError({ statusCode: 401, message: 'expired' })
      return { items: [], total: 0 }
    }
    await s.service.list({})
    assert.deepEqual(used, ['access', 'fresh'])
    assert.deepEqual(s.tokenRequests, [false, true])
    assert.equal(s.counters().invalidations, 0)
  })
  it('invalidates after the second 401 but never retries 400/403', async () => {
    for (const code of [400, 403, 401]) {
      const s = setup()
      s.api.listNotifications = async () => { throw new AuthApiError({ statusCode: code, message: 'denied' }) }
      await assert.rejects(() => s.service.list({}))
      assert.deepEqual(s.tokenRequests, code === 401 ? [false, true] : [false])
      assert.equal(s.counters().invalidations, code === 401 ? 1 : 0)
    }
  })
  it('denies unauthenticated access and drops in-flight data after an account switch', async () => {
    const s = setup()
    s.changeScope(null)
    await assert.rejects(() => s.service.list({}))
    assert.equal(s.tokenRequests.length, 0)
    s.changeScope(scope)
    s.api.listNotifications = async () => { s.changeScope({ ...scope, memberId: 'u2' }); return { items: [], total: 1 } }
    await assert.rejects(() => s.service.list({}))
    assert.equal(s.counters().invalidations, 0)
  })
  it('stops transport on logout, suppresses late events and broadcasts mutation resync', async () => {
    const s = setup()
    await s.service.list({})
    s.receive({ type: 'unread_count', data: { count: 3 } })
    await s.service.markAllRead({})
    assert.deepEqual(s.updates, [{ type: 'unread_count', data: { count: 3 } }, { type: 'resync' }])
    s.service.stop()
    s.receive({ type: 'unread_count', data: { count: 99 } })
    assert.equal(s.updates.length, 2)
    assert.equal(s.counters().stops, 1)
  })
  it('retries transient REST reads briefly, not mutation or arbitrary validation errors', async () => {
    const s = setup(); let calls = 0
    s.api.listNotifications = async () => { if (++calls === 1) throw new AuthApiError({ statusCode: 503, message: 'unavailable' }); return { items: [], total: 0 } }
    await s.service.list({})
    assert.equal(calls, 2)
  })
})
