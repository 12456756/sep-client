import type { LoginFeedbackReason } from '../../../src/shared/login-feedback'

export class LoginFeedbackError extends Error {
  constructor(readonly reason: LoginFeedbackReason, cause?: unknown) {
    super(`Login operation failed: ${reason}`, { cause })
    this.name = 'LoginFeedbackError'
  }
}

export function isTransportTimeout(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false
  const value = error as { name?: unknown; code?: unknown; cause?: unknown }
  return value.name === 'TimeoutError' ||
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(value.code)) ||
    (value.cause !== error && Boolean(value.cause) && isTransportTimeout(value.cause, depth + 1))
}
