import { z } from 'zod'

export const FEEDBACK_OPERATIONS = {
  employees: '员工列表加载', employeeStatus: '员工状态加载',
  create: '工作安排创建', read: '工作安排读取', settings: '执行设置保存',
  attachments: '附件分配保存', preflight: '工作启动检查', start: '工作启动',
  planning: '自动编排', cancel: '取消自动编排', request: '员工申请', requestStatus: '员工申请状态查询',
  attachment: '附件操作', speech: '语音输入', directory: '工作目录选择',
} as const

export type FeedbackOperation = keyof typeof FEEDBACK_OPERATIONS
export const operationFailure = (operation: FeedbackOperation): string => `${FEEDBACK_OPERATIONS[operation]}失败，请联系平台管理员`

export const arrangementBlockingIssueSchema = z.object({
  code: z.enum(['EMPLOYEE_UNAVAILABLE', 'MODEL_NOT_ALLOWED', 'UNRESOLVED_STEPS', 'DELIVERY_INVALID']),
  message: z.string().min(1).max(200),
}).strict()
export type ArrangementBlockingIssue = z.infer<typeof arrangementBlockingIssueSchema>

export const arrangementPreflightFeedbackSchema = z.object({
  preflightId: z.string().min(1), draftId: z.string().min(1), draftRevision: z.number().int().nonnegative(),
  valid: z.boolean(), canStart: z.boolean(),
  issues: z.array(arrangementBlockingIssueSchema), message: z.string().min(1).max(200).nullable(),
}).strict()

/** Only validated IPC messages and local validation messages may use this error. */
export class UserFeedbackError extends Error {}

export function responseError(result: { error?: { message?: string } }, operation: FeedbackOperation): UserFeedbackError {
  return new UserFeedbackError(result.error?.message || operationFailure(operation))
}

export function feedbackMessage(error: unknown, operation: FeedbackOperation): string {
  return error instanceof UserFeedbackError ? error.message : operationFailure(operation)
}
