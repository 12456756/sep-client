import { diagnosticEvidence, MAX_MEDIA_DIAGNOSTIC_ERRORS, type DiagnosticEvidence, type DiagnosticException, type DiagnosticExceptionChain, type MediaDiagnosticErrors } from '../domain/arrangement-diagnostic'
import type { MediaFailure } from '../../src/shared/media-failure'
import type { ApiDiagnostic } from '../../src/shared/api-diagnostic'
import { ArrangementMediaRecoveryError } from '../domain/arrangement-media-runtime'
import { DeliveryExecutionError } from '../domain/arrangement-delivery'
import { AuthApiError } from '../common/platform/platform-api'
import { safeApiDiagnostic } from '../common/platform/api-diagnostic'
import { redactModelTraceText } from '../common/redact'
import { AppError } from './app-error'
import { ERROR_CODES } from './error-codes'
import { runtimeFeedback } from './runtime-feedback'

const knownReasons: Readonly<Record<string, string>> = {
  ATTACHMENT_REFERENCE_INVALID: '附件引用不存在或与任务记录不一致。',
  ATTACHMENT_INTEGRITY_MISMATCH: '附件内容与已记录的校验值不一致。',
  EACCES: '本地文件或目录访问被拒绝。', EPERM: '本地操作没有足够权限。',
  ENOSPC: '本地磁盘空间不足。', ENOENT: '本地文件或目录不存在。',
  EIO: '本地文件读写失败。', EBUSY: '本地文件或目录被占用。',
  MODEL_RETRY_BUDGET_EXHAUSTED: '本轮模型请求已达到自动重试上限。',
  SDK_MISSING_FAILURE_REASON: '模型 SDK 报告失败，但未返回具体原因。',
  DELIVERY_VALIDATION: '节点交付未通过验收。',
}

export function pickDiagnosticEvidence(value: { code?: unknown; httpStatus?: unknown; requestId?: unknown }): DiagnosticEvidence | undefined {
  const safe = (field: unknown) => typeof field === 'string' && workDiagnosticText(field) === field ? field : undefined
  const code = diagnosticEvidence.shape.code.safeParse(safe(value.code))
  const httpStatus = diagnosticEvidence.shape.httpStatus.safeParse(value.httpStatus)
  const requestId = diagnosticEvidence.shape.requestId.safeParse(safe(value.requestId))
  const result = { code: code.data, httpStatus: httpStatus.data, requestId: requestId.data }
  return Object.values(result).some(item => item !== undefined) ? result : undefined
}

