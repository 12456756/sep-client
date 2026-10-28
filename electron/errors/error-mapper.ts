/**
 * electron/errors/error-mapper.ts — unknown -> IPC 信封的唯一映射点
 *
 * 所有跨边界错误都在这里统一为渲染进程可识别的错误信封，避免不同入口各自决定
 * 错误码、文案和状态码。
 *
 * 这里需要 instanceof 才能读到各错误类的字段（AuthApiError.statusCode、
 * ConversationRecoveryError.code），所以本模块显式依赖这些错误类；错误定义仍留在
 * 各自所属层，映射逻辑集中在这里。
 */
import { AuthApiError } from '../common/platform/platform-api'
import { LoginFeedbackError } from '../common/platform/login-error'
import { LOGIN_FEEDBACK, type LoginFeedbackReason } from '../../src/shared/login-feedback'
import { KnowledgeApiError } from '../common/platform/knowledge-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { ConversationRecoveryError } from '../runtime/conversation-recovery-error'
import {
  InvalidTaskTransitionError,
  TaskAdmissionError,
  TaskPersistenceError,
  TaskScopeError,
} from '../runtime/task-manager'
import { describeError } from '../common/redact'
import type { AuthError } from '../../src/shared/types'
import { AppError } from './app-error'
import { ERROR_CODES, isErrorCode, type ErrorCode } from './error-codes'
import { operationFeedback } from './operation-feedback'
import type { FeedbackOperation } from '../../src/shared/arrangement-feedback'

/** 送到渲染进程的错误信封。message 是中文，绝不含技术细节。 */
export interface IpcErrorEnvelope {
  code: ErrorCode
  message: string
  statusCode: number
  retryable?: boolean
  platformCode?: string
  requestId?: string
  retryAfterMs?: number
  reason?: LoginFeedbackReason
}

export interface IpcFailure {
  success: false
  error: IpcErrorEnvelope
}

const SAFE_STORAGE = /safeStorage|secure storage|persist credentials/i

const ATTACHMENT_ERRORS: Readonly<Record<string, readonly [ErrorCode, string]>> = {
  ATTACHMENT_TOO_LARGE: ['INVALID_ARGUMENT', '单个附件不能超过 20 MiB。'],
  ATTACHMENT_TOTAL_TOO_LARGE: ['INVALID_ARGUMENT', '附件最多 10 个，总大小不能超过 100 MiB。'],
  ATTACHMENT_EMPTY: ['INVALID_ARGUMENT', '附件为空，请重新选择文件。'],
  ATTACHMENT_NOT_REGULAR_FILE: ['INVALID_ARGUMENT', '请选择本地普通文件，目录和链接不能作为附件。'],
  ATTACHMENT_IMAGE_SIGNATURE_INVALID: ['INVALID_ARGUMENT', '图片内容无效，请重新保存图片后添加。'],
  ATTACHMENT_MEDIA_TYPE_MISMATCH: ['INVALID_ARGUMENT', '图片格式与内容不符，请重新选择。'],
  ATTACHMENT_SESSION_EXPIRED: ['INVALID_STATE', '附件导入会话已过期，请重新添加附件。'],
  ATTACHMENT_SESSION_NOT_FOUND: ['NOT_FOUND', '附件导入会话不可用，请重新添加附件。'],
  ATTACHMENT_NOT_FOUND: ['NOT_FOUND', '附件已移除，请重新添加。'],
  ATTACHMENT_REVISION_CONFLICT: ['CONFLICT', '附件列表已更新，请刷新后重试。'],
  ATTACHMENT_REFERENCE_INVALID: ['INVALID_STATE', '附件引用已失效，请重新添加并绑定附件。'],
  ATTACHMENT_TARGET_MISMATCH: ['INVALID_STATE', '附件属于其他输入，请在当前输入中重新添加。'],
  ATTACHMENT_INTEGRITY_MISMATCH: ['INVALID_STATE', '附件快照已损坏，请重新添加附件。'],
  ATTACHMENT_TASK_SNAPSHOT_CONFLICT: ['CONFLICT', '本轮附件已确认，请重新提交当前输入。'],
}

