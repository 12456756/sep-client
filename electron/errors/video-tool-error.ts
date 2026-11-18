import { AppError } from './app-error'
import { AuthApiError } from '../common/platform/platform-api'
import { mediaSpecToolFailureFrom, mediaToolFailure, mediaToolFailureFrom, type MediaToolFailure } from './media-tool-error'
import { videoErrorMessage } from '../../src/shared/video-errors'

/** Fixed diagnostics: never forward arbitrary exception messages, causes or provider responses. */
export interface VideoToolFailureDiagnostic {
  code: string
  exceptionType: string
  httpStatus?: number
  resource?: string
  stage?: string
  requestId?: string
}

const SAFE_EXCEPTION_TYPES = new Set(['Error', 'TypeError', 'AuthApiError', 'AppError', 'ZodError', 'SepVideoGatewayError'])
const SAFE_RESOURCES = new Set(['skills', 'subscriptions', 'employment-token', 'video'])
const SAFE_STAGES = new Set(['skill-preparation', 'video-authorization', 'video-quote', 'video-submit', 'video-query'])

function safeExceptionType(value: unknown): string {
  return typeof value === 'string' && SAFE_EXCEPTION_TYPES.has(value) ? value : 'Error'
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 599 ? value : undefined
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
}

const VIDEO_MESSAGES: Partial<Record<AppError['code'], string>> = {
  AUTH_REQUIRED: '视频访问授权已失效，请重新登录后查询原任务，勿重复生成。',
  PERMISSION_DENIED: '视频操作权限不足或未获批准，请检查工作权限和审批结果，不能据此判断视频模型未配置。',
  INVALID_ARGUMENT: '视频输入或生成规格无效，请先查询已授权的视频模型和参考图，保留用户要求并补充规格或向用户确认；不要擅自使用默认规格，不能据此判断没有权限。',
  NOT_FOUND: '未找到所请求的视频任务或资源，请查看原任务，勿重复生成。',
  CONFLICT: '视频操作正在处理，请查询原任务，勿自动提交另一笔付费生成请求。',
  INVALID_STATE: '视频任务状态尚未确认，请查询原任务，勿自动提交另一笔付费生成请求。',
  RATE_LIMITED: '视频服务请求过于频繁，请稍后查询原任务，勿自动重新生成。',
  NETWORK_ERROR: '无法连接视频服务，请检查网络后查询原任务，不能据此判断视频模型未配置。',
  SERVICE_UNAVAILABLE: '视频服务暂时不可用或响应异常，请查询原任务；持续失败请联系平台管理员，不能据此判断视频模型未配置。',
}

function authFailure(error: AuthApiError): { failure: MediaToolFailure; diagnostic: VideoToolFailureDiagnostic } {
  const status = error.statusCode
  const code = status === 401 ? 'AUTH_REQUIRED'
    : status === 403 ? 'PERMISSION_DENIED'
      : status === 404 ? 'NOT_FOUND'
        : status === 429 ? 'RATE_LIMITED'
          : status === 0 ? 'NETWORK_ERROR'
            : status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR'
  const message = error.resource === 'skills' && status === 429
    ? '视频所需能力包的准备请求过于频繁，请稍后再试，勿自动重发视频生成请求。'
    : VIDEO_MESSAGES[code as AppError['code']] ?? '视频操作失败，尚未取得具体原因，请联系平台管理员；勿推断模型缺失或自动重新生成。'
  return {
    failure: mediaToolFailure(code, message),
    diagnostic: { code, exceptionType: safeExceptionType(error.name), ...(safeStatus(status) === undefined ? {} : { httpStatus: safeStatus(status) }),
      ...(SAFE_RESOURCES.has(error.resource ?? '') ? { resource: error.resource } : {}),
      ...(error.resource === 'skills' ? { stage: 'skill-preparation' } : {}) },
  }
}

export function videoToolFailureFrom(error: unknown): MediaToolFailure {
  if (error instanceof AuthApiError) return authFailure(error).failure
  if (!(error instanceof AppError)) return mediaToolFailure('INTERNAL_ERROR', '视频操作失败，尚未取得具体原因，请联系平台管理员；勿推断模型缺失或自动重新生成。')
  const meta = mediaToolFailureFrom(error).error
  if (error.details?.source === 'upstream') return mediaToolFailure(error.code, meta.message, meta)
  if (['MISSING_SPEC', 'SPEC_CONFLICT', 'UPGRADE_REQUIRED', 'ADAPTER_UNAVAILABLE', 'ADAPTER_FIELD_UNMAPPED', 'PRICE_UNAVAILABLE', 'UPSTREAM_SPEC_UNSUPPORTED', 'OUTPUT_SPEC_MISMATCH'].includes(error.code)) return mediaSpecToolFailureFrom(error)
  const businessMessage = videoErrorMessage(error.code)
  if (businessMessage) return mediaToolFailure(error.code, businessMessage, meta)
  if (error.code === 'PERMISSION_DENIED' && error.details?.stage === 'video-quote') {
    return mediaToolFailure(error.code, '平台拒绝了视频报价请求，尚未进入本地审批或视频提交；这不是本地审批拒绝，请联系平台管理员检查授权，勿推断模型缺失或自动重新生成。', meta)
  }
  if (error.code === 'PERMISSION_DENIED' && error.details?.stage === 'video-authorization') {
    return mediaToolFailure(error.code, '视频访问凭据获取被拒绝，尚未发起生成服务请求或进入本地审批，请联系平台管理员检查授权，勿自动重新生成。', meta)
  }
  if (error.details?.businessCode || error.details?.gatewayCode) return mediaToolFailure(error.code, meta.message, meta)
  return mediaToolFailure(error.code, VIDEO_MESSAGES[error.code] ?? '视频操作失败，尚未取得具体原因，请联系平台管理员；勿推断模型缺失或自动重新生成。', meta)
}

export function videoToolFailureDiagnostic(error: unknown): VideoToolFailureDiagnostic {
  if (error instanceof AuthApiError) return authFailure(error).diagnostic
  if (error instanceof AppError) {
    const candidateStatus = error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined
    const status = safeStatus(candidateStatus) ?? safeStatus(error.details?.statusCode)
    return {
      code: error.code,
      exceptionType: safeExceptionType(error.name),
      ...(status === undefined ? {} : { httpStatus: status }),
      ...(typeof error.details?.stage === 'string' && SAFE_STAGES.has(error.details.stage) ? { stage: error.details.stage } : {}),
      ...(typeof error.details?.resource === 'string' && SAFE_RESOURCES.has(error.details.resource) ? { resource: error.details.resource } : {}),
      ...(safeRequestId(error.details?.requestId) ? { requestId: safeRequestId(error.details?.requestId) } : {}),
    }
  }
  const candidate = error instanceof Error ? error.name : undefined
  const status = error && typeof error === 'object' ? safeStatus((error as { statusCode?: unknown }).statusCode) : undefined
  return { code: 'INTERNAL_ERROR', exceptionType: safeExceptionType(candidate), ...(status === undefined ? {} : { httpStatus: status }) }
}
