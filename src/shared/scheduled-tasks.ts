import { z } from 'zod'
import type { ArrangementDeliverable } from './types'
import type { ScheduledCreation } from './scheduled-creation'
import { isValidCron, latestCronTime } from './cron-schedule'

export const recurrenceSchema = z.union([
  z.object({ frequency: z.enum(['once', 'daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(365) }).strict(),
  z.object({ frequency: z.literal('cron'), interval: z.literal(1), expression: z.string().trim().min(1).max(200).refine(isValidCron, '时间规则无效'),
    preset: z.enum(['hourly', 'daily', 'weekly', 'custom']), description: z.string().trim().min(1).max(2000).optional() }).strict(),
])
export type RecurrenceRule = z.infer<typeof recurrenceSchema>
export const scheduleTimeRequestSchema = z.object({ requestId: z.string().uuid(), description: z.string().trim().min(1).max(2000),
  subscriptionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), modelId: z.string().trim().min(1).max(160),
  timezone: z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }),
}).strict()
export const scheduleTimeResultSchema = z.union([
  z.object({ status: z.literal('ready'), expression: z.string().trim().min(1).max(200).refine(isValidCron) }).strict(),
  z.object({ status: z.literal('blocked'), reasons: z.array(z.string().trim().min(1).max(1000)).min(1).max(10) }).strict(),
])
export type ScheduleTimeRequest = z.infer<typeof scheduleTimeRequestSchema>
export type ScheduleTimeResult = z.infer<typeof scheduleTimeResultSchema>

export const scheduleInputSchema = z.object({
  mode: z.enum(['employee', 'auto']).optional(),
  name: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(16000),
  subscriptionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  modelId: z.string().trim().min(1).max(160),
  workDir: z.string().trim().min(1).max(1024).refine(value => /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(value), '请选择绝对工作目录'),
  scheduledAt: z.number().int().positive().max(8640000000000000),
  recurrence: recurrenceSchema.optional(),
  timezone: z.string().min(1).max(128).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
  }),
  permissions: z.object({ preset: z.enum(['workspace-edit', 'full-local']), approvalMode: z.enum(['confirm-each', 'auto-approve']) }).strict(),
}).strict().superRefine((input, context) => {
  if (input.recurrence?.frequency !== 'cron') return
  try {
    if (latestCronTime(input.recurrence.expression, input.timezone, input.scheduledAt) === input.scheduledAt) return
  } catch { /* Invalid timezone or cron is also rejected by the field schemas. */ }
  context.addIssue({ code: 'custom', path: ['scheduledAt'], message: '首次运行时间与重复规则不一致' })
})
export type ScheduleInput = z.infer<typeof scheduleInputSchema>
const sourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/)
export const scheduledWorkSourceSchema = z.object({ taskId: sourceId, templateId: sourceId, planHash: sourceHash, requestKey: sourceHash }).strict()
export type ScheduledWorkSourceRef = z.infer<typeof scheduledWorkSourceSchema>
export const workScheduleTimingSchema = z.object({ name: z.string().trim().min(1).max(160), scheduledAt: z.number().int().positive().max(8640000000000000),
  timezone: scheduleTimeRequestSchema.shape.timezone, recurrence: recurrenceSchema }).strict()
export const createWorkScheduleSchema = workScheduleTimingSchema.extend({ requestId: z.string().uuid(), taskId: sourceId, expectedPlanHash: sourceHash })
export const editWorkScheduleSchema = workScheduleTimingSchema.extend({ id: sourceId, expectedRevision: z.number().int().positive() })
export const workScheduleContextSchema = z.object({ taskId: sourceId, planHash: sourceHash, title: z.string().min(1).max(160), subscriptionId: sourceId, modelId: z.string().min(1).max(160) }).strict()
export type CreateWorkSchedule = z.infer<typeof createWorkScheduleSchema>
export type EditWorkSchedule = z.infer<typeof editWorkScheduleSchema>
export type WorkScheduleContext = z.infer<typeof workScheduleContextSchema>
export interface EmployeeWorkPlan {
  status: 'ready'
  kind?: 'employee'
  objective: string
  instruction: string
  expectedOutput: string
  deliverables: ArrangementDeliverable[]
}
export interface ArrangementWorkPlan {
  status: 'ready'
  kind: 'arrangement'
  title: string
  source?: ScheduledWorkSourceRef
  nodes: Array<{
    id: string; subscriptionId: string; modelId: string; title: string; objective?: string; instruction: string
    expectedOutput: string; deliverables: ArrangementDeliverable[]; dependsOn: string[]; skillIds: string[]
    requiresUserConfirmation: boolean; stepId?: string
  }>
  intentAnalysis: { summary: string; steps: Array<{ id: string; title: string; requiredCapabilities: string[]; requiredCapabilityIds?: string[]; dependsOn: string[] }> } | null
}
export type ScheduledWorkPlan = EmployeeWorkPlan | ArrangementWorkPlan
export type EmployeePlanResult = EmployeeWorkPlan | { status: 'blocked'; reasons: string[] }
export type ScheduledRunStatus = 'pending' | 'preparing' | 'launching' | 'running' | 'waiting_approval' | 'waiting_retry' | 'waiting_auth' | 'blocked' | 'review' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'missed'
export interface ScheduledIssue { code: string; message: string; action: 'retry' | 'auth' | 'blocked' | 'review'; retryAfterMs?: number }
export interface ScheduledDefinition {
  id: string; revision: number; input: ScheduleInput; plan: ScheduledWorkPlan | null
  planInputKey: string | null; enabled: boolean; deleted: boolean; nextRunAt: number | null; pausedAt?: number | null
  createdAt: number; updatedAt: number
}
export interface ScheduledAttempt {
  id: string; number: number; startedAt: number; finishedAt: number | null
  status: 'preparing' | 'admitted' | 'failed' | 'completed' | 'interrupted'; error: ScheduledIssue | null
}
export interface ScheduledOccurrence {
  id: string; definitionId: string; revision: number; scheduledAt: number; taskId: string
  input: ScheduleInput; plan: ScheduledWorkPlan; status: ScheduledRunStatus
  firstEligibleAt: number; startDeadline: number; startedAt: number | null; finishedAt: number | null
  nextRetryAt: number | null; error: ScheduledIssue | null; attempts: ScheduledAttempt[]
  stopReason: 'cancelled' | 'timed_out' | null
}
export interface ScheduledSnapshot { definitions: ScheduledDefinition[]; occurrences: ScheduledOccurrence[]; creations?: ScheduledCreation[]; schedulerState?: 'running' | 'stopped' | 'error' }
export interface ScheduledOrigin { definitionId: string; occurrenceId: string }
export type ScheduleMutation = { id: string; expectedRevision: number }
