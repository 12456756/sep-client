import { mediaUpstreamMessages } from './media-upstream-error'

/** Reasons contain no retry or billing claims; recovery depends on the original job state. */
const REASONS: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: '访问授权失效', PERMISSION_DENIED: '当前操作权限不足或未获批准', MEDIA_FORBIDDEN: '没有生成权限',
  INSUFFICIENT_FUNDS: '当前账号可用资金不足', VIDEO_BUDGET_EXCEEDED: '企业视频预算已达上限',
  QUOTE_EXPIRED: '本次报价已过期', VIDEO_CONCURRENCY_LIMIT: '同时进行的视频任务已达上限', RATE_LIMITED: '请求过于频繁',
  INVALID_ARGUMENT: '输入参数或生成规格无效', NOT_FOUND: '任务或所需资源未找到',
  CONFLICT: '已有操作正在处理或任务状态发生冲突', INVALID_STATE: '当前任务状态不允许执行此操作',
  NETWORK_ERROR: '网络连接失败', NETWORK_TIMEOUT: '请求超时', SERVICE_UNAVAILABLE: '生成服务暂时不可用或返回了异常数据',
  INTERNAL_ERROR: '客户端处理发生异常，尚未取得具体原因', MEDIA_FAILED: '媒体处理失败，尚未取得具体原因',
  MISSING_SPEC: '生成规格尚未确定', SPEC_CONFLICT: '生成规格相互矛盾', UPGRADE_REQUIRED: '当前平台或客户端不支持本次媒体协议',
  ADAPTER_UNAVAILABLE: '当前生成通道尚未完成适配', ADAPTER_FIELD_UNMAPPED: '当前生成通道无法传递指定规格字段',
  PRICE_UNAVAILABLE: '无法取得这套规格的可靠报价', UPSTREAM_SPEC_UNSUPPORTED: '生成服务不支持本次请求规格',
  OUTPUT_SPEC_MISMATCH: '实际产物与约定规格不一致', CONFIG_CHANGED: '生成模型配置已变更',
  EMPLOYEE_UNAVAILABLE: '所选员工当前不可用', MODEL_NOT_ALLOWED: '所选员工没有当前模型的使用权限',
  SUBMISSION_UNKNOWN: '提交结果尚未确认', NOT_SUBMITTED: '任务尚未提交', TRACKING_STOPPED: '本地跟踪已停止',
  TRACKING_LIMIT: '本轮任务跟踪已达时长或查询上限', QUERY_UNAVAILABLE: '平台当前无法查询原任务',
  RESULT_EXPIRED: '平台保存的生成结果已过期', DOWNLOAD_UNAVAILABLE: '平台当前不允许下载原结果',
  VIDEO_QUERY_INTERRUPTED: '视频任务查询已中断，尚未取得最新状态',
  VIDEO_SAVE_FAILED: '视频下载、文件校验或本地保存失败',
  VIDEO_LOCAL_OUTPUT_MISSING: '已保存的视频文件缺失', VIDEO_LOCAL_OUTPUT_INVALID: '本地视频文件损坏或与保存记录不一致',
  VIDEO_AUTH_REQUIRED: '视频任务访问授权不可用', VIDEO_AUTH_FAILED: '视频服务授权未通过',
  VIDEO_AUTH_RATE_LIMITED: '获取视频授权的请求过于频繁', VIDEO_AUTH_UNAVAILABLE: '视频授权服务暂时不可用',
  VIDEO_NETWORK_ERROR: '连接视频服务失败', VIDEO_TIMEOUT: '视频服务请求超时',
  VIDEO_INVALID_REQUEST: '视频请求参数、参考图或服务配置无效',
  VIDEO_INVALID_RESPONSE: '视频服务返回的数据不完整或不符合接口约定',
  VIDEO_HTTP_ERROR: '视频服务拒绝了请求，尚未提供可识别的具体原因',
  VIDEO_RECEIPT_MISMATCH: '平台返回的视频任务记录与原请求不一致',
  VIDEO_INTEGRITY_MISMATCH: '视频或参考图的内容与平台记录不一致',
  VIDEO_MODE_MISMATCH: '视频服务返回的运行模式与当前配置不一致',
  VIDEO_RESPONSE_TOO_LARGE: '视频服务返回的数据超过客户端接收上限',
  VIDEO_REDIRECT_BLOCKED: '视频服务要求跳转到其他地址，客户端已阻止该跳转',
  VIDEO_ABORTED: '本次视频请求已中断，平台任务状态仍需查询',
  IMAGE_INVALID_RESPONSE: '图片服务返回的数据不完整或不符合接口约定',
  IMAGE_REDIRECT_BLOCKED: '图片服务要求跳转到其他地址，客户端已阻止该跳转',
  MEDIA_INVALID_BASE_URL: '图片服务地址配置无效', MEDIA_INVALID_REQUEST: '图片请求参数或参考图无效',
  MEDIA_INVALID_RESPONSE: '图片服务返回的数据不完整或不符合接口约定',
  MEDIA_RESPONSE_TOO_LARGE: '图片服务返回的数据超过客户端接收上限',
  MEDIA_REDIRECT_BLOCKED: '图片服务要求跳转到其他地址，客户端已阻止该跳转',
  MEDIA_NETWORK_ERROR: '连接图片服务失败', MEDIA_AUTH_FAILED: '图片服务授权未通过',
  MEDIA_ABORTED: '本次图片请求已中断，平台任务状态仍需查询',
  MEDIA_HTTP_ERROR: '图片服务拒绝了请求，尚未提供可识别的具体原因',
  MEDIA_INTEGRITY_MISMATCH: '图片或参考图的内容与平台记录不一致',
  MEDIA_NOT_FOUND: '图片任务或所需资源未找到', MEDIA_RATE_LIMITED: '图片服务请求过于频繁',
  INVALID_PARAMETER: '生成参数无效', INVALID_REFERENCE: '参考图无效',
  UNSUPPORTED_MEDIA_PARAMETERS: '生成服务不支持本次参数组合', REQUEST_BODY_TOO_LARGE: '提交内容超过服务接收上限',
  REFERENCE_EXPIRED: '已上传的参考图已过期', CANCEL_UNSUPPORTED: '当前生成通道不支持取消任务',
  IDEMPOTENCY_CONFLICT: '同一请求编号对应的生成内容不一致', BUDGET_EXCEEDED: '生成预算已达上限',
  UNAUTHORIZED: '访问授权未通过', FORBIDDEN: '当前操作没有访问权限',
  LOCAL_RESPONSE_SIZE_LIMIT: '请求数量超过客户端任务记录容量限制',
  UPSTREAM_TIMEOUT: '生成供应商响应超时', UPSTREAM_FAILED: '生成供应商处理失败，尚未提供具体原因',
  OUTPUT_FAILED: '该项产物生成失败，尚未提供具体原因',
  CONTENT_REJECTED: '生成内容被审核拒绝', CONTENT_POLICY_VIOLATION: '生成内容未通过安全审核',
  PROVIDER_ACCOUNT_DISABLED: '生成供应商账号已停用', PROVIDER_QUOTA_EXHAUSTED: '生成供应商账号额度已耗尽',
  PROVIDER_BUSY: '生成供应商当前繁忙',
  UNSUPPORTED_DURATION: '生成服务不支持指定时长', UNSUPPORTED_RESOLUTION: '生成服务不支持指定分辨率',
  UNSUPPORTED_SIZE: '生成服务不支持指定尺寸', MEDIA_SIZE_UNSUPPORTED: '生成服务不支持指定尺寸',
  UNSUPPORTED_ASPECT_RATIO: '生成服务不支持指定比例', UNSUPPORTED_FRAME_RATE: '生成服务不支持指定帧率',
  UNSUPPORTED_AUDIO: '生成服务不支持指定音频设置', UNSUPPORTED_OUTPUT_FORMAT: '生成服务不支持指定输出格式',
  ENOSPC: '磁盘空间不足', EDQUOT: '磁盘配额已用尽', EACCES: '本地文件访问权限不足', EPERM: '文件操作被系统拒绝',
  ENOENT: '本地文件或目录不存在', EIO: '本地磁盘读写失败', EROFS: '目标文件系统只读', EMFILE: '打开的文件数量过多',
  MOCK_VIDEO_FAILED: '模拟视频生成失败', MOCK_PARTIAL_OUTPUT: '模拟任务仅生成了部分产物', MOCK_SUBMISSION_UNKNOWN: '模拟任务提交结果尚未确认',
}

