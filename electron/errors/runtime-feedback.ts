import { RUNTIME_FAILURE_EVENT, RUNTIME_FAILURE_MESSAGES, type RuntimeFailure, type RuntimeFailureCode } from '../../src/shared/runtime-feedback'
import type { TaskExecutionEvent } from '../../src/shared/types'
import type { TaskOwnerScope } from '../data/scope-path'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { AuthApiError } from '../common/platform/platform-api'
import { AppError } from './app-error'
import { transportKind } from './operation-feedback'

function failure(code: RuntimeFailureCode): RuntimeFailure { return { code, message: RUNTIME_FAILURE_MESSAGES[code] } }

const unrecoverableSessionMessages = new Set([
  '失败节点的历史会话记录丢失，无法继续已有上下文。',
  '失败节点的历史运行记录丢失，无法定位已有会话。',
  '失败节点的历史会话记录不完整，无法继续已有上下文。',
  '失败节点的历史会话与当前节点或工作目录不一致，无法恢复。',
  '失败节点的历史会话文件丢失、损坏或不属于当前任务，无法继续已有上下文。',
])

export function runtimeFeedback(error: unknown): RuntimeFailure {
  if (error instanceof Error) {
    const known = (Object.keys(RUNTIME_FAILURE_MESSAGES) as RuntimeFailureCode[]).find(code => RUNTIME_FAILURE_MESSAGES[code] === error.message)
    if (known) return failure(known)
    const transport = transportKind(error)
    if (transport === 'timeout') return failure('MODEL_TIMEOUT')
    if (transport === 'network' || error.name === 'APIConnectionError' || error.message === 'Connection error.') return failure('NETWORK_ERROR')
    if (error instanceof AuthenticationRequiredError || error instanceof AppError && error.code === 'AUTH_REQUIRED') return failure('AUTH_REQUIRED')
    // Pi keeps the OpenAI APIError status prefix when flattening an error to text.
    const status = error instanceof AuthApiError ? error.statusCode : 'status' in error ? error.status
      : Number(/^(?:HTTP\s+)?([45]\d{2})(?:\s|:|$)/i.exec(error.message)?.[1]) || undefined
    if (status === 408 || status === 504) return failure('MODEL_TIMEOUT')
    if (status === 401) return failure('AUTH_REQUIRED')
    if (status === 403) return failure('REQUEST_DENIED')
    if (status === 429) return failure('RATE_LIMITED')
    if (typeof status === 'number' && status >= 500 && status <= 599) return failure('SERVICE_UNAVAILABLE')
    if (error instanceof AuthApiError && status === 0) return failure('NETWORK_ERROR')
    if (error instanceof AppError) {
      if (error.code === 'NETWORK_ERROR') return failure('NETWORK_ERROR')
      if (error.code === 'RATE_LIMITED') return failure('RATE_LIMITED')
      if (error.code === 'SERVICE_UNAVAILABLE') return failure('SERVICE_UNAVAILABLE')
      if (error.code === 'PERMISSION_DENIED') return failure('REQUEST_DENIED')
    }
    if ((error instanceof AppError && error.code === 'EMPLOYEE_UNAVAILABLE') ||
      ['The selected employee is no longer available.', 'Selected employee is unavailable.'].includes(error.message)) return failure('EMPLOYEE_UNAVAILABLE')
    if (error instanceof AppError && error.code === 'MODEL_NOT_ALLOWED') return failure('MODEL_NOT_ALLOWED')
    if (unrecoverableSessionMessages.has(error.message)) return failure('SESSION_UNRECOVERABLE')
    if (error.message === '中断时有工具操作未保存执行结果，请先核实该操作，避免重试时重复写入或提交。') return failure('SIDE_EFFECT_UNCONFIRMED')
    if (error.message === '编排媒体资产流转和最终交付尚未接通，当前节点暂不可执行。请保留已保存的媒体资产，待接入后继续，不要重新提交生成请求。') return failure('MEDIA_UNAVAILABLE')
  }
  return failure('INTERNAL_ERROR')
}

export function runtimeFailureEvent(input: { taskId: string; runId: string; subscriptionId: string; owner: TaskOwnerScope }, error: unknown): TaskExecutionEvent {
  const { owner, ...identity } = input
  return { ...identity, sequence: 0, type: RUNTIME_FAILURE_EVENT, occurredAt: Date.now(), data: { owner: { ...owner }, code: runtimeFeedback(error).code } }
}

/** Model diagnostics stay in the main-process log, including while Pi retries. */
export function sanitizeRuntimeErrorEvent(event: TaskExecutionEvent): TaskExecutionEvent {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return event
  const data = event.data as Record<string, unknown>
  if (['session_error', 'auto_retry_start', 'auto_retry_end', 'retry_budget_exhausted'].includes(event.type)) {
    const message = runtimeFeedback(new Error(typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : '')).message
    return { ...event, data: {
      ...(typeof data.attempt === 'number' ? { attempt: data.attempt } : {}),
      ...(typeof data.maxAttempts === 'number' ? { maxAttempts: data.maxAttempts } : {}),
      ...(typeof data.delayMs === 'number' ? { delayMs: data.delayMs } : {}),
      ...(typeof data.success === 'boolean' ? { success: data.success } : {}),
      ...(event.type === 'session_error' ? { message } : { error: message }),
    } }
  }
  if (['turn_end', 'message_end'].includes(event.type) && data.message && typeof data.message === 'object') {
    const message = data.message as Record<string, unknown>
    if (typeof message.errorMessage === 'string') return { ...event, data: { ...data,
      message: { ...message, errorMessage: runtimeFeedback(new Error(message.errorMessage)).message } } }
  }
  return event
}
