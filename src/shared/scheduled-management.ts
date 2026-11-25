import { z } from 'zod'
import { isValidCron } from './cron-schedule'
import { employeeScheduleInputSchema, recurrenceSchema } from './scheduled-tasks'

export const UPDATE_SCHEDULED_TASK_TOOL = 'update_scheduled_task'
export const DELETE_SCHEDULED_TASK_TOOL = 'delete_scheduled_task'
export const SCHEDULE_MANAGEMENT_TOOLS = [UPDATE_SCHEDULED_TASK_TOOL, DELETE_SCHEDULED_TASK_TOOL] as const
export type ScheduleManagementToolName = typeof SCHEDULE_MANAGEMENT_TOOLS[number]

const title = z.string().trim().min(1).max(160)
const target = z.union([
  z.object({ id: z.string().trim().min(1).max(128) }).strict(),
  z.object({ title }).strict(),
  z.object({ fromConversation: z.literal(true) }).strict(),
])
const time = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(200).refine(isValidCron) }).strict(),
])
const goal = employeeScheduleInputSchema.shape.goal
export const updateScheduledTaskToolSchema = z.object({ target, title: title.optional(), time: time.optional(), goal: goal.optional(),
  timezone: z.string().min(1).max(128).optional(), inspect: z.literal(true).optional(), expectedRevision: z.number().int().positive().optional(),
}).strict().refine(value => value.inspect
  ? !value.title && !value.time && !value.goal && !value.timezone && value.expectedRevision === undefined
  : !!(value.title || value.time || value.goal) && (!value.timezone || !!value.time),
'Use inspect alone to read the current goal; otherwise provide a new title, time or goal. Timezone applies only to a time change.')
export const deleteScheduledTaskToolSchema = z.object({ target }).strict()

export const scheduleManagementApprovalSchema = z.object({
  title, id: z.string().min(1).max(128), enabled: z.boolean(),
  nextRunAt: z.number().int().positive().nullable(),
  timezone: z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }),
  newTitle: title.optional(),
  newGoal: goal.optional(),
  newTime: z.object({ firstRunAt: z.number().int().positive(), recurrence: recurrenceSchema }).strict().optional(),
}).strict()
export type ScheduleManagementApproval = z.infer<typeof scheduleManagementApprovalSchema>
export type ScheduleManagementRequest =
  | { tool: typeof UPDATE_SCHEDULED_TASK_TOOL; input: z.infer<typeof updateScheduledTaskToolSchema> }
  | { tool: typeof DELETE_SCHEDULED_TASK_TOOL; input: z.infer<typeof deleteScheduledTaskToolSchema> }

export type ScheduleManagementReceipt =
  | { status: 'updated'; id: string; title: string; enabled: boolean; nextRunAt: number | null; timezone: string; recurrence?: z.infer<typeof recurrenceSchema>; contentUpdated?: true }
  | { status: 'current'; id: string; revision: number; title: string; goal: string }
  | { status: 'deleted'; id: string; title: string }
  | { status: 'needs_input'; message: string; matches?: Array<{ id: string; title: string; nextRunAt: number | null; timezone: string }> }
  | { status: 'cancelled' | 'failed'; message: string }

export type ConversationScheduleManagement = (request: ScheduleManagementRequest, signal?: AbortSignal) => Promise<ScheduleManagementReceipt>
