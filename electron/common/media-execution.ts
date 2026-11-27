import { mediaExecutionSnapshot, type MediaExecutionFields } from '../../src/shared/media-execution'
import { safeMediaUpstreamError } from './media-upstream-error'

export function safeMediaExecutionFields(value: MediaExecutionFields, secrets: readonly string[] = []): MediaExecutionFields {
  const fields = mediaExecutionSnapshot(value)
  if (fields.execution) {
    const execution = fields.execution
    for (const key of ['taskError', 'submissionRetry', 'submissionError', 'submissionRecordError'] as const) {
      if (execution[key] !== undefined) execution[key] = safeMediaUpstreamError({ status: 0, body: execution[key] }, secrets)?.body
    }
    if (execution.billing.error !== undefined) execution.billing.error = safeMediaUpstreamError({ status: 0, body: execution.billing.error }, secrets)?.body
    if (execution.operationError) execution.operationError = safeMediaUpstreamError(execution.operationError, secrets)
  }
  if (fields.billingError) fields.billingError = safeMediaUpstreamError(fields.billingError, secrets)
  return fields
}
