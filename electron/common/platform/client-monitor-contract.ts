import { z } from 'zod'

export const monitorStatusSchema = z.enum(['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'])
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
export const clientTaskEventSchema = z.object({
  clientRunId, sequence: z.number().int().positive().safe(), type: z.string().min(1).max(64),
  stepKey: text, message: text, progress, occurredAt: z.string().datetime(),
  participation: monitorParticipationSchema.optional(),
}).strict()
export type MonitorParticipation = z.infer<typeof monitorParticipationSchema>
export type MonitorStatus = z.infer<typeof monitorStatusSchema>
export type CreateClientTaskRequest = z.infer<typeof createClientTaskSchema>
export type ClientTaskStatusRequest = z.infer<typeof clientTaskStatusSchema>
export type ClientTaskHeartbeatRequest = z.infer<typeof clientTaskHeartbeatSchema>
export type ClientTaskEventRequest = z.infer<typeof clientTaskEventSchema>
