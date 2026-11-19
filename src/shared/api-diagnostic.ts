import { z } from 'zod'

const text = z.string().max(8192)
export const apiDiagnosticSchema = z.object({
  operation: text.optional(),
  httpStatus: z.number().int().min(0).max(599).optional(),
  contentType: text.optional(),
  source: text.optional(),
  code: z.union([text, z.number().finite()]).optional(),
  message: text.optional(),
  field: text.optional(),
  stage: text.optional(),
  retryable: z.boolean().optional(),
  recovery: z.json().optional(),
  body: z.json().optional(),
  sepRequestId: text.optional(),
  computeRequestId: text.optional(),
  clientRequestId: text.optional(),
  upstreamRequestId: text.optional(),
  executionId: text.optional(),
  computeStatus: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), text).optional(),
  readError: text.optional(),
  transportError: z.json().optional(),
  truncated: z.boolean().optional(),
})

/** Sanitized transport evidence, separate from local classification and popup copy. */
export type ApiDiagnostic = z.infer<typeof apiDiagnosticSchema>
