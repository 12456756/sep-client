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

// Legacy file-action configuration is kept so stored snapshots remain readable.
const emptyTextFilenameSchema = z.string().trim().max(160)
  .refine(value => /^[^<>:"/\\|?*]+\.txt$/i.test(value)
    && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    && !/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])\s*(?:\.|$)/i.test(value), '请输入有效的 .txt 文件名，不含目录')
export const scheduledGeneralUnavailable = '通用助手未获得所选模型的使用授权，请检查员工订阅及其允许使用的模型。'
export const emptyTextActionSchema = z.union([z.object({ naming: z.literal('fixed'), filename: emptyTextFilenameSchema }).strict(),
  z.object({ naming: z.enum(['scheduled', 'started']) }).strict()])
const scheduleIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const scheduleModel = z.string().trim().min(1).max(160)
export const scheduledActionSchema = z.object({
  kind: z.literal('dingtalk-message'),
  targetType: z.enum(['person', 'group']),
  targetId: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_+=:/.-]{0,255}$/),
  body: z.string().min(1).max(4000).refine(value => !!value.trim()
    && ![...value].some(character => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127 })
    && !value.includes('!['), '请输入不含内嵌图片的消息正文'),
}).strict()
const scheduledActionsSchema = z.array(scheduledActionSchema).min(1).max(50).refine(actions =>
  new Set(actions.map(action => JSON.stringify(action))).size === actions.length, '同一收件目标和正文不能重复配置')
export type ScheduledAction = z.infer<typeof scheduledActionSchema>
export const scheduledActionGrantSchema = z.object({ revision: z.number().int().positive(), connectionRevision: z.string().min(1).max(512) }).strict()
export type ScheduledActionGrant = z.infer<typeof scheduledActionGrantSchema>
export const scheduledActionResultSchema = z.object({
  index: z.number().int().min(0).max(49), status: z.enum(['submitting', 'succeeded', 'not-executed', 'unknown']),
  receipt: z.string().min(1).max(512).optional(),
}).strict()
export type ScheduledActionResult = z.infer<typeof scheduledActionResultSchema>
export const scheduledDingTalkActionLabels = {
  'aitable base search': '搜索 AI 表格',
  'aitable base list': '列出 AI 表格',
  'aitable base get': '读取 AI 表格',
  'aitable table get': '读取数据表',
  'aitable table list': '列出数据表',
  'aitable field get': '读取字段配置',
  'aitable field list': '列出字段',
  'aitable +field-get': '读取字段配置',
  'aitable record get': '读取指定记录',
  'aitable record list': '列出记录',
  'aitable record query': '查询记录',
  'aitable record stats': '统计记录',
  'aitable record group-stats': '按组统计记录',
  'aitable psql': '运行表格 SQL',
  'aitable record create': '新增记录',
  'aitable record update': '更新记录',
  'aitable record delete': '删除记录',
  'chat +dm': '发送单聊消息',
  'chat +send-to-group': '发送群消息',
} as const
type ScheduledDingTalkAction = keyof typeof scheduledDingTalkActionLabels
const scheduledDingTalkActionSchema = z.custom<ScheduledDingTalkAction>(value =>
  typeof value === 'string' && Object.hasOwn(scheduledDingTalkActionLabels, value))
