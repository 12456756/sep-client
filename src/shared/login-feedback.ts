import type { AuthErrorCode } from './types'

interface LoginFeedbackSpec {
  code: AuthErrorCode
  message: string
  statusCode: number
}

export const LOGIN_FEEDBACK = {
  email_required: { code: 'INVALID_ARGUMENT', message: '请输入邮箱', statusCode: 400 },
  email_invalid: { code: 'INVALID_ARGUMENT', message: '请输入有效的邮箱地址', statusCode: 400 },
  password_required: { code: 'INVALID_ARGUMENT', message: '请输入密码', statusCode: 400 },
  saved_password_missing: { code: 'INVALID_ARGUMENT', message: '保存的密码已不可用，请重新输入', statusCode: 400 },
  credentials: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误', statusCode: 401 },
  verification: { code: 'INVALID_CREDENTIALS', message: '登录验证未通过', statusCode: 401 },
  forbidden: { code: 'SERVICE_UNAVAILABLE', message: '登录请求被拒绝，请联系平台管理员', statusCode: 403 },
  rate_limited: { code: 'RATE_LIMITED', message: '登录操作过于频繁，请稍后再试', statusCode: 429 },
  network: { code: 'NETWORK_ERROR', message: '网络连接失败，请检查网络', statusCode: 0 },
  timeout: { code: 'NETWORK_ERROR', message: '网络连接超时，请稍后再试', statusCode: 408 },
  service: { code: 'SERVICE_UNAVAILABLE', message: '登录服务异常，请联系平台管理员', statusCode: 503 },
  request_rejected: { code: 'SERVICE_UNAVAILABLE', message: '登录请求未被接受，请联系平台管理员', statusCode: 400 },
  response_invalid: { code: 'SERVICE_UNAVAILABLE', message: '登录响应异常，请联系平台管理员', statusCode: 502 },
  enterprise_missing: { code: 'SERVICE_UNAVAILABLE', message: '账号未关联企业，请联系平台管理员', statusCode: 403 },
  device: { code: 'INTERNAL_ERROR', message: '设备信息初始化失败，请联系平台管理员', statusCode: 500 },
  storage_unavailable: { code: 'STORAGE_UNAVAILABLE', message: '系统安全存储不可用，请联系平台管理员', statusCode: 500 },
  credential_save: { code: 'STORAGE_UNAVAILABLE', message: '登录凭据保存失败，请联系平台管理员', statusCode: 500 },
  workspace: { code: 'INTERNAL_ERROR', message: '工作台初始化失败，请联系平台管理员', statusCode: 500 },
  accounts_read: { code: 'STORAGE_UNAVAILABLE', message: '历史账号读取失败，请联系平台管理员', statusCode: 500 },
  password_read: { code: 'STORAGE_UNAVAILABLE', message: '保存的密码读取失败，请联系平台管理员', statusCode: 500 },
  account_remove: { code: 'STORAGE_UNAVAILABLE', message: '历史账号移除失败，请联系平台管理员', statusCode: 500 },
  session_expired: { code: 'AUTH_REQUIRED', message: '登录已失效，请重新登录', statusCode: 401 },
  logout: { code: 'INTERNAL_ERROR', message: '退出登录失败，请联系平台管理员', statusCode: 500 },
  unknown: { code: 'INTERNAL_ERROR', message: '登录失败，请联系平台管理员', statusCode: 500 },
} as const satisfies Record<string, LoginFeedbackSpec>

export type LoginFeedbackReason = keyof typeof LOGIN_FEEDBACK
