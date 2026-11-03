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
  forbidden: { code: 'SERVICE_UNAVAILABLE', message: '平台拒绝了登录请求，请联系平台管理员检查账号权限或访问限制。', statusCode: 403 },
  rate_limited: { code: 'RATE_LIMITED', message: '登录操作过于频繁，请稍后再试', statusCode: 429 },
  network: { code: 'NETWORK_ERROR', message: '网络连接失败，请检查网络', statusCode: 0 },
  timeout: { code: 'NETWORK_ERROR', message: '网络连接超时，请稍后再试', statusCode: 408 },
  service: { code: 'SERVICE_UNAVAILABLE', message: '登录服务暂时不可用，请稍后重试；持续失败请联系平台管理员。', statusCode: 503 },
  request_rejected: { code: 'SERVICE_UNAVAILABLE', message: '平台未接受本次登录请求，请重新输入账号密码后重试；持续失败请联系平台管理员。', statusCode: 400 },
  response_invalid: { code: 'SERVICE_UNAVAILABLE', message: '登录服务返回的数据不完整，请稍后重试；持续失败请联系平台管理员。', statusCode: 502 },
  enterprise_missing: { code: 'SERVICE_UNAVAILABLE', message: '当前账号未关联企业，请联系企业管理员处理账号归属。', statusCode: 403 },
  device: { code: 'INTERNAL_ERROR', message: '无法取得本机设备标识，登录尚未完成，请重启客户端后重试。', statusCode: 500 },
  storage_unavailable: { code: 'STORAGE_UNAVAILABLE', message: '系统安全存储不可用，无法安全保存登录凭据，请检查系统安全设置后重试。', statusCode: 500 },
  credential_save: { code: 'STORAGE_UNAVAILABLE', message: '登录凭据保存失败，请检查本机存储空间和应用数据目录权限后重新登录。', statusCode: 500 },
  workspace: { code: 'INTERNAL_ERROR', message: '切换账号或加载本地工作记录时发生异常，登录尚未完成，请重启客户端后重新登录。', statusCode: 500 },
  accounts_read: { code: 'STORAGE_UNAVAILABLE', message: '历史账号信息无法读取，请手动输入账号登录。', statusCode: 500 },
  password_read: { code: 'STORAGE_UNAVAILABLE', message: '保存的密码无法读取，请重新输入密码登录。', statusCode: 500 },
  account_remove: { code: 'STORAGE_UNAVAILABLE', message: '历史账号信息无法从本机移除，请检查应用数据目录的写入权限后重试。', statusCode: 500 },
  session_expired: { code: 'AUTH_REQUIRED', message: '登录已失效，请重新登录', statusCode: 401 },
  logout: { code: 'INTERNAL_ERROR', message: '退出登录未能完成，请重试；仍失败请重启客户端。', statusCode: 500 },
  unknown: { code: 'INTERNAL_ERROR', message: '登录失败，客户端没有取得具体原因，请重试；持续失败请联系平台管理员。', statusCode: 500 },
} as const satisfies Record<string, LoginFeedbackSpec>

export type LoginFeedbackReason = keyof typeof LOGIN_FEEDBACK
