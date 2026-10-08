import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notificationTimeLabel } from './notification-time'

test('notification dates use compact relative labels and safe full dates for future values', () => {
  const now = Date.parse('2026-10-08T08:00:00Z')
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
  for (const [seconds, label] of [[0, '刚刚'], [59, '刚刚'], [60, '1 分钟前'], [3599, '59 分钟前'], [3600, '1 小时前'], [86400, '1 天前'], [18 * 86400, '18 天前']] as const) {
    assert.equal(notificationTimeLabel(ago(seconds), now), label)
  }
  const future = ago(-86400)
  assert.equal(notificationTimeLabel(future, now), new Date(future).toLocaleDateString('zh-CN'))
  assert.equal(notificationTimeLabel('invalid', now), '未知时间')
})
