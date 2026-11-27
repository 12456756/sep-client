import { z } from 'zod'
import type { ApiDiagnostic } from '../../../src/shared/api-diagnostic'

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const evidenceSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
  source: z.enum(['platform', 'sep', 'request', 'client', 'authorization', 'adapter', 'pricing']),
  submissionState: z.literal('not_submitted'),
  billingState: z.enum(['not_reserved', 'reserved', 'settled', 'released', 'reconciling', 'unknown']).optional(),
})
export interface MediaSubmissionEvidence {
  submissionState?: 'not_submitted'
  billingState?: z.infer<typeof evidenceSchema>['billingState']
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function mediaErrorHasSubmissionState(diagnostic: ApiDiagnostic | undefined): boolean {
  const body = record(diagnostic?.body)
  return !!body && ('submissionState' in body || 'submissionState' in (record(body.error) ?? {}))
}

/** Only a complete, correlated SEP error can prove non-submission; HTTP status alone cannot. */
export function mediaSubmissionEvidence(diagnostic: ApiDiagnostic): MediaSubmissionEvidence {
  if (diagnostic.source && !['platform', 'sep', 'request', 'client', 'authorization', 'adapter', 'pricing'].includes(diagnostic.source) || diagnostic.truncated || diagnostic.readError ||
    diagnostic.contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') return {}
  const body = record(diagnostic.body)
  if (!body) return {}
  const error = record(body.error) ?? body
  const parsed = evidenceSchema.safeParse(error)
  if (!parsed.success) return {}
  if (error !== body && ['submissionState', 'billingState'].some(key => body[key] !== undefined && body[key] !== error[key])) return {}
  const ids = [diagnostic.sepRequestId, body.sepRequestId, body.requestId, error.requestId].filter(value => value !== undefined)
  if (!ids.length || ids.some(value => !identity.safeParse(value).success || value !== ids[0])) return {}
  return { submissionState: 'not_submitted', ...(parsed.data.billingState ? { billingState: parsed.data.billingState } : {}) }
}