export function mediaErrorReason(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(REASONS, code) ? REASONS[code] : null
}

const UPSTREAM_CODES: Readonly<Record<string, string>> = {
  ACCOUNT_DISABLED: '生成供应商账号已停用', INVALID_API_KEY: '生成供应商的访问凭据无效',
  AUTH_REQUIRED: '生成供应商身份验证失败', UNAUTHORIZED: '生成供应商身份验证失败',
  PERMISSION_DENIED: '生成供应商拒绝了访问授权', FORBIDDEN: '生成供应商拒绝了访问授权',
  INSUFFICIENT_FUNDS: '生成供应商账号资金不足', RATE_LIMITED: '生成供应商请求频率已达上限',
  AUTHENTICATION_ERROR: '生成供应商身份验证失败', INSUFFICIENT_QUOTA: '生成供应商账号额度不足',
  RATE_LIMIT_EXCEEDED: '生成供应商请求频率已达上限', MODEL_NOT_FOUND: '生成供应商找不到所请求的模型',
  CONTENT_REJECTED: REASONS.CONTENT_REJECTED, CONTENT_POLICY_VIOLATION: REASONS.CONTENT_POLICY_VIOLATION,
  PROVIDER_ACCOUNT_DISABLED: REASONS.PROVIDER_ACCOUNT_DISABLED, PROVIDER_QUOTA_EXHAUSTED: REASONS.PROVIDER_QUOTA_EXHAUSTED,
  UPSTREAM_TIMEOUT: REASONS.UPSTREAM_TIMEOUT,
  UPSTREAM_SPEC_UNSUPPORTED: REASONS.UPSTREAM_SPEC_UNSUPPORTED,
  UNSUPPORTED_DURATION: REASONS.UNSUPPORTED_DURATION, UNSUPPORTED_RESOLUTION: REASONS.UNSUPPORTED_RESOLUTION,
  UNSUPPORTED_SIZE: REASONS.UNSUPPORTED_SIZE,
  INVALID_PARAMETER: REASONS.INVALID_PARAMETER, INVALID_REFERENCE: REASONS.INVALID_REFERENCE,
  UNSUPPORTED_MEDIA_PARAMETERS: REASONS.UNSUPPORTED_MEDIA_PARAMETERS,
}

