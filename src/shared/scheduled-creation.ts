import { z } from 'zod'
import { isValidCron } from './cron-schedule'
import { scheduleInputSchema } from './scheduled-tasks'
import { scheduledInstant } from './zoned-time'

const timezoneSchema = scheduleInputSchema.shape.timezone.refine(value => !/^[+-]/.test(value), 'Use an IANA timezone, not a numeric offset.')
const subscriptionIdSchema = scheduleInputSchema.shape.subscriptionId
const textSchema = z.string().trim().min(1).max(16000)
const timestampSchema = z.number().int().nonnegative().max(8640000000000000)
const messageSchema = z.object({ role: z.literal('user'), content: textSchema, receivedAt: timestampSchema.optional() }).strict()
const submissionKeySchema = z.string().trim().min(1).max(256)

export const scheduleInterpretationSchema = z.object({
  status: z.enum(['ready', 'needs_input', 'blocked']),
  task: z.object({
    title: z.string().trim().min(1).max(160).nullable(),
    goal: textSchema.nullable(),
    deliverables: z.array(z.string().trim().min(1).max(2000)).max(32),
    execution: z.object({ mode: z.enum(['employee', 'auto']), subscriptionId: subscriptionIdSchema.nullable() }).strict(),
    schedule: z.object({
      kind: z.enum(['once', 'cron']).nullable(), timezone: timezoneSchema,
      localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable(),
      expression: z.string().trim().min(1).max(200).refine(isValidCron, 'Invalid five-field Cron expression.').nullable(),
      description: z.string().trim().min(1).max(2000).nullable(),
    }).strict(),
  }).strict(),
  questions: z.array(z.object({ field: z.enum(['goal', 'deliverables', 'execution', 'schedule']), question: z.string().trim().min(1).max(2000) }).strict()).max(20),
  reasons: z.array(z.object({
    code: z.enum(['UNSUPPORTED_SCHEDULE', 'EMPLOYEE_UNAVAILABLE', 'CAPABILITY_MISMATCH', 'UNSUPPORTED_SETTING', 'AMBIGUOUS_SCHEDULE', 'PAST_SCHEDULE', 'INVALID_SCHEDULE', 'MISSING_INFORMATION', 'MODEL_NOT_ALLOWED']),
    message: z.string().trim().min(1).max(2000),
  }).strict()).max(20),
}).strict().superRefine((value, context) => {
  const issue = (path: Array<string | number>, message: string) => context.addIssue({ code: 'custom', path, message })
  if (value.status === 'needs_input' && !value.questions.length) issue(['questions'], 'Ask at least one actionable clarification question.')
  if (value.status === 'needs_input' && value.reasons.length) issue(['reasons'], 'Clarifications require empty reasons.')
  if (value.status === 'blocked' && !value.reasons.length) issue(['reasons'], 'Give at least one blocking reason.')
  if (value.status === 'blocked' && value.questions.length) issue(['questions'], 'Blocked interpretations require empty questions.')
  if (value.status !== 'ready') return
  if (value.questions.length || value.reasons.length) issue(['status'], 'Ready interpretations cannot contain questions or blocking reasons.')
  const { task } = value
  if (!task.title) issue(['task', 'title'], 'A title is required.')
  if (!task.goal) issue(['task', 'goal'], 'A goal is required.')
  if (!task.deliverables.length) issue(['task', 'deliverables'], 'At least one deliverable is required.')
  const combinedGoal = task.goal && task.deliverables.length
    ? `${task.goal}\n\nDeliverables:\n${task.deliverables.map(value => `- ${value}`).join('\n')}`
    : null
  if (combinedGoal && combinedGoal.length > 16000) issue(['task', 'goal'], 'The goal and deliverable requirements together must fit 16000 characters.')
  if (task.execution.mode === 'employee' && !task.execution.subscriptionId) issue(['task', 'execution', 'subscriptionId'], 'Choose an employee explicitly.')
  if (task.execution.mode === 'auto' && task.execution.subscriptionId !== null) issue(['task', 'execution', 'subscriptionId'], 'Automatic arrangement cannot select a single employee.')
  const schedule = task.schedule
  if (schedule.kind === 'once') {
    if (!schedule.localDateTime || schedule.expression !== null) issue(['task', 'schedule'], 'Once requires localDateTime and a null expression.')
    else {
      try { scheduledInstant(schedule.localDateTime, schedule.timezone) }
      catch { issue(['task', 'schedule', 'localDateTime'], 'Choose a valid, unambiguous local date and time.') }
    }
  } else if (schedule.kind === 'cron') {
    if (!schedule.expression || schedule.localDateTime !== null) issue(['task', 'schedule'], 'Cron requires expression and a null localDateTime.')
  } else issue(['task', 'schedule', 'kind'], 'Choose once or cron.')
})
export type ScheduleInterpretation = z.infer<typeof scheduleInterpretationSchema>

const creationRequestFields = {
  message: textSchema, modelId: scheduleInputSchema.shape.modelId, workDir: scheduleInputSchema.shape.workDir,
  timezone: timezoneSchema, permissions: scheduleInputSchema.shape.permissions,
}
export const scheduledCreationRequestSchema = z.object({
  requestId: z.string().uuid(), expectedRevision: z.number().int().positive().optional(), ...creationRequestFields,
}).strict()
export type ScheduledCreationRequest = z.infer<typeof scheduledCreationRequestSchema>

export const scheduledCreationSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(),
  stage: z.enum(['parsing', 'needs_input', 'blocked', 'planning', 'enabling', 'completed', 'failed', 'cancelled']),
  request: z.object(creationRequestFields).strict(), submissionKey: submissionKeySchema,
  parsedSubmissionKey: submissionKeySchema.nullable(), definitionSubmissionKey: submissionKeySchema.nullable(),
  referenceNow: timestampSchema, messages: z.array(messageSchema).min(1).max(20),
  interpretation: scheduleInterpretationSchema.nullable(), definitionId: z.string().trim().min(1).max(128).nullable(),
  definitionInput: scheduleInputSchema.nullable(), error: z.string().trim().min(1).max(4000).nullable(),
  createdAt: timestampSchema, updatedAt: timestampSchema,
}).strict()
export type ScheduledCreation = z.infer<typeof scheduledCreationSchema>

export interface ScheduledCreationInterpreterInput {
  subscriptionId: string
  modelId: string
  referenceNow: number
  timezone: string
  employeeCatalog: Array<{
    subscriptionId: string; name: string; position: string; description: string; functionalCategory: string; allowedModels: string[]
  }>
  currentDraft: ScheduleInterpretation | null
  messages: Array<{ role: 'user'; content: string; receivedAt?: number }>
}
