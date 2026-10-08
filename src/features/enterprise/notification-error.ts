/** Electron and upstream errors may contain stack traces or URLs; never render them verbatim. */
export function notificationErrorMessage(error: unknown, operation: 'read' | 'mutation' = 'read'): string {
  const message = error instanceof Error ? error.message : ''
  if (/No handler registered for ['"]notifications:/.test(message)) {
    return '通知服务已更新，请重启客户端后查看。'
  }
  if (message === '通知服务尚未就绪，请稍后重试。') {
    return '通知服务尚未就绪，请重启客户端后重试。'
  }
  if (/\b401\b|authentication required|登录状态已过期/i.test(message)) {
    return '登录状态已过期，请重新登录。'
  }
  if (message === '通知链接不属于可信的 SEP 平台页面') return '此通知链接暂时无法打开。'
  return operation === 'mutation' ? '操作未完成，请稍后重试。' : '暂时无法获取通知，请稍后重试。'
}
