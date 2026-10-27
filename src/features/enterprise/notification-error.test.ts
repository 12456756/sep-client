import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { notificationCooldownDelay, notificationErrorMessage, notificationRetryDelay } from './notification-error'
import { assertNotificationCommand } from './notification-state'

describe('notification user-facing errors', () => {
  it('preserves IPC rate-limit metadata and explains the actual failure', () => {
    let failure: unknown
    try { assertNotificationCommand({ success: false, error: { code: 'RATE_LIMITED', statusCode: 429, message: 'safe message', retryAfterMs: 65_000 } }) } catch (error) { failure = error }
    assert.equal(notificationErrorMessage(failure), '通知请求较多，请稍后重试。')
    assert.equal(notificationRetryDelay(failure, 0), 65_000)
    assert.equal(notificationRetryDelay(failure, 3), null)
    assert.equal(notificationCooldownDelay(failure), 65_000)
  })
  it('backs off transient failures without retrying authentication or invalid payload errors', () => {
    assert.equal(notificationRetryDelay({ statusCode: 429 }, 0), 60_000)
    assert.equal(notificationRetryDelay(new TypeError('Failed to fetch'), 0), 3_000)
    assert.equal(notificationRetryDelay({ statusCode: 503 }, 1), 6_000)
    assert.equal(notificationRetryDelay({ statusCode: 401 }, 0), null)
    assert.equal(notificationRetryDelay(new Error('Invalid response'), 0), null)
    assert.equal(notificationRetryDelay({ statusCode: 429, retryAfterMs: NaN }, 0), 60_000)
    assert.equal(notificationCooldownDelay({ statusCode: 429, retryAfterMs: 1 }), 1000)
    assert.equal(notificationCooldownDelay({ statusCode: 503 }), null)
  })
  it('explains stale main/preload without leaking IPC diagnostics', () => {
    for (const channel of ['notifications:list', 'notifications:unread-count']) {
      const raw = new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`)
      assert.equal(notificationErrorMessage(raw), '通知服务已更新，请重启客户端后查看。')
    }
    assert.equal(notificationErrorMessage(new Error('通知服务尚未就绪，请稍后重试。')), '通知服务尚未就绪，请重启客户端后重试。')
  })
  it('uses a single calm message instead of arbitrary backend errors, stacks or secrets', () => {
    for (const error of [new Error('fetch failed https://host/api?token=private'), new Error('SQL constraint user_secret'), new TypeError('Failed to fetch'), null]) {
      assert.equal(notificationErrorMessage(error), '暂时无法获取通知，请稍后重试。')
      assert.equal(notificationErrorMessage(error, 'mutation'), '操作未完成，请稍后重试。')
    }
  })
  it('keeps actionable auth and safe link errors', () => {
    assert.equal(notificationErrorMessage(new Error('Authentication required (401)')), '登录状态已过期，请重新登录。')
    assert.equal(notificationErrorMessage(new Error('通知链接不属于可信的 SEP 平台页面'), 'mutation'), '此通知链接暂时无法打开。')
  })
})
