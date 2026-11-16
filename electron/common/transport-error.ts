/** Recognize transport failures without treating arbitrary TypeErrors or cancellation as networking. */
export function transportKind(error: unknown, depth = 0): 'network' | 'timeout' | null {
  if (!error || typeof error !== 'object' || depth > 4) return null
  const value = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; errors?: unknown }
  if (value.name === 'AbortError') return null
  const code = typeof value.code === 'string' ? value.code : ''
  if (value.name === 'TimeoutError' || value.name === 'APIConnectionTimeoutError' || value.message === 'Request timed out.' ||
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout'
  const nested = transportKind(value.cause, depth + 1)
  if (nested) return nested
  if (Array.isArray(value.errors)) {
    const kinds = value.errors.slice(0, 20).map(item => transportKind(item, depth + 1))
    if (kinds.includes('timeout')) return 'timeout'
    if (kinds.includes('network')) return 'network'
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'network'
  return error instanceof TypeError && /^(?:fetch failed|failed to fetch|network request failed|load failed)$/i.test(error.message)
    ? 'network' : null
}