function envelope(code: ErrorCode, message?: string): IpcErrorEnvelope {
  const spec = ERROR_CODES[code]
  return {
    code,
    message: message ?? spec.message,
    statusCode: spec.status,
    ...(spec.retryable ? { retryable: true } : {}),
  }
}

function mapAuthApiError(error: AuthApiError): IpcErrorEnvelope {
  if (error.isNetworkError && error.statusCode === 0) return envelope('NETWORK_ERROR')
  // 技能缺失要与"员工不存在"区分开：前者管理员发布一下就能好，后者不能。
  if (error.statusCode === 401) return envelope('INVALID_CREDENTIALS')
  if (error.statusCode === 403) return envelope('ACCOUNT_DISABLED')
  if (error.statusCode === 404) return envelope('NOT_FOUND')
  if (error.statusCode === 429) return { ...envelope('RATE_LIMITED'), ...(error.error.retryAfterMs ? { retryAfterMs: error.error.retryAfterMs } : {}) }
  if (error.statusCode >= 500) return envelope('SERVICE_UNAVAILABLE')
  return envelope('INTERNAL_ERROR')
}

/**
 * 唯一映射点。任何 handler 的 catch 都只调它，不再手写 `{ success: false, error: {...} }`。
 *
 * `authenticated` 区分同一个 401 的两种含义：登录接口需要按明确响应识别验证失败，
 * 已登录之后是"会话过期，请重新登录"。原来 authError / taskError 各自处理，
 * 结果是同一个错误在两条路径上给出不同的码。
 */
export function toEnvelope(error: unknown, context: { authenticated?: boolean; feedbackOperation?: FeedbackOperation } = {}): IpcErrorEnvelope {
  const result = mapEnvelope(error, context)
  return context.feedbackOperation ? { ...result, ...operationFeedback(error, context.feedbackOperation, result) } : result
}

function mapEnvelope(error: unknown, context: { authenticated?: boolean }): IpcErrorEnvelope {
  if (error instanceof LoginFeedbackError) return { ...LOGIN_FEEDBACK[error.reason], reason: error.reason }
  if (error instanceof KnowledgeApiError) {
    const status = error.statusCode
    const code: ErrorCode = status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'PERMISSION_DENIED'
      : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : status === 0 || status === 408 ? 'NETWORK_ERROR'
      : status >= 500 ? 'SERVICE_UNAVAILABLE' : status === 400 || status === 413 || status === 415 ? 'INVALID_ARGUMENT' : 'INVALID_STATE'
    return { ...envelope(code, error.message), statusCode: status, platformCode: error.platformCode, requestId: error.requestId, retryAfterMs: error.retryAfterMs }
  }
  if (error instanceof AppError) return envelope(error.code, error.userMessage)
  if (error instanceof AuthenticationRequiredError) return envelope('AUTH_REQUIRED')
  if (error instanceof AuthApiError) {
    if (error.resource === 'skills' && error.statusCode === 403 && /^Missing Origin or Referer header\.?$/i.test(error.message.trim())) {
      return envelope('INTERNAL_ERROR')
    }
    // 已登录之后收到 401/403，含义是"会话/授权失效，请重新登录"，
    // 登录接口则按响应内容识别验证失败。原来 authError 与 taskError 各自处理，
    // 同一个错误在两条路径上给出的码不一样。
    if (context.authenticated && (error.statusCode === 401 || error.statusCode === 403)) {
      return envelope('AUTH_REQUIRED')
    }
    if (error.resource === 'login') {
      const reason: LoginFeedbackReason = error.statusCode === 401
        ? error.message === '邮箱或密码错误' ? 'credentials' : 'verification'
        : error.statusCode === 403 ? 'forbidden'
        : error.statusCode === 429 ? 'rate_limited'
        : error.statusCode === 0 ? 'network'
        : error.statusCode === 408 ? 'timeout'
        : error.statusCode >= 500 ? 'service' : 'request_rejected'
      return { ...LOGIN_FEEDBACK[reason], statusCode: error.statusCode, reason }
    }
    return mapAuthApiError(error)
  }
  if (error instanceof ConversationRecoveryError) {
    return isErrorCode(error.code) ? envelope(error.code) : envelope('INVALID_STATE')
  }
  if (error instanceof TaskAdmissionError) return envelope('INVALID_STATE')
  if (error instanceof InvalidTaskTransitionError) return envelope('INVALID_STATE')
  if (error instanceof TaskScopeError) return envelope('AUTH_REQUIRED')
  if (error instanceof TaskPersistenceError) return envelope('PERSISTENCE_ERROR')
  if (error instanceof Error && Object.hasOwn(ATTACHMENT_ERRORS, error.message)) {
    const [code, message] = ATTACHMENT_ERRORS[error.message]
    return envelope(code, message)
  }
  if (error instanceof Error && SAFE_STORAGE.test(error.message)) return envelope('STORAGE_UNAVAILABLE')
  return envelope('INTERNAL_ERROR')
}

