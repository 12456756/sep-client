import type { ApiDiagnostic } from '../../src/shared/api-diagnostic'
import { RUNTIME_FAILURE_MESSAGES, type RuntimeFailureCode } from '../../src/shared/runtime-feedback'

function gatewaySpecificCode(diagnostic: ApiDiagnostic): RuntimeFailureCode | undefined {
  const code = typeof diagnostic.code === 'string' ? diagnostic.code.toUpperCase() : ''
  const reason = diagnostic.message ?? ''
  if (code === 'UPSTREAM_INCOMPLETE_STREAM') return 'MODEL_RESPONSE_INTERRUPTED'
  if (code === 'UPSTREAM_INVALID_COMPLETION') return 'MODEL_INVALID_COMPLETION'
  if (diagnostic.source === 'upstream' || diagnostic.httpStatus === 200) {
    if (['INVALID_API_KEY', 'AUTHENTICATION_ERROR'].includes(code) || /\binvalid (?:provider )?api key\b/i.test(reason)) return 'MODEL_PROVIDER_AUTH_FAILED'
  }
  if (diagnostic.httpStatus === 429 || diagnostic.httpStatus === 402 || diagnostic.httpStatus === 200 || diagnostic.computeStatus === 429 || diagnostic.computeStatus === 402) {
    if (/(?:^|_)(?:INSUFFICIENT_FUNDS|INSUFFICIENT_BALANCE|BALANCE_INSUFFICIENT|BALANCE_EXHAUSTED|PAYMENT_REQUIRED)$/.test(code) || /\b(?:insufficient (?:funds|balance)|balance (?:is )?insufficient)\b|余额不足/.test(reason.toLowerCase())) return 'MODEL_INSUFFICIENT_FUNDS'
    if (/(?:^|_)(?:INSUFFICIENT_QUOTA|QUOTA_EXCEEDED|QUOTA_EXHAUSTED|QUOTA_INSUFFICIENT)$/.test(code) || /\b(?:insufficient quota|quota (?:has been )?(?:exceeded|exhausted))\b|额度不足/i.test(reason)) return 'MODEL_QUOTA_EXCEEDED'
    if (/CONCURRENC(?:Y|E).*LIMIT|TOO_MANY_CONCURRENT/.test(code) || /\b(?:concurrency limit|too many concurrent)\b|并发(?:数)?(?:已达|超出|上限)/i.test(reason)) return 'MODEL_CONCURRENCY_LIMIT'
  }
  return undefined
}

export function gatewayDisallowsRetry(diagnostic: ApiDiagnostic): boolean {
  const code = gatewaySpecificCode(diagnostic)
  return diagnostic.retryable === false || code === 'MODEL_QUOTA_EXCEEDED' || code === 'MODEL_INSUFFICIENT_FUNDS' || code === 'MODEL_PROVIDER_AUTH_FAILED'
}

export function gatewayFailureMessage(diagnostic: ApiDiagnostic): string {
  const specific = gatewaySpecificCode(diagnostic)
  if (specific) return RUNTIME_FAILURE_MESSAGES[specific]
  const status = diagnostic.httpStatus
  if (status === 401 && diagnostic.source !== 'upstream') return RUNTIME_FAILURE_MESSAGES.AUTH_REQUIRED
  if (status === 403) return RUNTIME_FAILURE_MESSAGES.REQUEST_DENIED
  if (status === 429) return RUNTIME_FAILURE_MESSAGES.RATE_LIMITED
  if (status === 408 || status === 504) return RUNTIME_FAILURE_MESSAGES.MODEL_TIMEOUT
  return RUNTIME_FAILURE_MESSAGES.SERVICE_UNAVAILABLE
}

/** The provider SDK needs its own error shape; retain raw evidence separately. */
export function gatewaySdkErrorBody(diagnostic: ApiDiagnostic): { error: { message: string } } {
  // Pi uses provider reasons to recognize context overflow and recover via compaction.
  // Known gateway failures use canonical copy that survives SDK formatting.
  const message = diagnostic.httpStatus === 401 || gatewaySpecificCode(diagnostic)
    ? gatewayFailureMessage(diagnostic) : diagnostic.message || gatewayFailureMessage(diagnostic)
  return { error: { message } }
}
