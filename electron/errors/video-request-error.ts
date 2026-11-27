import { AppError } from './app-error'
import { isVideoSubmissionRejectionCode, videoErrorMessage } from '../../src/shared/video-errors'
import { isErrorCode, type ErrorCode } from './error-codes'
import type { ApiDiagnostic } from '../../src/shared/api-diagnostic'
import { mediaErrorHasSubmissionState, type MediaSubmissionEvidence } from '../common/platform/media-submission-evidence'

export type VideoRequestStage = 'video-authorization' | 'video-quote' | 'video-submit' | 'video-query' | 'video-save'
export type VideoErrorSource = 'platform' | 'upstream' | null

export interface VideoRequestErrorOptions {
  gatewayCode: string
  statusCode?: number
  stage?: VideoRequestStage
  businessCode?: string | null
  source?: VideoErrorSource
  requestId?: string | null
  message?: string
  diagnostic?: ApiDiagnostic
  submissionEvidence?: MediaSubmissionEvidence
}

function safeId(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
}

export class VideoRequestError extends AppError {
  readonly businessCode: string | null
  readonly definitelyRejected: boolean
  readonly statusCode: number
  readonly stage: VideoRequestStage | undefined
  readonly source: VideoErrorSource
  readonly requestId: string | null

  constructor(options: VideoRequestErrorOptions) {
    const businessCode = typeof options.businessCode === 'string' && /^[A-Z0-9_]{1,96}$/.test(options.businessCode) ? options.businessCode : null
    const statusCode = options.statusCode ?? 0
    const expectedStatus = businessCode === 'INSUFFICIENT_FUNDS' || businessCode === 'VIDEO_BUDGET_EXCEEDED' ? 402 : businessCode === 'QUOTE_EXPIRED' || businessCode === 'VIDEO_CONCURRENCY_LIMIT' ? 409 : 0
    const legacyRejection = !mediaErrorHasSubmissionState(options.diagnostic) && options.stage === 'video-submit' && options.source === 'platform' && safeId(options.requestId) !== null && statusCode === expectedStatus && isVideoSubmissionRejectionCode(businessCode)
    const definite = legacyRejection || options.submissionEvidence?.submissionState === 'not_submitted'
    const mapped: ErrorCode = statusCode === 401 ? 'AUTH_REQUIRED' : statusCode === 403 ? 'PERMISSION_DENIED' : statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 || statusCode === 422 ? 'INVALID_ARGUMENT' : statusCode === 409 || statusCode === 410 ? 'INVALID_STATE' : statusCode === 429 ? 'RATE_LIMITED' : options.gatewayCode === 'VIDEO_NETWORK_ERROR' ? 'NETWORK_ERROR' : options.gatewayCode === 'VIDEO_INVALID_REQUEST' ? 'INVALID_ARGUMENT' : 'SERVICE_UNAVAILABLE'
    const code: ErrorCode = options.source === 'upstream' ? 'SERVICE_UNAVAILABLE' : businessCode !== null && isErrorCode(businessCode) ? businessCode : mapped
    super(code, {
      message: videoErrorMessage(businessCode) ?? '视频服务请求失败，请联系平台管理员。',
      diagnostic: options.diagnostic,
      details: { resource: 'video', gatewayCode: options.gatewayCode, statusCode, ...(options.source ? { source: options.source } : {}), ...(options.source === 'upstream' && options.message ? { upstreamMessage: options.message } : {}), ...(options.stage ? { stage: options.stage } : {}), ...(safeId(options.requestId) ? { requestId: safeId(options.requestId)! } : {}), ...(businessCode ? { businessCode } : {}),
        ...(legacyRejection ? { submissionState: 'not_submitted', billingState: 'not_reserved' } : {}), ...options.submissionEvidence,
        ...(definite ? { submissionConfirmedNotSent: true } : {}) },
    })
    this.name = options.gatewayCode === 'VIDEO_ABORTED' ? 'AbortError' : 'VideoRequestError'
    this.businessCode = businessCode
    this.definitelyRejected = definite
    this.statusCode = statusCode
    this.stage = options.stage
    this.source = options.source ?? null
    this.requestId = safeId(options.requestId)
  }
}
