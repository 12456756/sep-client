import { FEEDBACK_OPERATIONS, operationFailure, type FeedbackOperation } from '../../src/shared/arrangement-feedback'
import { AuthApiError } from '../common/platform/platform-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { AppError } from './app-error'
import type { ErrorCode } from './error-codes'

interface PublicError { code: ErrorCode; message: string; statusCode: number }

const planningMessages: Readonly<Record<string, string>> = {
  '自动编排模型返回了异常工具调用，已停止规划，请重试。': '自动编排模型响应异常，请联系平台管理员',
  '当前选择的模型未配置在服务端账号组中。请管理员同步可用模型，或选择其他模型后重试。': '所选模型配置不可用，请联系平台管理员',
  '规划模型输出达到上限，回复未完整生成。': '编排内容超过模型输出上限，请联系平台管理员',
  '规划模型未正常结束，未生成可用的规划结果。': '自动编排模型响应中断，请联系平台管理员',
  '规划模型没有返回正文，无法生成规划。': '自动编排模型返回内容为空，请联系平台管理员',
}

const planningReasons: Readonly<Record<string, string>> = {
  'invalid-json': '自动编排返回内容格式异常', 'json-not-found': '自动编排返回内容格式异常',
  'invalid-output-shape': '自动编排返回内容格式异常', 'empty-plan': '自动编排未生成工作步骤',
  'invalid-node': '自动编排的工作步骤不完整', 'missing-node-fields': '自动编排的工作步骤不完整',
  'invalid-node-work-contract': '自动编排的媒体或交付安排不完整',
  'invalid-planner-input-reference': '自动编排的输入引用无效', 'invalid-attachment-reference': '自动编排的附件引用无效',
  'required-attachment-unassigned': '自动编排未分配必需附件',
  'employee-unavailable': '自动编排选择了不可用的员工', 'model-not-allowed': '自动编排选择了不可用的模型',
  'invalid-draft': '自动编排的工作安排校验未通过',
  'invalid-intent-analysis': '自动编排的工作目标分析异常', 'invalid-intent-step': '自动编排的工作目标分析异常',
  'duplicate-intent-step': '自动编排的工作步骤重复',
  'invalid-unresolved-steps': '自动编排的员工匹配结果异常', 'invalid-unresolved-step': '自动编排的员工匹配结果异常',
}

const actionableMessages = new Set([
  '当前模型没有可用的员工授权，请联系平台管理员', '所选员工当前不可用，请重新选择员工',
  '自动编排选择了不可用的模型，请联系平台管理员', '所选员工不支持当前模型，请重新选择',
  '还有工作步骤缺少员工，请先完成员工匹配', '自动编排的交付文件冲突，请联系平台管理员',
  '自动编排的交付安排不完整，请联系平台管理员',
  '当前图片交付仅支持 PNG 格式，请调整要求后重新编排', '当前编排不支持所选图片或视频交付方式，请调整要求后重新编排',
  '附件需要有效的导入会话。', '自动编排无法读取已要求使用的附件。',
  '请先完成麦克风授权。', '已有语音输入正在进行。', '语音输入已关闭，请在设置中开启。',
  '本次录音已取消，请重新录音。', '本次录音已取消。', '已有语音输入正在识别。', '本次语音输入已取消。',
  '系统麦克风授权超时，请完成授权后重新尝试。',
  '无法请求 macOS 麦克风权限，请检查系统设置后重试。',
  '当前平台不支持直接打开系统麦克风设置。', '无法打开系统麦克风设置，请手动打开系统隐私设置。',
  ...['Windows', 'macOS'].flatMap(platform => [
    `${platform} 未允许访问麦克风，请在个人设置中打开系统麦克风设置。`,
    `无法确认 ${platform} 麦克风权限，请检查系统设置后重试。`,
  ]),
])

export function transportKind(error: unknown, depth = 0): 'network' | 'timeout' | null {
  if (!(error instanceof Error) || depth > 3) return null
  const code = 'code' in error ? String(error.code) : ''
  if (error.name === 'TimeoutError' || error.name === 'APIConnectionTimeoutError' || error.message === 'Request timed out.' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout'
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) return 'network'
  return transportKind(error.cause, depth + 1)
    ?? (error instanceof TypeError && error.message === 'fetch failed' ? 'network' : null)
}

