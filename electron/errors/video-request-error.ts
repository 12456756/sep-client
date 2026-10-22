import { AppError } from './app-error'
import { isVideoSubmissionRejectionCode, videoErrorMessage } from '../../src/shared/video-errors'
import { isErrorCode, type ErrorCode } from './error-codes'

export type VideoRequestStage = 'video-authorization' | 'video-quote' | 'video-submit'
export type VideoErrorSource = 'platform' | 'upstream' | null

export interface VideoRequestErrorOptions {
  gatewayCode: string
  statusCode?: number
  stage?: VideoRequestStage
  businessCode?: string | null
  source?: VideoErrorSource
  requestId?: string | null
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
    const definite = options.stage === 'video-submit' && options.source === 'platform' && safeId(options.requestId) !== null && statusCode === expectedStatus && isVideoSubmissionRejectionCode(businessCode)
    const mapped: ErrorCode = statusCode === 401 ? 'AUTH_REQUIRED' : statusCode === 403 ? 'PERMISSION_DENIED' : statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'INVALID_ARGUMENT' : statusCode === 409 || statusCode === 410 ? 'INVALID_STATE' : statusCode === 429 ? 'RATE_LIMITED' : options.gatewayCode === 'VIDEO_NETWORK_ERROR' ? 'NETWORK_ERROR' : options.gatewayCode === 'VIDEO_INVALID_REQUEST' ? 'INVALID_ARGUMENT' : 'SERVICE_UNAVAILABLE'
    const code: ErrorCode = businessCode !== null && isErrorCode(businessCode) ? businessCode : mapped
    super(code, {
      message: videoErrorMessage(businessCode) ?? `SEP video request failed (${options.gatewayCode}).`,
      details: { resource: 'video', ...(options.stage ? { stage: options.stage } : {}), ...(safeId(options.requestId) ? { requestId: safeId(options.requestId)! } : {}), ...(businessCode ? { businessCode } : {}) },
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
