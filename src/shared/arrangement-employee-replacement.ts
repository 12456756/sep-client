import { z } from 'zod'

const candidateSchema = z.object({
  stepId: z.string().min(1), employeeId: z.string().min(1), subscriptionId: z.string().nullable(),
  source: z.enum(['enterprise', 'platform']), name: z.string().min(1), rationale: z.string(),
  canExecute: z.literal(false), canApply: z.literal(true),
}).strict()

const accessRequestSchema = z.object({
  requestId: z.string().min(1), stepId: z.string().min(1), employeeId: z.string().min(1),
  subscriptionId: z.string().nullable(), source: z.enum(['enterprise', 'platform']), name: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']), requestedCapabilities: z.array(z.string()),
  createdAt: z.string(), updatedAt: z.string(), message: z.string().optional(),
}).strict()

export const arrangementEmployeeReplacementSchema = z.object({
  nodeId: z.string().min(1), originalSubscriptionId: z.string().min(1), replacementSubscriptionId: z.string().min(1).optional(),
  reason: z.string().min(1), status: z.enum(['searching', 'waiting', 'replaced']), updatedAt: z.number().finite(),
  candidates: z.array(candidateSchema).optional(), accessRequests: z.array(accessRequestSchema).optional(),
  previousSubscriptionIds: z.array(z.string().min(1)).optional(),
}).strict()

export type ArrangementEmployeeReplacement = z.infer<typeof arrangementEmployeeReplacementSchema>
