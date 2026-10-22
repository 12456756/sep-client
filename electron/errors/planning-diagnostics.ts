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

const contractFields = new Set([
  'objective', 'knowledgeQuery', 'deliverables', 'mediaRequirements', 'id', 'name', 'format', 'path',
  'contentOutline', 'acceptanceCriteria', 'artifact', 'kind', 'source', 'operation', 'required',
  'inputFrom', 'nodeId', 'deliverableId', 'artifactId', 'inputSelection', 'preferred',
  'aspectRatio', 'resolution', 'durationSeconds', 'frameRate', 'audio', 'outputFormat', 'count',
])

function safeContractPath(path: readonly PropertyKey[]): string {
  return path.slice(0, 12).map(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0
    ? String(part) : typeof part === 'string' && contractFields.has(part) ? part : 'field').join('.')
}

export function planningContractFailure(nodeIndex: number, issues: readonly { path: readonly PropertyKey[]; code: string }[], hint = '请重新规划。'): AppError {
  const validationIssues = issues.slice(0, 8).map(issue => ({
    path: safeContractPath(issue.path),
    code: /^[a-z_]{1,64}$/.test(issue.code) ? issue.code : 'invalid',
  }))
  return new AppError('PLANNING_FAILED', {
    message: `第 ${nodeIndex + 1} 个节点的媒体或交付字段不符合要求（${validationIssues[0]?.path || '节点字段'}），${hint}`,
    details: { phase: 'output-validation', reason: 'invalid-node-work-contract', nodeIndex, validationIssues },
  })
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
    ...(error instanceof AppError && error.details?.reason === 'invalid-node-work-contract' &&
      Number.isSafeInteger(error.details.nodeIndex) && Array.isArray(error.details.validationIssues) ? {
        nodeIndex: error.details.nodeIndex,
        validationIssues: error.details.validationIssues.slice(0, 8).map((issue: unknown) => {
          const item = issue && typeof issue === 'object' ? issue as Record<string, unknown> : {}
          return {
            path: typeof item.path === 'string' ? safeContractPath(item.path.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part)) : 'field',
            code: typeof item.code === 'string' && /^[a-z_]{1,64}$/.test(item.code) ? item.code : 'invalid',
          }
        }),
      } : {}),
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
