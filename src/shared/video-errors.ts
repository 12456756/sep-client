/** Public, non-sensitive video error codes that may cross the tool/UI boundary. */
const VIDEO_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  INSUFFICIENT_FUNDS: '可用资金不足。',
  VIDEO_BUDGET_EXCEEDED: '已超过企业视频预算。',
  MEDIA_FORBIDDEN: '当前账号没有视频生成权限。',
  QUOTE_EXPIRED: '本次视频报价已过期。',
  VIDEO_CONCURRENCY_LIMIT: '视频任务数已达到并发上限，请稍后重试。',
  MISSING_SPEC: '生成规格尚未完整，请根据用途补充方案或向用户澄清。',
  SPEC_CONFLICT: '生成规格相互冲突，或报价改变了请求规格，请重新确认。',
  UPGRADE_REQUIRED: '当前服务尚不支持新版媒体规格协议，请升级服务后继续。',
  PRICE_UNAVAILABLE: '当前规格没有可靠报价，尚不能继续生成。',
  ADAPTER_UNAVAILABLE: '当前视频通道尚无可用适配器。',
  ADAPTER_FIELD_UNMAPPED: '适配器尚不能传递此规格，未忽略或替换该字段。',
  UPSTREAM_SPEC_UNSUPPORTED: '上游不支持本次请求规格，请重新选择方案。',
  OUTPUT_SPEC_MISMATCH: '实际视频与约定规格不符，请核对产物及账务状态。',
})

/** Platform submit errors that prove generation was not dispatched and funds were not reserved. */
const VIDEO_SUBMISSION_REJECTION_CODES = new Set([
  'INSUFFICIENT_FUNDS',
  'VIDEO_BUDGET_EXCEEDED',
  'QUOTE_EXPIRED',
  'VIDEO_CONCURRENCY_LIMIT',
])

export function videoErrorMessage(code: string | null | undefined): string | null {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(VIDEO_ERROR_MESSAGES, code) ? VIDEO_ERROR_MESSAGES[code]! : null
}

export function isVideoSubmissionRejectionCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && VIDEO_SUBMISSION_REJECTION_CODES.has(code)
}