/** Raw platform messages are deliberately never copied into the public result. */
export function operationFeedback(error: unknown, operation: FeedbackOperation, mapped?: PublicError): PublicError {
  const fallback: PublicError = { code: 'INTERNAL_ERROR', statusCode: 500, message: operationFailure(operation) }
  const transport = transportKind(error)
  if (transport) return { code: 'NETWORK_ERROR', statusCode: 0, message: transport === 'timeout' ? '网络连接超时，请稍后重试' : '网络连接失败，请检查网络' }
  if (error instanceof AuthenticationRequiredError) return { code: 'AUTH_REQUIRED', statusCode: 401, message: '登录状态已失效，请重新登录' }
  if (error instanceof AuthApiError) {
    const statusCode = error.statusCode
    if (statusCode === 401) return { code: 'AUTH_REQUIRED', statusCode, message: '登录验证未通过，请重新登录' }
    if (statusCode === 403) return { code: 'PERMISSION_DENIED', statusCode, message: `${FEEDBACK_OPERATIONS[operation]}请求被拒绝，请联系平台管理员` }
    if (statusCode === 429) return { code: 'RATE_LIMITED', statusCode, message: '请求过于频繁，请稍后重试' }
    if (statusCode === 0 || statusCode === 408) return { code: 'NETWORK_ERROR', statusCode, message: statusCode === 408 ? '网络连接超时，请稍后重试' : '网络连接失败，请检查网络' }
    return { ...fallback, statusCode, code: statusCode >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR' }
  }
  if (error instanceof Error && error.message === 'ATTACHMENT_INTEGRITY_MISMATCH' && mapped) return { ...mapped, message: '附件数据损坏，请联系平台管理员' }
  if (error instanceof Error && error.message.startsWith('ATTACHMENT_') && mapped && mapped.message !== '操作未能完成。') return mapped
  if (error instanceof AppError) {
    const base = { code: error.code, statusCode: mapped?.statusCode ?? 500 }
    if (error.userMessage === '自动编排无法读取已要求使用的附件。') return { ...base, message: '自动编排无法读取所需附件，请联系平台管理员' }
    if (error.code === 'PLANNING_FAILED' && planningMessages[error.userMessage]) return { ...base, message: planningMessages[error.userMessage] }
    const reason = error.details?.reason
    if (error.code === 'PLANNING_FAILED' && typeof reason === 'string' && planningReasons[reason]) return { ...base, message: `${planningReasons[reason]}，请联系平台管理员` }
    if (actionableMessages.has(error.userMessage)) return { ...base, message: error.userMessage }
    const messages: Partial<Record<ErrorCode, string>> = {
      AUTH_REQUIRED: '登录状态已失效，请重新登录',
      DRAFT_REVISION_CONFLICT: '工作安排已更新，请重新加载后再操作',
      MODEL_NOT_ALLOWED: operation === 'planning' ? '自动编排选择了不可用的模型，请联系平台管理员' : '所选员工不支持当前模型，请重新选择',
      EMPLOYEE_UNAVAILABLE: '所选员工当前不可用，请重新选择员工',
      SUBSCRIPTION_EXPIRING: '员工授权剩余时间不足，无法开始工作',
      WORKSPACE_INVALID: '工作目录不可用，请重新选择目录',
      PERMISSION_DENIED: '当前工作所需权限不可用，请联系平台管理员',
      CONFLICT: '工作目录被其他任务占用，请稍后重试',
      NETWORK_ERROR: '网络连接失败，请检查网络', RATE_LIMITED: '请求过于频繁，请稍后重试',
    }
    if (messages[error.code]) return { ...base, message: messages[error.code]! }
    if (error.userMessage === '本地语音模型缺失或损坏，请检查安装资源。') return { ...base, message: '语音识别资源异常，请联系平台管理员' }
    return { ...base, message: fallback.message }
  }
  if (mapped?.code === 'AUTH_REQUIRED') return { ...mapped, message: '登录状态已失效，请重新登录' }
  return { ...(mapped ?? fallback), message: fallback.message }
}
