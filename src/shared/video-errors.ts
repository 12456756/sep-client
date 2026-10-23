/** Public, non-sensitive video error codes that may cross the tool/UI boundary. */
const VIDEO_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  INSUFFICIENT_FUNDS: '可用资金不足。',
  VIDEO_BUDGET_EXCEEDED: '已超过企业视频预算。',
  MEDIA_FORBIDDEN: '当前账号没有视频生成权限。',
  QUOTE_EXPIRED: '本次视频报价已过期。',
  VIDEO_CONCURRENCY_LIMIT: '视频任务数已达到并发上限，请稍后重试。',
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