/** 技术细节，只给日志。调用方不得把它塞进 IPC 载荷。 */
export function errorDetails(error: unknown): string {
  return describeError(error)
}

/**
 * 构造失败信封。文案默认取错误码表，只有需要指出具体是哪个参数时才覆写。
 * 业务代码里不该再出现手写的 `{ success: false, error: {...} }`。
 */
export function failure(code: ErrorCode, message?: string): IpcFailure {
  return { success: false, error: envelope(code, message) }
}

/** 由 unknown 错误构造失败信封。handler 的 catch 用它。 */
export function failureFrom(error: unknown, context?: { authenticated?: boolean }): IpcFailure {
  return { success: false, error: toEnvelope(error, context) }
}

/**
 * auth 通道专用的窄化投影。
 *
 * 渲染进程的 `AuthErrorCode` 只声明了 9 个码，而错误码表有 17 个——多出来的
 * EMPLOYEE_* / SESSION_* 只会从任务路径产生，不会出现在 auth 通道上。这里不是第二个
 * 映射点：仍然先走 toEnvelope，只是把结果投影回契约允许的集合，越界的收敛为
 * INTERNAL_ERROR，免得给渲染进程一个它 switch 不到的码。
 *
 * `src/shared/types.ts` 属渲染进程契约，本轮不改；若将来把两个 union 并成
 * ErrorCode，这个函数就该删掉。
 */
const AUTH_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'AUTH_REQUIRED', 'INVALID_ARGUMENT', 'INVALID_CREDENTIALS', 'ACCOUNT_DISABLED',
  'STORAGE_UNAVAILABLE', 'NETWORK_ERROR', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
])

export function toAuthEnvelope(error: unknown): AuthError {
  const result = toEnvelope(error)
  const code = AUTH_CODES.has(result.code) ? result.code : 'INTERNAL_ERROR'
  const spec = ERROR_CODES[code]
  return {
    code: code as AuthError['code'],
    message: code === result.code ? result.message : spec.message,
    statusCode: code === result.code ? result.statusCode : spec.status,
    ...(spec.retryable ? { retryable: true } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  }
}

export function authFailureFrom(error: unknown): { success: false; error: AuthError } {
  return { success: false, error: toAuthEnvelope(error) }
}

export function authFailure(code: AuthError['code'], message?: string): { success: false; error: AuthError } {
  const spec = ERROR_CODES[code]
  return {
    success: false,
    error: {
      code,
      message: message ?? spec.message,
      statusCode: spec.status,
      ...(spec.retryable ? { retryable: true } : {}),
    },
  }
}


