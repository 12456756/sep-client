import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { notificationErrorMessage } from './notification-error'

describe('notification user-facing errors', () => {
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
