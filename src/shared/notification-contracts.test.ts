import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { notificationPageSchema, notificationQuerySchema, notificationSocketMessageSchema } from './notification-contracts'

export const notificationFixture = {
  id: 'notice-1', type: 'INFO', title: '系统通知', message: '测试消息',
  relatedType: null, relatedId: null, read: false, category: 'SYSTEM',
  severity: 'INFO', actionUrl: null, createdAt: '2026-10-08T08:30:00.000Z',
}

describe('notification v1 contracts', () => {
  it('requires the REST page envelope and rejects old categories and invalid pagination', () => {
    assert.equal(notificationPageSchema.parse({ items: [notificationFixture], total: 1 }).total, 1)
    assert.equal(notificationPageSchema.safeParse([notificationFixture]).success, false)
    for (const query of [{ category: 'BILLING' }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: 1.5 }, { unreadOnly: 'false' }]) {
      assert.equal(notificationQuerySchema.safeParse(query).success, false)
    }
    assert.deepEqual(notificationQuerySchema.parse({ limit: 50, offset: 0, unreadOnly: false }), { limit: 50, offset: 0, unreadOnly: false })
  })
  it('accepts documented WS messages with missing relationship fields, not event-based messages', () => {
    const { relatedType: _type, relatedId: _id, ...data } = notificationFixture
    const message = notificationSocketMessageSchema.parse({ type: 'notification', data, timestamp: 1 })
    assert.equal(message.type, 'notification')
    assert.equal(notificationSocketMessageSchema.safeParse({ event: 'notification', data }).success, false)
    assert.equal(notificationSocketMessageSchema.safeParse({ type: 'unread_count', data: { count: -1 } }).success, false)
    assert.equal(notificationSocketMessageSchema.safeParse({ type: 'pong', timestamp: 1 }).success, true)
  })
})
