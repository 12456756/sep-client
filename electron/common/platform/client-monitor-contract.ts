import { z } from 'zod'

export const monitorStatusSchema = z.enum(['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'INTERRUPTED', 'COMPLETED', 'FAILED', 'CANCELLED'])
const clientRunId = z.string().min(1).max(160).optional()
const text = z.string().max(1000).nullable().optional()
const progress = z.number().int().min(0).max(100).optional()
const timestamp = z.string().datetime().nullable().optional()
export const createClientTaskSchema = z.object({
  clientTaskId: z.string().min(1).max(160), clientRunId: z.string().min(1).max(160),
  subscriptionId: z.string().min(1), title: z.string().min(1).max(200),
  taskType: z.string().optional(), modelId: z.string().optional(), clientVersion: z.string().optional(),
  protocolVersion: z.literal(2).optional(), queuedAt: z.string().datetime().optional(),
}).strict()
export const monitorParticipationSchema = z.object({
  executionId: z.string().min(1).max(160), subscriptionId: z.string().min(1),
  nodeId: z.string().min(1).max(160).optional(), title: z.string().min(1).max(200).optional(),
  modelId: z.string().min(1).optional(), status: monitorStatusSchema.optional(),
  startedAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(),
}).strict()
export const clientTaskStatusSchema = z.object({
  clientRunId, status: monitorStatusSchema, progress, currentStep: text, activity: text, errorSummary: text,
  startedAt: timestamp, completedAt: timestamp,
}).strict()
export const clientTaskHeartbeatSchema = z.object({ clientRunId, progress, currentStep: text, activity: text, clientVersion: z.string() }).strict()
export const monitorStateSchema = z.object({
  version: z.literal(1), reportedStatus: monitorStatusSchema,
  source: z.enum(['live', 'local-run', 'snapshot']), observedAt: z.string().datetime(),
  runEndedAt: z.string().datetime().optional(), progress,
}).strict()
export const monitorMessageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const sequences = z.array(z.number().int().positive().max(2147483647)).min(1).max(64)
  .refine(values => new Set(values).size === values.length, 'Sequence references must be unique.').optional()
export const contentManifestSchema = z.object({
  version: z.literal(1), messageId: monitorMessageIdSchema, type: z.enum(['user_input', 'model_output']),
  chunks: z.number().int().positive().max(2147483647), source: z.enum(['canonical', 'timeline', 'snapshot']),
  completeness: z.enum(['complete', 'partial', 'unverified']), legacySequences: sequences,
  replacesMessageId: monitorMessageIdSchema.optional(), replacesSequences: sequences,
}).strict()
export const contentRecoverySchema = z.object({
  version: z.literal(1), reason: z.enum(['not-generated', 'source-missing', 'ambiguous']),
  checkedAt: z.string().datetime(), source: z.literal('local-history'),
}).strict()
export const monitorMetadataSchemas = {
  monitor_state: monitorStateSchema, content_manifest: contentManifestSchema, content_recovery: contentRecoverySchema,
} as const
export type MonitorState = z.infer<typeof monitorStateSchema>
export type ContentManifest = z.infer<typeof contentManifestSchema>
export type ContentRecovery = z.infer<typeof contentRecoverySchema>

export const clientTaskEventSchema = z.object({
  clientRunId, sequence: z.number().int().positive().max(2147483647), type: z.string().min(1).max(64),
  stepKey: text, message: text, progress, occurredAt: z.string().datetime(),
  participation: monitorParticipationSchema.optional(),
}).strict().superRefine((event, context) => {
  if (!Object.prototype.hasOwnProperty.call(monitorMetadataSchemas, event.type)) return
  const schema = monitorMetadataSchemas[event.type as keyof typeof monitorMetadataSchemas]
  if (!schema) return
  let value: unknown
  try { value = JSON.parse(event.message ?? '') } catch { /* rejected below */ }
  if (!event.clientRunId || !schema.safeParse(value).success) {
    context.addIssue({ code: 'custom', message: 'Invalid monitor metadata or missing clientRunId.' })
  }
})
export type MonitorParticipation = z.infer<typeof monitorParticipationSchema>
export type MonitorStatus = z.infer<typeof monitorStatusSchema>
export type CreateClientTaskRequest = z.infer<typeof createClientTaskSchema>
export type ClientTaskStatusRequest = z.infer<typeof clientTaskStatusSchema>
export type ClientTaskHeartbeatRequest = z.infer<typeof clientTaskHeartbeatSchema>
export type ClientTaskEventRequest = z.infer<typeof clientTaskEventSchema>

export function isMonitorTerminal(status: MonitorStatus | undefined): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'
}
export function normalizeMonitorStatus(payload: ClientTaskStatusRequest): ClientTaskStatusRequest {
  return isMonitorTerminal(payload.status) || !payload.completedAt ? payload : { ...payload, completedAt: null }
}
export function normalizeMonitorParticipation(value: MonitorParticipation): MonitorParticipation {
  if (isMonitorTerminal(value.status) || value.completedAt === undefined) return value
  const { completedAt: _endedAt, ...normalized } = value
  return normalized
}
