import { z } from 'zod'
import type { MediaGenerationStatus } from './media'
import { mediaUpstreamErrorSchema } from './media-upstream-error'

export const mediaExecutionSchema = z.object({
  requestId: z.string().min(1).max(256), taskId: z.string().min(1).max(256).nullable(),
  submissionStatus: z.enum(['not_submitted', 'submitting', 'rejected', 'accepted', 'failed', 'protocol_error', 'unobserved', 'not_applicable', 'unknown']),
  generationStatus: z.enum(['queued', 'in_progress', 'completed', 'failed', 'cancelled']).nullable(),
  isFinal: z.boolean().nullable(), observedAt: z.number().int().nonnegative().nullable(),
  statusSource: z.enum(['upstream', 'cached']).nullable(),
  billing: z.object({ status: z.enum(['pending', 'settled', 'not_charged', 'unknown', 'not_applicable']),
    actualCostCny: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable().optional(),
    actualCostUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable().optional(), error: z.json().optional() }).strict(),
  submissionRetry: z.json().optional(), taskError: z.json().optional(), operationError: mediaUpstreamErrorSchema.optional(),
  operation: z.enum(['create', 'query', 'cancel', 'download', 'pricing', 'usage']).optional(),
  submissionError: z.json().optional(), submissionRecordError: z.json().optional(),
  submissionHttpStatus: z.number().int().min(100).max(599).optional(), diagnosticTruncated: z.boolean().optional(),
}).strict()
export const mediaClientActionsSchema = z.object({
  submissionFinished: z.boolean(), generationFinished: z.boolean(), shouldPoll: z.boolean(),
  pollPurpose: z.enum(['submission', 'generation', 'delivery', 'billing', 'none']),
  canStartNewRequest: z.boolean(), canRetryDownload: z.boolean(),
}).strict()
export const mediaExecutionFields = {
  receiptVersion: z.literal(2).optional(), execution: mediaExecutionSchema.optional(),
  clientActions: mediaClientActionsSchema.optional(),
  fileStatus: z.enum(['pending', 'available', 'download_failed', 'expired', 'unavailable']).optional(),
  billingError: mediaUpstreamErrorSchema.optional(),
}
export type MediaExecutionFields = z.infer<z.ZodObject<typeof mediaExecutionFields>>

export function refineMediaExecution(receipt: MediaExecutionFields & { outputs?: readonly unknown[];
  recovery?: { canQuery: boolean; canDownload: boolean }; mock?: boolean }, context: z.RefinementCtx): void {
  if (receipt.receiptVersion !== 2) return
  const { execution, clientActions: actions } = receipt
  if (!execution || !actions || !receipt.fileStatus || receipt.mock === true) {
    context.addIssue({ code: 'custom', message: 'Execution receipt v2 is incomplete.' })
    return
  }
  const submissionFinished = !['submitting', 'unknown'].includes(execution.submissionStatus)
  const generationFinished = mediaSubmissionClosed(execution.submissionStatus) || execution.isFinal === true
  if (actions.submissionFinished !== submissionFinished || actions.generationFinished !== generationFinished ||
    actions.canStartNewRequest && !generationFinished || actions.shouldPoll !== (actions.pollPurpose !== 'none') ||
    actions.shouldPoll && receipt.recovery?.canQuery === false ||
    receipt.recovery?.canDownload && (receipt.fileStatus !== 'available' || !receipt.outputs?.length)) {
    context.addIssue({ code: 'custom', message: 'Execution receipt actions conflict with its evidence.' })
  }
}

/** The wire status also describes delivery; it must not overwrite known generation evidence. */
export function mediaGenerationState(status: MediaGenerationStatus, receipt: MediaExecutionFields): MediaGenerationStatus {
  if (receipt.receiptVersion !== 2 || !receipt.execution) return status
  const execution = receipt.execution
  if (mediaSubmissionClosed(execution.submissionStatus)) return 'FAILED'
  if (['unobserved', 'not_applicable'].includes(execution.submissionStatus)) return status
  switch (execution.generationStatus) {
    case 'completed': return 'SUCCEEDED'
    case 'failed': return 'FAILED'
    case 'cancelled': return 'CANCELLED'
    case 'in_progress': return 'RUNNING'
    case 'queued': return 'QUEUED'
    default: return execution.submissionStatus === 'accepted' ? 'QUEUED'
      : execution.submissionStatus === 'submitting' ? 'SUBMITTING' : 'SUBMISSION_UNKNOWN'
  }
}

export function mediaSubmissionClosed(status: string): boolean {
  return ['not_submitted', 'rejected', 'failed', 'protocol_error'].includes(status)
}

export function mediaReceiptNeedsPoll(receipt: MediaExecutionFields): boolean | undefined {
  return receipt.receiptVersion === 2 ? receipt.clientActions?.shouldPoll : undefined
}

/** Older persisted jobs may have a final generation state without clientActions. */
export function mediaGenerationFinished(job: MediaExecutionFields & { generationStatus: string }): boolean {
  return ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED', 'NOT_SUBMITTED'].includes(job.generationStatus)
    || job.clientActions?.generationFinished === true || job.execution?.isFinal === true
    || (job.execution !== undefined && mediaSubmissionClosed(job.execution.submissionStatus))
}

export function mediaExecutionSnapshot(receipt: MediaExecutionFields): MediaExecutionFields {
  return Object.fromEntries(Object.keys(mediaExecutionFields).flatMap(key => {
    const value = receipt[key as keyof MediaExecutionFields]
    return value === undefined ? [] : [[key, structuredClone(value)]]
  })) as MediaExecutionFields
}
