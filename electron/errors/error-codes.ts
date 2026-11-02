/**
 * electron/errors/error-codes.ts — 唯一错误码表（方案第 4.1 节）
 *
 * 一张表决定四件事：用户可见的中文文案、HTTP 语义状态码、是否可重试、日志级别。
 * 新增一种失败情形 = 这里加一行，四件事同时确定，不需要改别处。
 *
 * 两种文案严格分开：
 *   - message（中文）进 IPC，用户可见；
 *   - cause / details（英文技术信息）只进日志，绝不进 IPC 载荷。
 *     这是"token 值不得出现在日志、控制台或 IPC 事件载荷"的落点。
 */

export const ERROR_CODES = {
  AUTH_REQUIRED: { status: 401, retryable: false, level: 'warn', message: '请重新登录。' },
  INVALID_ARGUMENT: { status: 400, retryable: false, level: 'warn', message: '请求参数不合法。' },
  MISSING_SPEC: { status: 422, retryable: false, level: 'warn', message: '生成规格尚未确定，请根据用途补充方案或向用户确认。' },
  SPEC_CONFLICT: { status: 422, retryable: false, level: 'warn', message: '生成规格相互矛盾，请核对尺寸、比例和明确要求。' },
  UPGRADE_REQUIRED: { status: 409, retryable: false, level: 'warn', message: '当前媒体协议无法表达这套规格，需要升级平台或客户端。' },
  ADAPTER_UNAVAILABLE: { status: 503, retryable: false, level: 'warn', message: '当前媒体通道尚未完成适配，未提交生成。' },
  ADAPTER_FIELD_UNMAPPED: { status: 422, retryable: false, level: 'warn', message: '当前媒体适配器无法传递指定字段，未提交生成。' },
  PRICE_UNAVAILABLE: { status: 503, retryable: false, level: 'warn', message: '无法取得这套规格的可靠报价，未提交生成。' },
  UPSTREAM_SPEC_UNSUPPORTED: { status: 422, retryable: false, level: 'warn', message: '上游明确不支持这套规格，请核对原因后重新选择方案。' },
  OUTPUT_SPEC_MISMATCH: { status: 422, retryable: false, level: 'warn', message: '实际产物与约定规格不一致，请查看实际结果和费用状态。' },
  INVALID_CREDENTIALS: { status: 401, retryable: false, level: 'warn', message: '邮箱或密码不正确。' },
  ACCOUNT_DISABLED: { status: 403, retryable: false, level: 'warn', message: '该账号不允许登录。' },
  STORAGE_UNAVAILABLE: { status: 422, retryable: false, level: 'error', message: '系统安全存储不可用。' },
  NOT_FOUND: { status: 404, retryable: false, level: 'warn', message: '未找到对应资源。' },
  INVALID_STATE: { status: 409, retryable: false, level: 'warn', message: '当前状态下无法执行该操作。' },
  DRAFT_REVISION_CONFLICT: { status: 409, retryable: true, level: 'warn', message: '安排草稿已被更新，请重新加载后再保存。' },
  PLANNING_FAILED: { status: 503, retryable: true, level: 'warn', message: '自动编排暂时未能完成，请稍后重试。' },
  MODEL_NOT_ALLOWED: { status: 403, retryable: false, level: 'warn', message: '所选模型不在该硅基员工的可用范围内。' },
  SUBSCRIPTION_EXPIRING: { status: 409, retryable: false, level: 'warn', message: '硅基员工订阅剩余时间不足，无法开始这项工作。' },
  WORKSPACE_INVALID: { status: 400, retryable: false, level: 'warn', message: '工作目录不可用或不符合安全策略。' },
  PERMISSION_DENIED: { status: 403, retryable: false, level: 'warn', message: '当前工作所需权限超过了可用权限范围。' },
  CONFLICT: { status: 409, retryable: true, level: 'warn', message: '工作目录被其他任务占用，请稍后重试。' },
  PERSISTENCE_ERROR: { status: 500, retryable: true, level: 'error', message: '数据保存失败。' },
  EMPLOYEE_UNAVAILABLE: { status: 404, retryable: false, level: 'warn', message: '所选硅基员工已不可用。' },
  SKILL_CONTENT_MISMATCH: { status: 409, retryable: false, level: 'error', message: '技能加载失败：技能包内容与批准版本不一致，请联系管理员。' },
  SESSION_UNRECOVERABLE: { status: 409, retryable: false, level: 'warn', message: '会话文件已损坏且无法恢复。' },
  RECOVERY_CONFIRMATION_REQUIRED: { status: 409, retryable: false, level: 'warn', message: '会话文件已损坏，确认后将依据任务历史重建对话。' },
  NETWORK_ERROR: { status: 0, retryable: true, level: 'warn', message: '网络连接失败，请检查网络后重试。' },
  RATE_LIMITED: { status: 429, retryable: true, level: 'warn', message: '操作过于频繁，请稍后重试。' },
  SERVICE_UNAVAILABLE: { status: 503, retryable: true, level: 'error', message: '服务暂时不可用，请稍后重试。' },
  INSUFFICIENT_FUNDS: { status: 402, retryable: false, level: 'warn', message: '可用资金不足。' },
  VIDEO_BUDGET_EXCEEDED: { status: 402, retryable: false, level: 'warn', message: '已超过企业视频预算。' },
  MEDIA_FORBIDDEN: { status: 403, retryable: false, level: 'warn', message: '当前账号没有视频生成权限。' },
  QUOTE_EXPIRED: { status: 409, retryable: false, level: 'warn', message: '本次视频报价已过期。' },
  VIDEO_CONCURRENCY_LIMIT: { status: 409, retryable: false, level: 'warn', message: '视频任务数已达到并发上限，请稍后重试。' },
  INTERNAL_ERROR: { status: 500, retryable: false, level: 'error', message: '操作未能完成。' },
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export interface ErrorCodeSpec {
  status: number
  retryable: boolean
  level: 'warn' | 'error'
  message: string
}

export function errorCodeSpec(code: ErrorCode): ErrorCodeSpec {
  return ERROR_CODES[code]
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_CODES
}


