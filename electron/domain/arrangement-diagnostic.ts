import { z } from 'zod'
import { RUNTIME_FAILURE_MESSAGES } from '../../src/shared/runtime-feedback'
import { apiDiagnosticSchema } from '../../src/shared/api-diagnostic'
import { mediaFailureSchema } from '../../src/shared/media-failure'
import { videoSpecFailureSchema } from '../../src/shared/video-media'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const token = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const arrangementDiagnosticRequest = z.object({ taskId: id, nodeId: id, nodeRunId: id }).strict()
const conversationDiagnosticRequest = z.object({ taskId: id, runId: id }).strict()
export const workDiagnosticRequest = z.union([arrangementDiagnosticRequest, conversationDiagnosticRequest])
export type WorkDiagnosticRequest = z.infer<typeof workDiagnosticRequest>

export const diagnosticEvidence = z.object({
  code: token.optional(), httpStatus: z.number().int().min(100).max(599).optional(), requestId: token.optional(),
}).strict()
export type DiagnosticEvidence = z.infer<typeof diagnosticEvidence>

const text = z.string().max(8192)
const time = z.number().int().nonnegative()
export const diagnosticException = z.object({
  parent: time.optional(), relation: z.enum(['cause', 'aggregate']).optional(), name: text.optional(),
  message: text.optional(), stack: text.optional(), code: text.optional(), status: z.number().finite().optional(),
  errno: z.union([text, z.number().finite()]).optional(), syscall: text.optional(), path: text.optional(),
  dest: text.optional(), address: text.optional(), port: z.number().finite().optional(),
  operation: text.optional(), timeoutMs: time.optional(), diagnostic: apiDiagnosticSchema.optional(),
  specFailure: z.object({
    code: text, field: text.optional(), source: text.optional(), reasonCode: text.optional(),
    requestedValue: z.union([text, z.number().finite(), z.boolean()]).optional(),
    submissionState: text.optional(), billingState: text.optional(), retryable: z.boolean().optional(),
  }).strict().optional(),
}).strict()
export type DiagnosticException = z.infer<typeof diagnosticException>
export const diagnosticExceptionChain = z.object({ entries: z.array(diagnosticException).max(16), truncated: z.boolean() }).strict()
export type DiagnosticExceptionChain = z.infer<typeof diagnosticExceptionChain>
export const MAX_MEDIA_DIAGNOSTIC_ERRORS = 8
export const mediaDiagnosticErrors = z.object({
  total: time,
  entries: z.array(z.object({ stage: mediaFailureSchema.shape.stage, timestamp: time,
    exception: diagnosticExceptionChain }).strict()).max(MAX_MEDIA_DIAGNOSTIC_ERRORS),
}).strict()
export type MediaDiagnosticErrors = z.infer<typeof mediaDiagnosticErrors>

const diagnosticModelStatus = z.object({
  requestNumber: time, timestamp: time.optional(), evidence: diagnosticEvidence.optional(),
  metrics: z.record(z.string(), z.union([text, z.number().finite()])),
  diagnostic: apiDiagnosticSchema.optional(), relatedDiagnostic: apiDiagnosticSchema.optional(),
  causes: z.array(z.object({ name: text.optional(), message: text.optional(), code: text.optional() }).strict()).max(16).optional(),
}).strict()
export type DiagnosticModelStatus = z.infer<typeof diagnosticModelStatus>