export function workDiagnosticText(value: unknown, limit = 8192): string | undefined {
  if (typeof value !== 'string') return undefined
  const safe = redactModelTraceText(value).replace(/https?:\/\/[^\s<>"']+/gi, url =>
    /[?#@]/.test(url) ? '[redacted-url]' : url)
  return safe.length <= limit ? safe : `${safe.slice(0, limit - 14)}...[truncated]`
}

export function workApiDiagnostic(value: unknown): ApiDiagnostic | undefined {
  const diagnostic = safeApiDiagnostic(value)
  if (!diagnostic) return undefined
  // Providers can echo an entire request in an otherwise useful error body.
  const encoded = JSON.stringify(diagnostic, (key, entry: unknown) => {
    if (/^(?:authorization|proxy[-_]?authorization|prompt|systemPrompt|messages|input|request|creativeBrief|attachments|referenceAssets|image|video)$/i.test(key)) return undefined
    return typeof entry === 'string' ? workDiagnosticText(entry) : entry
  })
  const safe: ApiDiagnostic = JSON.parse(encoded)
  if (Buffer.byteLength(encoded) > 64 * 1024) {
    delete safe.body
    delete safe.recovery
    delete safe.transportError
    safe.truncated = true
  }
  return safe
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function captureDiagnosticException(error: unknown, maxBytes = 256 * 1024): DiagnosticExceptionChain {
  const entries: DiagnosticException[] = []
  const seen = new Set<object>()
  let bytes = 0
  let truncated = false
  function append(entry: DiagnosticException): boolean {
    let serialized = JSON.stringify(entry)
    let size = Buffer.byteLength(serialized)
    if (!entries.length && size > maxBytes) {
      truncated = true
      const { diagnostic, ...fields } = entry
      serialized = JSON.stringify({ ...fields, stack: workDiagnosticText(entry.stack, 4096), message: workDiagnosticText(entry.message, 4096),
        path: workDiagnosticText(entry.path, 1024), dest: workDiagnosticText(entry.dest, 1024),
        diagnostic: diagnostic && { operation: workDiagnosticText(diagnostic.operation, 256), httpStatus: diagnostic.httpStatus,
          code: typeof diagnostic.code === 'number' ? diagnostic.code : workDiagnosticText(diagnostic.code, 256),
          sepRequestId: workDiagnosticText(diagnostic.sepRequestId, 256), upstreamRequestId: workDiagnosticText(diagnostic.upstreamRequestId, 256),
          message: workDiagnosticText(diagnostic.message, 2048), truncated: true } },
      (_key, value: unknown) => typeof value === 'string' ? workDiagnosticText(value, 4096) : value)
      size = Buffer.byteLength(serialized)
    }
    if (bytes + size > maxBytes) { truncated = true; return false }
    bytes += size
    entries.push(JSON.parse(serialized) as DiagnosticException)
    return true
  }
  function visit(value: unknown, parent?: number, relation?: DiagnosticException['relation']) {
    if (entries.length >= 16) { truncated = true; return }
    if (!value || typeof value !== 'object') {
      append({ parent, relation, message: workDiagnosticText(typeof value === 'function' ? '[thrown function]' : String(value)) })
      return
    }
    if (seen.has(value)) { truncated = true; return }
    seen.add(value)
    const fields = value as Record<string, unknown>
    const index = entries.length
    const status = value instanceof AuthApiError ? value.statusCode : fields.statusCode ?? fields.status
    const details = value instanceof AppError ? value.details : undefined
    const code = workDiagnosticText(fields.code ?? (value instanceof AuthApiError ? value.error.diagnostic?.code : undefined))
    const diagnostic = value instanceof AuthApiError ? {
      operation: value.resource, sepRequestId: value.error.requestId, httpStatus: value.statusCode, ...value.error.diagnostic,
    } : fields.diagnostic
    if (!append({
      parent, relation, name: workDiagnosticText(fields.name), message: workDiagnosticText(fields.message), stack: workDiagnosticText(fields.stack), code,
      status: finite(status), errno: finite(fields.errno) ?? workDiagnosticText(fields.errno), syscall: workDiagnosticText(fields.syscall),
      path: workDiagnosticText(value instanceof AuthApiError ? value.error.path : fields.path), dest: workDiagnosticText(fields.dest), address: workDiagnosticText(fields.address), port: finite(fields.port),
      operation: workDiagnosticText(fields.operation ?? fields.phase),
      timeoutMs: typeof fields.timeoutMs === 'number' && Number.isSafeInteger(fields.timeoutMs) && fields.timeoutMs >= 0 ? fields.timeoutMs : undefined,
      diagnostic: workApiDiagnostic(diagnostic),
      specFailure: code && details && ['field', 'source', 'reasonCode', 'requestedValue', 'submissionState', 'billingState', 'retryable'].some(key => details[key] !== undefined) ? {
        code, field: workDiagnosticText(details.field), source: workDiagnosticText(details.source), reasonCode: workDiagnosticText(details.reasonCode),
        requestedValue: typeof details.requestedValue === 'boolean' ? details.requestedValue : finite(details.requestedValue) ?? workDiagnosticText(details.requestedValue, 96),
        submissionState: workDiagnosticText(details.submissionState), billingState: workDiagnosticText(details.billingState),
        retryable: typeof details.retryable === 'boolean' ? details.retryable : undefined,
      } : undefined,
    })) return
    if (fields.cause !== undefined) visit(fields.cause, index, 'cause')
    if (Array.isArray(fields.errors)) {
      for (const child of fields.errors) {
        if (entries.length >= 16) { truncated = true; break }
        visit(child, index, 'aggregate')
      }
    }
  }
  visit(error)
  return { entries, truncated }
}

export function appendMediaDiagnosticError(previous: MediaDiagnosticErrors | undefined, stage: MediaFailure['stage'], error: unknown,
  timestamp = Date.now()): MediaDiagnosticErrors {
  const entries = [...(previous?.entries ?? []), { stage, timestamp, exception: captureDiagnosticException(error, 48 * 1024) }]
  if (entries.length > MAX_MEDIA_DIAGNOSTIC_ERRORS) {
    // Keep the first submission error even if later retries eventually recover it.
    const firstSubmit = entries.findIndex(entry => entry.stage.endsWith('-submit'))
    entries.splice(firstSubmit === 0 ? 1 : 0, 1)
  }
  return { total: (previous?.total ?? 0) + 1, entries }
}

export function describeArrangementFailure(error: unknown) {
  const feedback = runtimeFeedback(error)
  let evidence: DiagnosticEvidence | undefined
  let reason: string | undefined
  for (let step = error, depth = 0; step instanceof Error && depth < 5; step = step.cause, depth++) {
    const code = 'code' in step && typeof step.code === 'string' ? step.code : undefined
    const diagnostic = step instanceof AppError ? step.diagnostic : step instanceof AuthApiError ? step.error.diagnostic : undefined
    const detail = pickDiagnosticEvidence({ code: diagnostic?.code ?? code,
      httpStatus: diagnostic?.httpStatus ?? (step instanceof AuthApiError ? step.statusCode : 'status' in step ? step.status : undefined),
      requestId: diagnostic?.sepRequestId ?? diagnostic?.upstreamRequestId })
    if (detail) evidence = { code: evidence?.code ?? detail.code, httpStatus: evidence?.httpStatus ?? detail.httpStatus, requestId: evidence?.requestId ?? detail.requestId }
    const known = [code, step.message].find(candidate => candidate && Object.hasOwn(knownReasons, candidate))
    if (known) { reason = known; break }
    if (step instanceof AppError && (!reason || reason.startsWith('MEDIA_'))) reason = step.code
    if (!reason && step instanceof ArrangementMediaRecoveryError) reason = `MEDIA_${step.phase.toUpperCase().replaceAll('-', '_')}`
    if (!reason && step instanceof DeliveryExecutionError) reason = 'DELIVERY_VALIDATION'
    if (!reason && /^本轮自动重试已达到 \d+ 次上限/.test(step.message)) reason = 'MODEL_RETRY_BUDGET_EXHAUSTED'
    if (!reason && step.message === 'Agent run failed.') reason = 'SDK_MISSING_FAILURE_REASON'
    if (!reason && step instanceof TypeError) reason = 'TYPE_ERROR'
    if (!reason && step instanceof SyntaxError) reason = 'SYNTAX_ERROR'
  }
  reason ??= evidence?.code ?? feedback.code
  const summary = (Object.hasOwn(knownReasons, reason) ? knownReasons[reason] : undefined)
    ?? (feedback.code !== 'INTERNAL_ERROR' ? feedback.message
      : reason !== 'INTERNAL_ERROR' && Object.hasOwn(ERROR_CODES, reason) ? ERROR_CODES[reason as keyof typeof ERROR_CODES].message
        : '请结合本次运行阶段和异常详情排查。')
  return { category: feedback.code, reason, summary, evidence, exception: captureDiagnosticException(error) }
}