const UPSTREAM_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:supplier|provider) account (?:is |has been )?disabled[.!]?$/i, '生成供应商账号已停用'],
  [/^(?:invalid api key|incorrect api key|authentication failed)[.!]?$/i, '生成供应商的访问凭据无效'],
  [/^(?:insufficient quota|quota exceeded|quota exhausted)[.!]?$/i, '生成供应商账号额度不足'],
  [/^(?:rate limit exceeded|too many requests)[.!]?$/i, '生成供应商请求频率已达上限'],
  [/^(?:(?:upstream|provider|request) (?:timed out|timeout)|gateway timeout)[.!]?$/i, REASONS.UPSTREAM_TIMEOUT],
  [/^(?:(?:upstream|provider|supplier) )?service (?:is )?(?:temporarily )?unavailable[.!]?$/i, '生成供应商服务暂时不可用'],
  [/^(?:server overloaded|provider busy)[.!]?$/i, REASONS.PROVIDER_BUSY],
  [/^(?:content policy violation|content rejected|safety check failed)[.!]?$/i, REASONS.CONTENT_POLICY_VIOLATION],
  [/^reference subject rejected[.!]?$/i, '参考内容被生成服务拒绝'],
  [/^image edit denied[.!]?$/i, '图片编辑请求被生成服务拒绝'],
  [/^unsupported image dimensions[.!]?$/i, REASONS.UNSUPPORTED_SIZE],
  [/^(?:unsupported duration|duration (?:is )?not supported)[.!]?$/i, REASONS.UNSUPPORTED_DURATION],
  [/^(?:unsupported resolution|resolution (?:is )?not supported)[.!]?$/i, REASONS.UNSUPPORTED_RESOLUTION],
  [/^(?:unsupported (?:image )?size|(?:image )?size (?:is )?not supported)[.!]?$/i, REASONS.UNSUPPORTED_SIZE],
  [/^(?:内容审核未通过|内容未通过安全审核|内容被审核拒绝)[。！]?$/, REASONS.CONTENT_POLICY_VIOLATION],
  [/^(?:供应商账号已停用|上游账号已停用)[。！]?$/, REASONS.PROVIDER_ACCOUNT_DISABLED],
  [/^(?:上游额度不足|供应商额度不足)[。！]?$/, '生成供应商账号额度不足'],
]

