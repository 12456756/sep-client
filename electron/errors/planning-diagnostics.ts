import { createHash } from 'node:crypto'
import type { LogFields } from '../common/logger'
import { redactText } from '../common/redact'
import { AppError } from './app-error'

export type PlanningEmployeeScope = 'authorized' | 'enterprise' | 'platform'
export type PlanningPhase =
  | 'initialization' | 'employee-loading' | 'provider-request' | 'response-assembly'
  | 'json-extraction' | 'json-parse' | 'output-validation' | 'employee-validation'
  | 'model-validation' | 'dag-validation' | 'finalization' | 'cleanup'
  | 'round-1' | 'round-2' | 'round-3'

export interface PlanningDiagnosticContext {
  round: number
  employeeScope: PlanningEmployeeScope
}

export function planningFailure(phase: PlanningPhase, reason: string, cause?: unknown): AppError {
  return new AppError('PLANNING_FAILED', { cause, details: { phase, reason } })
}

export function planningErrorFields(error: unknown): LogFields {
  let root = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && root instanceof Error && root.cause !== undefined && !seen.has(root); depth += 1) {
    seen.add(root)
    root = root.cause
  }
  const message = root instanceof Error ? root.message : typeof root === 'string' ? root : ''
  const record = root && typeof root === 'object' ? root as Record<string, unknown> : {}
  const status = record.status ?? record.statusCode
  const providerStatus = typeof status === 'number' && status >= 400 && status <= 599
    ? status : Number(/^(?:HTTP\s+)?([45]\d{2})(?:\D|$)/i.exec(message)?.[1]) || undefined
  const causeType = root instanceof Error ? root.name : typeof root
  const stack = root instanceof Error ? root.stack?.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 12).join('\n') : undefined
  const code = typeof record.code === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(record.code) ? record.code : undefined
  const reason = error instanceof AppError && typeof error.details?.reason === 'string' ? error.details.reason
    : error instanceof AppError && error.code === 'AUTH_REQUIRED' ? 'authentication-required'
    : (code && /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(code)) || /^(?:fetch failed|network error|network request failed|connect |connection |request timed out)/i.test(message) ? 'network-error'
      : /model_not_found/i.test(message) ? 'model-not-configured'
        : providerStatus ? 'provider-error' : 'internal-error'
  const parseOffset = root instanceof SyntaxError ? /(?:position|column)\s+(\d+)/i.exec(message)?.[1] : undefined
  return {
    errorCode: error instanceof AppError ? error.code : 'PLANNING_FAILED',
    ...(error instanceof AppError && typeof error.details?.phase === 'string' ? { phase: error.details.phase } : {}),
    reason,
    causeMessage: reason,
    causeType: redactText(causeType, 80),
    causeMessageLength: message.length,
    causeFingerprint: createHash('sha256').update(message).digest('hex'),
    ...(providerStatus ? { providerStatus } : {}),
    ...(code ? { causeCode: code } : {}),
    ...(parseOffset ? { parseOffset: Number(parseOffset) } : {}),
    ...(stack ? { stack: redactText(stack, 4096) } : {}),
  }
}
