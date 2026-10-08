/** Compact relative dates for the notification preview; the full date stays in the tooltip. */
export function notificationTimeLabel(createdAt: string, now = Date.now()): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) return '未知时间'
  const seconds = Math.floor((now - date.getTime()) / 1000)
  if (seconds < 0) return date.toLocaleDateString('zh-CN')
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}
