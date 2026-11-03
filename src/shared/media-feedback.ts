import type { MediaGenerationStatus, MediaSaveStatus, MediaTrackingStatus } from './media'
import { MEDIA_SPEC_ERROR_MESSAGES, imageRequestedSpecSchema, videoRequestedSpecSchema, type MediaSpecFailureContext } from './media-spec-contract'

export interface MediaIssueState {
  generationStatus: MediaGenerationStatus | string
  trackingStatus: MediaTrackingStatus
  saveStatus: MediaSaveStatus
  error: string | null
}

export const MEDIA_BUSINESS_MESSAGES: Readonly<Record<string, string>> = {
  ...MEDIA_SPEC_ERROR_MESSAGES,
  INSUFFICIENT_FUNDS: '当前账号可用资金不足，请联系企业管理员补充资金后重试。',
  VIDEO_BUDGET_EXCEEDED: '已达到企业视频预算上限，请联系企业管理员调整预算后重试。',
  MEDIA_FORBIDDEN: '当前账号没有视频生成权限，请联系企业管理员开通权限。',
  QUOTE_EXPIRED: '本次报价已过期，请重新发起',
  VIDEO_CONCURRENCY_LIMIT: '视频任务数已达上限，请稍后重试',
  NETWORK_ERROR: '网络连接失败，请检查网络',
  NETWORK_TIMEOUT: '网络连接超时，请稍后重试',
  VIDEO_NETWORK_ERROR: '网络连接失败，请检查网络',
  VIDEO_TIMEOUT: '网络连接超时，请稍后重试',
  VIDEO_AUTH_REQUIRED: '视频任务的访问授权不可用，请重新登录后恢复原任务；仍失败请联系平台管理员检查授权。',
  PERMISSION_DENIED: '当前账号无权访问该媒体任务，请检查工作权限；如需授权，请联系平台管理员。',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  AUTH_REQUIRED: '登录状态已失效，请重新登录',
}

const SPEC_LABELS: Readonly<Record<string, string>> = {
  size: '尺寸', width: '宽度', height: '高度', aspectRatio: '比例', count: '数量', quality: '质量',
  durationSeconds: '时长（秒）', resolution: '分辨率', frameRate: '帧率', audio: '音轨', outputFormat: '格式',
}
const SPEC_SOURCES: Readonly<Record<string, string>> = { client: '客户端', sep: '平台', platform: '平台', adapter: '适配器',
  pricing: '报价服务', sub2api: '上游网关', provider: '上游模型', upstream: '上游', authorization: '授权服务' }

/** Direct IPC failures expose safe business context, never provider response text. */
export function mediaSpecFailureMessage(error: { code: string; message?: string } & MediaSpecFailureContext): string | null {
  if (!Object.hasOwn(MEDIA_SPEC_ERROR_MESSAGES, error.code)) return null
  const parts = [MEDIA_SPEC_ERROR_MESSAGES[error.code]]
  if (error.source && Object.hasOwn(SPEC_SOURCES, error.source)) parts.push(`来源：${SPEC_SOURCES[error.source]}`)
  const field = error.field?.split('.').at(-1)
  if (field && Object.hasOwn(SPEC_LABELS, field)) {
    const spec = { [field]: error.requestedValue }
    const valid = imageRequestedSpecSchema.safeParse(spec).success || videoRequestedSpecSchema.safeParse(spec).success
    parts.push(`${SPEC_LABELS[field]}${valid && error.requestedValue !== undefined ? `：${String(error.requestedValue)}` : ''}`)
  }
  const alternatives = error.alternatives?.slice(0, 8).flatMap(spec => {
    const image = imageRequestedSpecSchema.safeParse(spec), video = videoRequestedSpecSchema.safeParse(spec)
    const parsed = image.success ? image.data : video.success ? video.data : undefined
    return parsed ? [Object.entries(parsed).map(([key, value]) => `${SPEC_LABELS[key]} ${String(value)}`).join('、')].filter(Boolean) : []
  })
  if (alternatives?.length) parts.push(`可选方案（尚未执行）：${alternatives.join('；')}`)
  return parts.join('；')
}

export function mediaIssueMessage(job: MediaIssueState, kind: 'image' | 'video'): string | null {
  const name = kind === 'image' ? '图片' : '视频'
  // An unconfirmed submission must never be presented as a proven rejection.
  if (job.generationStatus === 'SUBMISSION_UNKNOWN') return `${name}提交结果尚未确认，请查看原任务，勿重复提交`
  if (job.error && Object.hasOwn(MEDIA_BUSINESS_MESSAGES, job.error)) return MEDIA_BUSINESS_MESSAGES[job.error]
  if (job.error === 'RESULT_EXPIRED') return `${name}结果已过期，无法重新下载`
  if (job.error === 'TRACKING_LIMIT') return `${name}跟踪已达本轮上限，请恢复原任务跟踪`
  if (job.error === 'QUERY_UNAVAILABLE') return `平台当前无法查询原${name}任务，请稍后恢复原任务跟踪，勿重复生成；持续失败请联系平台管理员。`
  if (job.error === 'DOWNLOAD_UNAVAILABLE') return `原${name}结果暂时不允许下载，请稍后重新保存原结果，勿重复生成；持续失败请联系平台管理员。`
  if (job.saveStatus === 'MISSING') return '本地成果文件缺失，请重新保存原结果'
  if (job.saveStatus === 'SAVE_FAILED') return `${name}成果下载、文件校验或本地保存失败，请重新保存原结果，并检查磁盘空间和保存权限，勿重复生成。`
  if (job.generationStatus === 'RESULT_EXPIRED') return `${name}结果已过期，无法重新下载`
  if (job.trackingStatus === 'AUTH_REQUIRED') return `${name}任务的访问授权不可用，请重新登录后恢复原任务；仍失败请联系平台管理员检查授权。`
  if (job.trackingStatus === 'INTERRUPTED') return `${name}任务跟踪已中断，尚未确认原任务的最新状态，请恢复原任务跟踪，勿重复生成。`
  if (job.generationStatus === 'FAILED') return `${name}生成失败，平台未返回可展示的具体原因；持续失败请联系平台管理员。`
  if (job.generationStatus === 'PARTIAL_SUCCEEDED') return `部分${name}未生成成功，平台未返回可展示的具体原因，已生成的成果可继续使用。`
  if (job.error && job.error !== 'TRACKING_STOPPED' && job.generationStatus !== 'CANCELLED') return `${name}任务处理异常，客户端没有取得具体原因，请查看原任务状态；持续失败请联系平台管理员。`
  return null
}
