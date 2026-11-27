import { mediaFailureSchema, type MediaFailure } from '../../src/shared/media-failure'
import { AppError } from './app-error'
import { transportKind } from '../common/transport-error'
import { safeMediaUpstreamMessage } from '../common/media-upstream-error'
import { safeApiDiagnostic } from '../common/platform/api-diagnostic'

export function mediaJobFailure(error: unknown, stage: MediaFailure['stage']): MediaFailure {
  const details = error instanceof AppError ? error.details ?? {} : {}
  const transport = transportKind(error)
  const code = transport === 'timeout' ? 'NETWORK_TIMEOUT' : transport === 'network' ? 'NETWORK_ERROR'
    : error instanceof AppError ? error.code : 'INTERNAL_ERROR'
  const result: MediaFailure = { code, stage }
  const diagnostic = safeApiDiagnostic(error instanceof AppError ? error.diagnostic : undefined)
  if (diagnostic) result.diagnostic = diagnostic
  // Validate each optional field independently so malformed metadata cannot erase the reason.
  const values = { businessCode: details.businessCode, gatewayCode: details.gatewayCode,
    requestId: details.requestId, httpStatus: details.statusCode, source: details.source,
    submissionState: details.submissionConfirmedNotSent === true ? 'not_submitted' : undefined,
    billingState: details.submissionConfirmedNotSent === true ? details.billingState : undefined,
    reasonCode: details.reasonCode ?? (error instanceof Error && !(error instanceof AppError) && 'code' in error ? error.code : undefined) }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    const parsed = mediaFailureSchema.safeParse({ ...result, [key]: value })
    if (parsed.success) Object.assign(result, parsed.data)
  }
  const diagnosticStage = mediaFailureSchema.shape.stage.safeParse(details.stage)
  if (diagnosticStage.success) result.stage = diagnosticStage.data
  if (result.source === 'upstream' && typeof details.upstreamMessage === 'string') {
    const message = safeMediaUpstreamMessage(details.upstreamMessage)
    if (message) result.message = message.slice(0, 1000)
  }
  return result
}
