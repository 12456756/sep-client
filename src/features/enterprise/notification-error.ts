/** Electron and upstream errors may contain stack traces or URLs; never render them verbatim. */
export function notificationErrorMessage(error: unknown, operation: 'read' | 'mutation' = 'read'): string {
  const failure = error && typeof error === 'object' ? error as { statusCode?: number; code?: string } : {}
  if (failure.statusCode === 429 || failure.code === 'RATE_LIMITED') return '通知请求较多，请稍后重试。'
  if (failure.statusCode === 401 || failure.code === 'AUTH_REQUIRED') return '登录状态已过期，请重新登录。'
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

/** Retry only transient failures, at most three times; honor upstream rate-limit windows. */
export function notificationRetryDelay(error: unknown, attempt: number): number | null {
  if (attempt >= 3) return null
  const failure = error && typeof error === 'object' ? error as { statusCode?: number; code?: string; retryAfterMs?: number } : {}
  if (failure.statusCode === 429 || failure.code === 'RATE_LIMITED') {
    return typeof failure.retryAfterMs === 'number' && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0
      ? Math.max(1000, failure.retryAfterMs) : 60_000
  }
  if (failure.statusCode === 0 || (failure.statusCode !== undefined && failure.statusCode >= 500)
    || failure.code === 'NETWORK_ERROR' || failure.code === 'SERVICE_UNAVAILABLE'
    || error instanceof TypeError || error instanceof Error && error.name === 'TimeoutError') return Math.min(30_000, 3000 * 2 ** attempt)
  return null
}