export const MAX_DIAGNOSTIC_JOBS = 16
export const MAX_DIAGNOSTIC_MODEL_STATUSES = 32
export const MAX_DIAGNOSTIC_TOOL_FAILURES = 16
const toolFailureHistory = z.object({ entries: z.array(z.object({
  name: text, callId: text.optional(), timestamp: time, elapsedMs: time.optional(),
  reason: text.optional(), message: text.optional(),
}).strict()).max(MAX_DIAGNOSTIC_TOOL_FAILURES), total: time }).strict()
export type DiagnosticToolFailureHistory = z.infer<typeof toolFailureHistory>
const mediaJob = z.object({
  jobId: id, runId: id.optional(), association: z.enum(['run', 'recovery']).optional(),
  submission: z.enum(['NOT_SUBMITTED', 'SUBMISSION_UNKNOWN', 'SUBMITTED', 'REJECTED']),
  localSubmission: z.enum(['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED']).optional(),
  clientRequestId: text.optional(), receiptId: text.nullable().optional(), status: token.optional(),
  saveStatus: token, trackingStatus: token.optional(), billingStatus: text.optional(), executionMode: token.optional(),
  errorCode: text.nullable().optional(), error: text.nullable().optional(), failureStage: token.optional(), failure: diagnosticEvidence.optional(),
  failureDetail: mediaFailureSchema.optional(), submissionFailure: mediaFailureSchema.optional(),
  diagnosticErrors: mediaDiagnosticErrors.optional(),
  upstreamError: apiDiagnosticSchema.optional(), specFailure: videoSpecFailureSchema.optional(),
  outputErrors: z.array(z.object({ index: time, code: text }).strict()).max(64).optional(),
  outputErrorCount: time.optional(), outputCount: time.optional(), createdAt: time.optional(), updatedAt: time.optional(),
  lastQueriedAt: time.optional(), providerWaitMs: time.optional(), downloadMs: time.optional(), nextPollAt: time.optional(), attempts: time.optional(),
}).strict()
export type DiagnosticMediaJob = z.infer<typeof mediaJob>
const mediaEvidence = z.object({
  evidence: z.enum(['not-applicable', 'unavailable', 'no-local-job', 'local-jobs']),
  jobs: z.array(mediaJob).max(MAX_DIAGNOSTIC_JOBS), jobCount: time.optional(),
  observedAt: time.optional(), source: z.enum(['failure-time', 'export-time']).optional(),
  lookupError: diagnosticExceptionChain.optional(),
}).strict()
export type DiagnosticMediaEvidence = z.infer<typeof mediaEvidence>

const diagnosticPhase = z.enum(['node-setup', 'conversation-setup', 'input-read', 'run-persistence', 'media-setup', 'model-execution',
  'session-persistence', 'media-wait', 'submission', 'materialization', 'files', 'decision'])
export type DiagnosticPhase = z.infer<typeof diagnosticPhase>

const fields = {
  version: z.literal(1), clientVersion: token, failedAt: z.number().int().nonnegative(),
  phase: diagnosticPhase, category: z.enum(Object.keys(RUNTIME_FAILURE_MESSAGES) as [keyof typeof RUNTIME_FAILURE_MESSAGES, ...(keyof typeof RUNTIME_FAILURE_MESSAGES)[]]),
  reason: token, summary: z.string().max(200), evidence: diagnosticEvidence.optional(), modelRequest: diagnosticEvidence.optional(),
  exception: diagnosticExceptionChain.optional(),
  modelHistory: z.object({ entries: z.array(diagnosticModelStatus).max(MAX_DIAGNOSTIC_MODEL_STATUSES), total: time }).strict().optional(),
  toolFailures: toolFailureHistory.optional(),
  mediaToolFailures: z.object({ entries: z.array(z.object({ tool: token, timestamp: time,
    exception: diagnosticExceptionChain }).strict()).max(MAX_DIAGNOSTIC_TOOL_FAILURES), total: time }).strict().optional(),
  image: mediaEvidence.optional(), video: mediaEvidence,
}
const arrangementDiagnosticSchema = arrangementDiagnosticRequest.extend({ ...fields, attempt: z.number().int().nonnegative() })
const conversationDiagnosticSchema = conversationDiagnosticRequest.extend(fields)
export const workDiagnosticSchema = z.union([arrangementDiagnosticSchema, conversationDiagnosticSchema])
export type WorkDiagnostic = z.infer<typeof workDiagnosticSchema>
export type WorkDiagnosticCapture = Omit<z.infer<typeof arrangementDiagnosticSchema>, 'version' | 'clientVersion' | 'image' | 'video'>
  | Omit<z.infer<typeof conversationDiagnosticSchema>, 'version' | 'clientVersion' | 'image' | 'video'>
