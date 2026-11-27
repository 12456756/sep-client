import { z } from 'zod'
import { isValidCron } from './cron-schedule'
import { employeeScheduleInputSchema, recurrenceSchema, scheduleTimeRequestSchema, workScheduleTimingSchema } from './scheduled-tasks'
import { scheduledTaskGroups } from './scheduled-task-state'

export const UPDATE_SCHEDULED_TASK_TOOL = 'update_scheduled_task'
export const DELETE_SCHEDULED_TASK_TOOL = 'delete_scheduled_task'
export const SCHEDULE_QUERY_TOOL = 'query_scheduled_tasks'
export const SCHEDULE_TIME_TOOL = 'interpret_schedule_time'
export const SCHEDULE_SOURCE_TOOL = 'get_schedule_work_source'

const title = z.string().trim().min(1).max(160)
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const revision = z.number().int().positive()
const target = z.union([
  z.object({ id }).strict(),
  z.object({ title }).strict(),
  z.object({ fromConversation: z.literal(true) }).strict(),
])
const time = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(200).refine(isValidCron) }).strict(),
])
const goal = employeeScheduleInputSchema.shape.goal
const executor = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('general'), modelId: employeeScheduleInputSchema.shape.modelId }).strict(),
  z.object({ mode: z.literal('employee'), modelId: employeeScheduleInputSchema.shape.modelId, subscriptionId: id }).strict(),
  z.object({ mode: z.literal('auto'), modelId: employeeScheduleInputSchema.shape.modelId, subscriptionId: id }).strict(),
])
const configuration = z.object({ ...workScheduleTimingSchema.shape, goal, executor,
  outputDirectory: z.string().trim().min(1).max(1024).nullable().optional(),
}).strict()
const partialUpdateSchema = z.object({ target, title: title.optional(), time: time.optional(), goal: goal.optional(),
  timezone: z.string().min(1).max(128).optional(), inspect: z.literal(true).optional(), expectedRevision: z.number().int().positive().optional(),
}).strict().refine(value => value.inspect
  ? !value.title && !value.time && !value.goal && !value.timezone && value.expectedRevision === undefined
  : !!(value.title || value.time || value.goal) && (!value.timezone || !!value.time),
'Use inspect alone to read the current goal; otherwise provide a new title, time or goal. Timezone applies only to a time change.')
export const updateScheduledTaskToolSchema = z.union([partialUpdateSchema,
  z.object({ target, expectedRevision: revision, configuration }).strict(),
])
export const deleteScheduledTaskToolSchema = z.object({ target, expectedRevision: revision.optional() }).strict()
const page = { offset: z.number().int().min(0).max(100000).optional(), limit: z.number().int().min(1).max(25).optional() }
const query = z.discriminatedUnion('view', [
  z.object({ view: z.literal('tasks'), ...page, search: title.optional(), includeDeleted: z.boolean().optional(),
    group: z.enum(scheduledTaskGroups).optional()
      .describe('Match the sidebar group: disabled (未启用), enabled (已启用), or history (历史记录). Use group and read total for counts; do not count enabled=false. History includes deleted tasks unless includeDeleted=false; ungrouped queries exclude them by default.') }).strict(),
  z.object({ view: z.literal('task'), target, includeGoal: z.literal(true).optional() }).strict(),
  z.object({ view: z.literal('runs'), target, ...page }).strict(),
  z.object({ view: z.literal('run'), runId: id }).strict(),
  z.object({ view: z.literal('creations'), ...page }).strict(),
  z.object({ view: z.literal('creation'), creationId: z.string().uuid() }).strict(),
])
const run = z.object({ runId: id }).strict()
const creation = z.object({ creationId: z.string().uuid(), expectedRevision: revision.optional() }).strict()

export const scheduleManagementSchemas = {
  [SCHEDULE_QUERY_TOOL]: query,
  [SCHEDULE_TIME_TOOL]: scheduleTimeRequestSchema.omit({ requestId: true, subscriptionId: true, modelId: true }),
  [SCHEDULE_SOURCE_TOOL]: z.object({ taskId: id }).strict(),
  [UPDATE_SCHEDULED_TASK_TOOL]: updateScheduledTaskToolSchema,
  [DELETE_SCHEDULED_TASK_TOOL]: deleteScheduledTaskToolSchema,
  create_scheduled_task_definition: z.object({ configuration }).strict(),
  create_scheduled_task_from_work: workScheduleTimingSchema.extend({ taskId: id, expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  edit_scheduled_task_from_work: workScheduleTimingSchema.extend({ target, expectedRevision: revision }),
  plan_scheduled_task: deleteScheduledTaskToolSchema,
  enable_scheduled_task: deleteScheduledTaskToolSchema,
  pause_scheduled_task: deleteScheduledTaskToolSchema,
  cancel_scheduled_creation: creation,
  delete_scheduled_creation: creation,
  resume_scheduled_run: run,
  acknowledge_scheduled_run_review: run,
  cancel_scheduled_run: run,
  resume_scheduled_scheduler: z.strictObject({}),
} as const
export type ScheduleManagementToolName = keyof typeof scheduleManagementSchemas
export const SCHEDULE_MANAGEMENT_TOOLS = Object.keys(scheduleManagementSchemas) as ScheduleManagementToolName[]
export const SCHEDULE_READ_TOOLS: ReadonlySet<string> = new Set([SCHEDULE_QUERY_TOOL, SCHEDULE_TIME_TOOL, SCHEDULE_SOURCE_TOOL])

export const scheduleActionApprovalSchema = z.object({ label: z.string().trim().min(1).max(32), message: z.string().trim().min(1).max(24000) }).strict()
export type ScheduleActionApproval = z.infer<typeof scheduleActionApprovalSchema>

export const scheduleManagementApprovalSchema = z.object({
  title, id: z.string().min(1).max(128), enabled: z.boolean(),
  nextRunAt: z.number().int().positive().nullable(),
  timezone: z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }),
  newTitle: title.optional(),
  newGoal: goal.optional(),
  newTime: z.object({ firstRunAt: z.number().int().positive(), recurrence: recurrenceSchema }).strict().optional(),
}).strict()
export type ScheduleManagementApproval = z.infer<typeof scheduleManagementApprovalSchema>
export type ScheduleManagementRequest = { [K in ScheduleManagementToolName]: { tool: K; input: z.infer<(typeof scheduleManagementSchemas)[K]> } }[ScheduleManagementToolName]

export type ScheduleManagementReceipt =
  | { status: 'updated'; id: string; title: string; enabled: boolean; nextRunAt: number | null; timezone: string; recurrence?: z.infer<typeof recurrenceSchema>; contentUpdated?: true }
  | { status: 'current'; id: string; revision: number; title: string; goal: string }
  | { status: 'deleted'; id: string; title: string }
  | { status: 'ok'; data: unknown }
  | { status: 'applied' | 'unchanged'; action: ScheduleManagementToolName; data: unknown }
  | { status: 'needs_input'; message: string; matches?: Array<{ id: string; title: string; nextRunAt: number | null; timezone: string }> }
  | { status: 'cancelled' | 'failed'; message: string }

export type ConversationScheduleManagement = (request: ScheduleManagementRequest, signal?: AbortSignal) => Promise<ScheduleManagementReceipt>
