import type { MediaGenerationStatus, MediaSaveStatus, MediaTrackingStatus } from './media'
import { MEDIA_SPEC_ERROR_MESSAGES, imageRequestedSpecSchema, videoRequestedSpecSchema, type MediaSpecFailureContext } from './media-spec-contract'
import type { MediaUpstreamError } from './media-upstream-error'
import { IMAGE_MISSING_TARGET_MESSAGE, isImageMissingTargetRejection, mediaFailureCodeSchema, mediaFailureSchema, mediaSubmissionRejected, mediaFailureNeedsBillingQuery, type MediaFailure } from './media-failure'
import { mediaErrorReason, mediaRecoveryAdvice, mediaUpstreamReason } from './media-error-messages'
import type { MediaExecutionFields } from './media-execution'
import { mediaGenerationFinished } from './media-execution'
import { mediaUpstreamMessage } from './media-upstream-error'

function diagnosticText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return mediaUpstreamMessage(value) ?? JSON.stringify(value)?.slice(0, 1000) ?? null
}

export interface MediaIssueState extends MediaExecutionFields {
  rateLimitRetryAt?: number
  generationStatus: MediaGenerationStatus | string
  trackingStatus: MediaTrackingStatus
  saveStatus: MediaSaveStatus
  error: string | null
  upstreamError?: MediaUpstreamError
  failure?: MediaFailure
  submissionFailure?: MediaFailure
  outputErrors?: { index: number; code: string }[]
  canRetrySave?: boolean
  canResumeTracking?: boolean
  canDownload?: boolean
  billingStatus?: string
  outputs?: readonly { outputId: string; expiresAt: string | number | null }[]
  savedOutputIds?: readonly string[]
}

function generationOutcome(job: MediaIssueState, name: string): string | null {
  if (job.generationStatus === 'SUBMISSION_UNKNOWN') return null
  if (job.generationStatus === 'FAILED') {
    if (job.execution?.submissionStatus === 'protocol_error') return `${name}提交因协议错误结束`
    if (mediaSubmissionRejected(job.submissionFailure ?? job.failure) || job.execution?.submissionStatus === 'not_submitted') return `${name}未提交，本次请求已结束`
  }
  switch (job.generationStatus) {
    case 'SUCCEEDED': return `${name}已生成`
    case 'PARTIAL_SUCCEEDED': return `部分${name}已生成`
    case 'FAILED': return `${name}生成失败`
    case 'CANCELLED': return `${name}任务已取消`
    case 'RESULT_EXPIRED': return `${name}结果已过期，无法重新下载`
    case 'NOT_SUBMITTED': return `${name}尚未提交`
    default: return mediaGenerationFinished(job) ? `${name}生成流程已结束` : null
  }
}

function billingNeedsQuery(job: MediaIssueState): boolean {
  return job.clientActions?.pollPurpose === 'billing' || ['RESERVED', 'RECONCILING'].includes(job.billingStatus ?? '')
    || mediaFailureNeedsBillingQuery(job.submissionFailure ?? job.failure)
}

function originalRecoveryAdvice(job: MediaIssueState): string {
  if (job.canResumeTracking === false) return '当前无法继续查询原任务，请联系平台管理员核实'
  if (billingNeedsQuery(job)) return '费用待核对，可恢复原任务的费用查询'
  if (!mediaGenerationFinished(job)) return '可恢复原任务跟踪，勿重复生成'
  if (job.clientActions?.shouldPoll) return '可恢复原任务的文件获取或状态查询，无需重新生成'
  return '已确认的生成结果保持不变'
}

