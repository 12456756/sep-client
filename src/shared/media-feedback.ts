import type { MediaGenerationStatus, MediaSaveStatus, MediaTrackingStatus } from './media'

export interface MediaIssueState {
  generationStatus: MediaGenerationStatus | string
  trackingStatus: MediaTrackingStatus
  saveStatus: MediaSaveStatus
  error: string | null
}

export const MEDIA_BUSINESS_MESSAGES: Readonly<Record<string, string>> = {
  INSUFFICIENT_FUNDS: '可用资金不足，请联系平台管理员',
  VIDEO_BUDGET_EXCEEDED: '已超过企业视频预算，请联系平台管理员',
  MEDIA_FORBIDDEN: '当前账号没有视频生成权限，请联系平台管理员',
  QUOTE_EXPIRED: '本次报价已过期，请重新发起',
  VIDEO_CONCURRENCY_LIMIT: '视频任务数已达上限，请稍后重试',
  NETWORK_ERROR: '网络连接失败，请检查网络',
  NETWORK_TIMEOUT: '网络连接超时，请稍后重试',
  VIDEO_NETWORK_ERROR: '网络连接失败，请检查网络',
  VIDEO_TIMEOUT: '网络连接超时，请稍后重试',
  VIDEO_AUTH_REQUIRED: '视频任务授权不可用，请联系平台管理员',
  PERMISSION_DENIED: '当前媒体任务权限不可用，请联系平台管理员',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  AUTH_REQUIRED: '登录状态已失效，请重新登录',
}

export function mediaIssueMessage(job: MediaIssueState, kind: 'image' | 'video'): string | null {
  const name = kind === 'image' ? '图片' : '视频'
  // An unconfirmed submission must never be presented as a proven rejection.
  if (job.generationStatus === 'SUBMISSION_UNKNOWN') return `${name}提交结果尚未确认，请查看原任务，勿重复提交`
  if (job.error && Object.hasOwn(MEDIA_BUSINESS_MESSAGES, job.error)) return MEDIA_BUSINESS_MESSAGES[job.error]
  if (job.error === 'RESULT_EXPIRED') return `${name}结果已过期，无法重新下载`
  if (job.error === 'TRACKING_LIMIT') return `${name}跟踪已达本轮上限，请恢复原任务跟踪`
  if (job.error === 'QUERY_UNAVAILABLE') return `${name}原任务暂时无法查询，请联系平台管理员`
  if (job.error === 'DOWNLOAD_UNAVAILABLE') return `${name}原结果暂时无法下载，请联系平台管理员`
  if (job.saveStatus === 'MISSING') return '本地成果文件缺失，请重新保存原结果'
  if (job.saveStatus === 'SAVE_FAILED') return `${name}成果保存失败，请联系平台管理员`
  if (job.generationStatus === 'RESULT_EXPIRED') return `${name}结果已过期，无法重新下载`
  if (job.trackingStatus === 'AUTH_REQUIRED') return `${name}任务授权不可用，请联系平台管理员`
  if (job.trackingStatus === 'INTERRUPTED') return `${name}任务跟踪中断，请联系平台管理员`
  if (job.generationStatus === 'FAILED') return `${name}生成失败，请联系平台管理员`
  if (job.generationStatus === 'PARTIAL_SUCCEEDED') return `部分${name}未生成成功，请联系平台管理员`
  if (job.error && job.error !== 'TRACKING_STOPPED' && job.generationStatus !== 'CANCELLED') return `${name}任务处理失败，请联系平台管理员`
  return null
}