/** Match explicit supplier codes or whole known messages, never infer a cause from a keyword. */
export function mediaUpstreamReason(value: unknown, depth = 0): string | null {
  if (depth > 6) return null
  if (Array.isArray(value)) {
    return value.slice(0, 16).map(child => mediaUpstreamReason(child, depth + 1)).find(Boolean) ?? null
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>
    const nested = item.error && typeof item.error === 'object' && !Array.isArray(item.error) ? item.error as Record<string, unknown> : item
    const code = typeof nested.code === 'string' ? nested.code.toUpperCase() : typeof item.code === 'string' ? item.code.toUpperCase() : null
    const source = nested.source ?? item.source
    if ((source === 'platform' || source === 'sep') && code) {
      return mediaErrorReason(code)
    }
    if (code && Object.hasOwn(UPSTREAM_CODES, code)) return UPSTREAM_CODES[code]
    for (const child of [item.error, item.body, item.reason, item.detail, item.details, item.errors]) {
      const reason = mediaUpstreamReason(child, depth + 1)
      if (reason) return reason
    }
  }
  for (const message of mediaUpstreamMessages(value)) {
    const reason = UPSTREAM_MESSAGES.find(([pattern]) => pattern.test(message))?.[1]
    if (reason) return reason
  }
  return null
}

export function mediaRecoveryAdvice(code: string | null | undefined): string {
  if (['AUTH_REQUIRED', 'VIDEO_AUTH_REQUIRED', 'VIDEO_AUTH_FAILED', 'MEDIA_AUTH_FAILED', 'UNAUTHORIZED'].includes(code ?? '')) return '请重新登录后查询原任务；仍失败请联系平台管理员'
  if (['NETWORK_ERROR', 'VIDEO_NETWORK_ERROR'].includes(code ?? '')) return '请检查网络后查询原任务'
  if (['NETWORK_TIMEOUT', 'VIDEO_TIMEOUT', 'UPSTREAM_TIMEOUT'].includes(code ?? '')) return '请稍后查询原任务'
  if (['INSUFFICIENT_FUNDS', 'VIDEO_BUDGET_EXCEEDED'].includes(code ?? '')) return '请联系企业管理员检查可用资金或视频预算'
  if (['PERMISSION_DENIED', 'MEDIA_FORBIDDEN'].includes(code ?? '')) return '请检查工作权限和审批结果；如需授权，请联系平台管理员'
  if (['VIDEO_CONCURRENCY_LIMIT', 'RATE_LIMITED', 'VIDEO_AUTH_RATE_LIMITED'].includes(code ?? '')) return '请等待后再查询原任务'
  if (['MISSING_SPEC', 'SPEC_CONFLICT', 'UPSTREAM_SPEC_UNSUPPORTED'].includes(code ?? '')) return '请核对输入和生成规格，并先确认原任务状态'
  if (['CONTENT_REJECTED', 'CONTENT_POLICY_VIOLATION'].includes(code ?? '')) return '请检查需求描述和参考内容是否符合生成服务的内容要求'
  return '请查看原任务状态；持续失败请联系平台管理员'
}