function expiredResults(job: MediaIssueState): { any: boolean; all: boolean } {
  const unsaved = job.outputs?.filter(output => job.savedOutputIds !== undefined
    ? !job.savedOutputIds.includes(output.outputId) : job.saveStatus !== 'SAVED') ?? []
  if (job.saveStatus === 'SAVED' && !unsaved.length && job.generationStatus !== 'RESULT_EXPIRED') return { any: false, all: false }
  if (job.fileStatus === 'expired' || job.generationStatus === 'RESULT_EXPIRED' || job.error === 'RESULT_EXPIRED') return { any: true, all: true }
  const expired = unsaved.filter(output => {
    const deadline = typeof output.expiresAt === 'string' ? Date.parse(output.expiresAt) : output.expiresAt
    return deadline !== null && Number.isFinite(deadline) && deadline <= Date.now()
  })
  return { any: expired.length > 0, all: unsaved.length > 0 && expired.length === unsaved.length }
}

function saveRecoveryAdvice(job: MediaIssueState): string {
  const reason = job.failure?.reasonCode
  return `${reason === 'ENOSPC' || reason === 'EDQUOT' ? '请清理磁盘空间后' : ['EACCES', 'EPERM', 'EROFS'].includes(reason ?? '') ? '请检查保存目录的读写权限后' : '请'}重新保存原结果`
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

const FAILURE_STAGES: Record<MediaFailure['stage'], string> = {
  'image-authorization': '图片授权', 'image-quote': '图片报价', 'image-submit': '图片提交', 'image-query': '图片查询', 'image-save': '图片保存',
  'video-authorization': '视频授权', 'video-quote': '视频报价', 'video-submit': '视频提交', 'video-query': '视频查询', 'video-save': '视频保存',
}

function failureReason(job: MediaIssueState): string | null {
  const parsed = mediaFailureSchema.safeParse(job.failure)
  const failure = parsed.success ? parsed.data : undefined
  if (!failure) return mediaFailureCodeSchema.safeParse(job.error).success && !['SUBMISSION_UNKNOWN', 'TRACKING_STOPPED'].includes(job.error!)
    ? mediaErrorReason(job.error) ?? '生成服务返回了尚未识别的错误，客户端未取得具体原因' : null
  // Supplier authentication and quota failures must not be described as the user's login or wallet.
  const reason = failure.source === 'upstream'
    ? mediaUpstreamReason(failure.diagnostic?.body) ?? mediaUpstreamReason({ code: failure.businessCode, message: failure.message }) ?? '生成服务返回异常，尚未提供可识别的具体原因'
    : mediaErrorReason(failure.reasonCode) ?? mediaErrorReason(failure.businessCode)
      ?? mediaUpstreamReason(failure.diagnostic?.body)
      ?? (!['VIDEO_HTTP_ERROR', 'MEDIA_HTTP_ERROR'].includes(failure.gatewayCode ?? '') ? mediaErrorReason(failure.gatewayCode) : null)
      ?? mediaErrorReason(failure.code) ?? '客户端未取得可识别的具体原因'
  return `${FAILURE_STAGES[failure.stage]}：${reason}`
}

function outputFailureReasons(job: MediaIssueState): string {
  return job.outputErrors?.filter(item => Number.isInteger(item.index) && item.index >= 0 && mediaFailureCodeSchema.safeParse(item.code).success)
    .slice(0, 4).map(item => `第 ${item.index + 1} 项：${mediaErrorReason(item.code) ?? '生成失败，尚未取得具体原因'}`).join('；') ?? ''
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
  const reason = mediaErrorReason(error.reasonCode)
  if (reason) parts.push(reason)
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

export function mediaUnconfirmedNotice(job: MediaIssueState, kind: 'image' | 'video') {
  if (job.generationStatus !== 'SUBMISSION_UNKNOWN' || job.rateLimitRetryAt !== undefined) return null
  const name = kind === 'image' ? '图片' : '视频'
  const receiptReason = job.upstreamError ? mediaUpstreamReason(job.upstreamError.body) : null
  const initialReason = job.submissionFailure ? failureReason({ ...job, failure: job.submissionFailure, error: null }) : null
  return {
    title: `${name}提交结果尚未确认`,
    advice: job.error === 'QUERY_UNAVAILABLE' || job.canResumeTracking === false
      ? '当前无法查询原任务，请联系平台管理员核实' : '请查询原任务',
    detail: [...new Set([receiptReason, initialReason, failureReason(job)].filter(Boolean))].join('；'),
  }
}

export function mediaIssueMessage(job: MediaIssueState, kind: 'image' | 'video', options: { diagnostics?: boolean } = {}): string | null {
  if (job.rateLimitRetryAt !== undefined) {
    const name = kind === 'image' ? '图片' : '视频'
    const outcome = generationOutcome(job, name)
    if (job.saveStatus === 'SAVED') return `${outcome ?? `${name}已生成`}并保存，状态或费用查询受限，等待自动恢复查询`
    if (['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)) return `${outcome}，请求受限，等待自动恢复原结果，无需重新生成`
    return outcome ? `${outcome}；后续状态或费用查询受限，等待自动恢复查询` : '请求受限，正在等待自动重试原请求'
  }
  if (kind === 'image' && job.generationStatus === 'FAILED' && isImageMissingTargetRejection(job.failure)) return IMAGE_MISSING_TARGET_MESSAGE
  const name = kind === 'image' ? '图片' : '视频'
  const outcome = generationOutcome(job, name)
  const expiry = expiredResults(job)
  const expiryMessage = `${expiry.all ? name : `部分${name}`}原结果已过期，无法重新下载；已保存的成果仍可使用`
  if (job.error === 'TRACKING_LIMIT') {
    const state = outcome ?? (job.generationStatus === 'SUBMISSION_UNKNOWN' ? '提交结果仍待确认' : '最新生成结果仍待确认')
    const reason = failureReason({ ...job, error: null })
    return `${name}本轮恢复已达查询或时长上限，${state}；${expiry.any ? `${expiryMessage}；` : ''}${originalRecoveryAdvice(job)}${reason ? `；${reason}` : ''}`
  }
  if (job.receiptVersion === 2 && job.execution) {
    const execution = job.execution
    const taskError = diagnosticText(execution.taskError)
    const submissionError = diagnosticText(execution.submissionError)
    const recordError = diagnosticText(execution.submissionRecordError)
    const operationError = mediaUpstreamMessage(execution.operationError?.body)
    const billingError = mediaUpstreamMessage(job.billingError?.body) ?? mediaUpstreamMessage(execution.billing.error)
    const messages: string[] = []
    if (job.generationStatus === 'SUBMISSION_UNKNOWN') messages.push(`${name}提交结果尚未确认，请查询原任务，勿重复提交`)
    else if (execution.submissionStatus === 'protocol_error') messages.push(`${name}提交因协议错误结束${submissionError ? `：${submissionError}` : ''}`)
    else if (job.generationStatus === 'FAILED') messages.push(`${name}${execution.submissionStatus === 'not_submitted' ? '未提交' : '生成失败'}${submissionError || taskError ? `：${submissionError ?? taskError}` : ''}`)
    else if (job.generationStatus === 'CANCELLED') messages.push(`${name}任务已取消`)
    else if (expiry.any) messages.push(`${outcome ?? `${name}生成流程已结束`}；${expiryMessage}`)
    else if (job.saveStatus !== 'SAVED' && execution.generationStatus === 'completed' && job.fileStatus === 'download_failed') messages.push(`${name}生成已完成，取得文件失败${job.clientActions?.shouldPoll ? '，可恢复原任务获取原文件' : '，原结果当前不可下载，请联系平台管理员'}`)
    if (operationError) messages.push(`原任务操作异常：${operationError}`)
    if (submissionError && job.generationStatus !== 'FAILED') messages.push(`原提交失败原因：${submissionError}`)
    if (taskError && submissionError && taskError !== submissionError) messages.push(`任务错误：${taskError}`)
    if (execution.submissionHttpStatus !== undefined) messages.push(`原提交 HTTP ${execution.submissionHttpStatus}`)
    if (recordError) messages.push(`提交回执保存异常：${recordError}`)
    if (execution.diagnosticTruncated) messages.push('错误详情已截断')
    if (execution.billing.status === 'not_charged' && job.billingError) messages.push('上游确认不扣费，平台预留金额尚待核对')
    else if (job.clientActions?.pollPurpose === 'billing') messages.push('生成流程已结束，费用待核对')
    if (billingError) messages.push(`费用异常：${billingError}`)
    if (job.failure) { const reason = failureReason(job); if (reason) messages.push(reason) }
    if (job.saveStatus === 'SAVE_FAILED' && !expiry.all) {
      const unavailable = job.canRetrySave === false || job.canDownload === false || job.fileStatus === 'unavailable'
      messages.push(unavailable
        ? `${outcome ?? name}，原结果当前不可下载，请联系平台管理员`
        : `${outcome ?? name}，本地保存失败，${saveRecoveryAdvice(job)}，无需重新生成`)
    }
    if (job.trackingStatus === 'INTERRUPTED' && outcome) messages.push(`${outcome}；本地状态查询已中断，${originalRecoveryAdvice(job)}`)
    if (job.trackingStatus === 'AUTH_REQUIRED') messages.push('请恢复授权后查询原任务')
    if (messages.length) return messages.join('；')
  }
  // An unconfirmed submission must never be presented as a proven rejection.
  const unconfirmed = mediaUnconfirmedNotice(job, kind)
  if (unconfirmed) return `${unconfirmed.title}${unconfirmed.detail ? `；已知异常：${unconfirmed.detail}` : ''}；${unconfirmed.advice}，勿重复提交`
  const reason = failureReason(job)
  const rejected = job.submissionFailure ?? job.failure
  if (job.generationStatus === 'FAILED' && mediaSubmissionRejected(rejected)) {
    const original = (options.diagnostics !== false ? diagnosticText(rejected?.diagnostic?.body) : null) ?? failureReason({ ...job, failure: rejected, error: null })
    const billing = rejected?.billingState === 'not_reserved' ? '未预占费用'
      : rejected?.billingState === 'released' ? '预占费用已释放'
        : rejected?.billingState === 'settled' ? '费用已结算' : '费用状态待核对'
    return [`${name}未提交，本次请求已结束`, original, options.diagnostics !== false && rejected?.httpStatus ? `提交 HTTP ${rejected.httpStatus}` : null,
      billing, job.failure !== rejected ? reason : null].filter(Boolean).join('；')
  }
  const receiptReason = job.upstreamError ? mediaUpstreamReason(job.upstreamError.body) : null
  const outputReasons = outputFailureReasons(job)
  const generationIssue = ['FAILED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus) && receiptReason
    ? `${job.generationStatus === 'PARTIAL_SUCCEEDED' ? `部分${name}` : name}生成失败：${receiptReason}`
    : outcome && (job.failure?.stage.endsWith('-query') || ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus) && job.saveStatus === 'SAVE_FAILED') ? outcome : ''
  if (expiry.any) {
    const remaining = !expiry.all && ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus)
      && job.canRetrySave !== false && job.canDownload !== false ? '其余未过期成果可重新保存原结果，无需重新生成' : null
    return [generationIssue, outputReasons, expiryMessage, !expiry.all ? reason : null, remaining].filter(Boolean).join('；')
  }
  if ((job.canRetrySave === false || job.canDownload === false) && ['MISSING', 'SAVE_FAILED'].includes(job.saveStatus)) {
    return [generationIssue, outputReasons, reason, '原结果当前不可下载，请联系平台管理员。'].filter(Boolean).join('；')
  }
  const recoveryCode = job.failure?.source === 'upstream' ? undefined : job.failure?.businessCode ?? job.failure?.code ?? job.error
  if (job.generationStatus === 'CANCELLED') {
    return [outcome, reason, billingNeedsQuery(job) ? originalRecoveryAdvice(job) : null].filter(Boolean).join('；')
  }
  if (job.failure && reason) {
    const advice = job.saveStatus === 'SAVE_FAILED'
      ? saveRecoveryAdvice(job)
      : mediaRecoveryAdvice(recoveryCode)
    return `${generationIssue ? `${generationIssue}；` : ''}${reason}${outputReasons ? `；${outputReasons}` : ''}${job.generationStatus === 'PARTIAL_SUCCEEDED' ? '；已生成的成果可继续使用' : ''}；${advice}，勿重复生成。`
  }
  if (job.upstreamError && ['FAILED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)) {
    const upstreamReason = receiptReason ?? '生成服务返回异常，尚未提供可识别的具体原因'
    return `${job.generationStatus === 'PARTIAL_SUCCEEDED' ? `部分${name}生成失败` : `${name}生成失败`}：${upstreamReason}${outputReasons ? `；${outputReasons}` : ''}；${job.generationStatus === 'PARTIAL_SUCCEEDED' ? '已生成的成果可继续使用；' : ''}请联系平台管理员。`
  }
  if (outputReasons && ['FAILED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)) {
    const details = [reason, outputReasons].filter(Boolean).join('；')
    return job.generationStatus === 'PARTIAL_SUCCEEDED'
      ? `部分${name}未生成成功；${details}；已生成的成果可继续使用。`
      : `${name}生成失败；${details}；${mediaRecoveryAdvice(job.error)}。`
  }
  if (job.error === 'MEDIA_FORBIDDEN') return `当前账号没有${name}生成权限，请联系企业管理员开通权限。`
  if (job.error && Object.hasOwn(MEDIA_BUSINESS_MESSAGES, job.error)) return `${outcome && job.trackingStatus === 'INTERRUPTED' ? `${outcome}；` : ''}${MEDIA_BUSINESS_MESSAGES[job.error]}`
  if (job.error === 'QUERY_UNAVAILABLE') return `${outcome ? `${outcome}；` : ''}平台当前无法查询原${name}任务，请联系平台管理员核实。`
  if (job.error === 'DOWNLOAD_UNAVAILABLE') return `原${name}结果暂时不允许下载，请稍后重新保存原结果，勿重复生成；持续失败请联系平台管理员。`
  if (job.saveStatus === 'MISSING') return '本地成果文件缺失，请重新保存原结果'
  if (job.error === 'VIDEO_LOCAL_OUTPUT_INVALID') return '本地视频文件损坏或与保存记录不一致，请重新保存原结果，勿重复生成。'
  if (job.saveStatus === 'SAVE_FAILED') return `${outcome && ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus) ? `${outcome}；` : ''}${name}成果下载、文件校验或本地保存失败，请重新保存原结果，并检查磁盘空间和保存权限，勿重复生成。`
  if (job.trackingStatus === 'AUTH_REQUIRED') return `${name}任务的访问授权不可用，请重新登录后恢复原任务；仍失败请联系平台管理员检查授权。`
  if (receiptReason && ['RUNNING', 'QUEUED'].includes(job.generationStatus)) return `${name}任务尚未完成；已知异常：${receiptReason}；请查看原任务状态，勿重复生成；持续失败请联系平台管理员。`
  if (job.trackingStatus === 'INTERRUPTED') return outcome
    ? `${outcome}；本地状态查询已中断，${originalRecoveryAdvice(job)}。`
    : `${name}任务跟踪已中断，尚未确认原任务的最新状态，请恢复原任务跟踪，勿重复生成。`
  const details = [reason, outputReasons].filter(Boolean).join('；') || '尚无可展示的具体原因'
  if (job.generationStatus === 'FAILED') return `${name}生成失败；${details}；${mediaRecoveryAdvice(job.error)}。`
  if (job.generationStatus === 'PARTIAL_SUCCEEDED') return `部分${name}未生成成功；${details}；已生成的成果可继续使用。`
  if (reason) return `${reason}；${mediaRecoveryAdvice(job.error)}。`
  if (job.error && job.error !== 'TRACKING_STOPPED' && job.generationStatus !== 'CANCELLED') return `${name}任务处理异常，客户端没有取得具体原因，请查看原任务状态；持续失败请联系平台管理员。`
  return null
}
