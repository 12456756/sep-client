import { AppError } from './app-error'
import { AuthApiError } from '../common/platform/platform-api'
import { mediaToolFailure, type MediaToolFailure } from './media-tool-error'

/** Fixed diagnostics: never forward arbitrary exception messages, causes or provider responses. */
export interface VideoToolFailureDiagnostic {
  code: string
  exceptionType: string
  httpStatus?: number
  resource?: string
  stage?: string
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

const VIDEO_MESSAGES: Partial<Record<AppError['code'], string>> = {
  AUTH_REQUIRED: 'Video authentication expired. Sign in again before continuing.',
  PERMISSION_DENIED: 'Video authorization or approval was denied. Do not infer that no video model is configured.',
  INVALID_ARGUMENT: 'Video input or explicit specifications are unsupported. Call video_get_job with {} to inspect video profiles and referenceAssets. Omit profileId and unspecified parameters to use host defaults. This is not a permission denial.',
  NOT_FOUND: 'The requested video resource was not found.',
  CONFLICT: 'A video operation is pending. Query the original job; do not automatically submit another paid request.',
  INVALID_STATE: 'The video state could not be confirmed. Query the original job; do not automatically submit another paid request.',
  RATE_LIMITED: 'The video service is rate limited. Do not automatically resubmit a paid request.',
  NETWORK_ERROR: 'The video service could not be reached. This does not mean a video profile is missing.',
  SERVICE_UNAVAILABLE: 'The video service is unavailable or returned an invalid response. Do not infer a missing profile.',
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
    ? 'Skill preparation is rate limited. Do not automatically retry a video request.'
    : VIDEO_MESSAGES[code as AppError['code']] ?? 'Video operation failed. Do not infer a missing profile or automatically resubmit a paid request.'
  return {
    failure: mediaToolFailure(code, message),
    diagnostic: { code, exceptionType: safeExceptionType(error.name), ...(safeStatus(status) === undefined ? {} : { httpStatus: safeStatus(status) }),
      ...(SAFE_RESOURCES.has(error.resource ?? '') ? { resource: error.resource } : {}),
      ...(error.resource === 'skills' ? { stage: 'skill-preparation' } : {}) },
  }
}

export function videoToolFailureFrom(error: unknown): MediaToolFailure {
  if (error instanceof AuthApiError) return authFailure(error).failure
  if (!(error instanceof AppError)) return mediaToolFailure('INTERNAL_ERROR', 'Video operation failed. Do not infer a missing profile or automatically resubmit a paid request.')
  if (error.code === 'PERMISSION_DENIED' && error.details?.stage === 'video-quote') {
    return mediaToolFailure(error.code, 'The video quote request was denied by SEP before local approval or video submission. This is not a local approval rejection. Do not infer a missing video model or automatically retry a paid request.')
  }
  if (error.code === 'PERMISSION_DENIED' && error.details?.stage === 'video-authorization') {
    return mediaToolFailure(error.code, 'Video authentication token acquisition was denied before the gateway request or local approval. Do not automatically retry a paid request.')
  }
  return mediaToolFailure(error.code, VIDEO_MESSAGES[error.code] ?? 'Video operation failed. Do not infer a missing profile or automatically resubmit a paid request.')
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
    }
  }
  const candidate = error instanceof Error ? error.name : undefined
  const status = error && typeof error === 'object' ? safeStatus((error as { statusCode?: unknown }).statusCode) : undefined
  return { code: 'INTERNAL_ERROR', exceptionType: safeExceptionType(candidate), ...(status === undefined ? {} : { httpStatus: status }) }
}