export const scheduledOperationSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), tool: z.string().max(120),
  dingTalkAction: scheduledDingTalkActionSchema.optional(),
  status: z.enum(['submitting', 'succeeded', 'failed', 'unknown', 'not-executed']),
  target: z.string().max(256).regex(/^[^\p{Cc}\p{Bidi_Control}]+$/u).optional(),
  receipt: z.string().max(256).optional(),
  reason: z.enum(['not-attempted', 'scope-unverified', 'cancelled', 'connection-unavailable', 'target-unverified', 'platform-rejected', 'receipt-unverified', 'submission-uncertain', 'file-not-published', 'interaction-required', 'authentication-required', 'resource-not-found']).optional(),
}).strict()
export type ScheduledOperation = z.infer<typeof scheduledOperationSchema>
const scheduleBaseSchema = z.object({
  name: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(16000),
  workDir: z.string().trim().min(1).max(1024).refine(value => /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(value), '请选择绝对工作目录'),
  outputDirectory: z.object({ path: z.string().trim().min(1).max(1024), identity: z.string().max(120).optional(),
    // Retained for stored plans created with the previous opt-in setting.
    replaceWithBackup: z.literal(true).optional(),
  }).strict().optional(),
  scheduledAt: z.number().int().positive().max(8640000000000000),
  recurrence: recurrenceSchema.optional(),
  timezone: z.string().min(1).max(128).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
  }),
  permissions: z.object({ preset: z.enum(['workspace-edit', 'full-local']), approvalMode: z.enum(['confirm-each', 'auto-approve']) }).strict(),
  actions: scheduledActionsSchema.optional(),
}).strict()
export const employeeScheduleInputSchema = scheduleBaseSchema.extend({ mode: z.enum(['employee', 'auto']).optional(), subscriptionId: scheduleIdentity, modelId: scheduleModel })
export const scheduleInputSchema = z.union([
  employeeScheduleInputSchema.extend({ emptyText: z.never().optional() }),
  scheduleBaseSchema.extend({ mode: z.literal('general'), subscriptionId: z.never().optional(), modelId: scheduleModel, emptyText: z.never().optional() }),
  scheduleBaseSchema.extend({ mode: z.literal('empty-text'), subscriptionId: z.never().optional(), modelId: z.never().optional(), actions: z.never().optional(),
    permissions: z.object({ preset: z.literal('workspace-edit'), approvalMode: z.literal('confirm-each') }).strict(),
    emptyText: emptyTextActionSchema,
  }),
]).superRefine((input, context) => {
  if (input.recurrence?.frequency !== 'cron') return
  try {
    if (latestCronTime(input.recurrence.expression, input.timezone, input.scheduledAt) === input.scheduledAt) return
  } catch { /* Invalid timezone or cron is also rejected by the field schemas. */ }
  context.addIssue({ code: 'custom', path: ['scheduledAt'], message: '首次运行时间与重复规则不一致' })
})
export type ScheduleInput = z.infer<typeof scheduleInputSchema>
export type ModelScheduledInput = Exclude<ScheduleInput, { mode: 'empty-text' }>
export const retiredScheduledExecutionMessage = '空白文本本地动作已停用。请编辑任务，选择执行方式和模型后重新启用。'
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
export type ScheduledRunStatus = 'pending' | 'preparing' | 'launching' | 'running' | 'waiting_approval' | 'waiting_retry' | 'waiting_auth' | 'blocked' | 'review' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'missed'
export const scheduledIssueSchema = z.object({ code: z.string(), message: z.string(),
  action: z.enum(['retry', 'auth', 'blocked', 'review', 'fail']), retryAfterMs: z.number().positive().optional(),
}).strict()
export type ScheduledIssue = z.infer<typeof scheduledIssueSchema>
export interface ScheduledDefinition {
  id: string; revision: number; input: ScheduleInput; plan: ScheduledWorkPlan | null
  planInputKey: string | null; enabled: boolean; deleted: boolean; nextRunAt: number | null; pausedAt?: number | null
  createdAt: number; updatedAt: number
  actionGrant?: ScheduledActionGrant
  connectorRevision?: string | null
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
  actionGrant?: ScheduledActionGrant
  actionResults?: ScheduledActionResult[]
  operations?: ScheduledOperation[]
  connectorRevision?: string | null
}
export interface ScheduledSnapshot { definitions: ScheduledDefinition[]; occurrences: ScheduledOccurrence[]; creations?: ScheduledCreation[]; schedulerState?: 'running' | 'stopped' | 'error' }
export interface ScheduledOrigin { definitionId: string; occurrenceId: string }
export type ScheduleMutation = { id: string; expectedRevision: number }
