import { z } from 'zod'

export const FEEDBACK_OPERATIONS = {
  employees: '员工列表加载', employeeStatus: '员工状态加载',
  create: '工作安排创建', read: '工作安排读取', settings: '执行设置保存',
  attachments: '附件分配保存', preflight: '工作启动检查', start: '工作启动',
  planning: '自动编排', cancel: '取消自动编排', request: '员工申请', requestStatus: '员工申请状态查询',
  attachment: '附件操作', speech: '语音输入', directory: '工作目录选择',
  workList: '工作记录加载', workType: '工作类型读取', workMessages: '历史对话加载',
  workPlan: '工作计划加载', workExecution: '工作执行状态加载', workTimeline: '工作过程加载',
  workSend: '消息发送', workSwitch: '员工切换', workConfirm: '工作步骤确认',
  workStop: '工作终止', workRetry: '工作重试', workDelete: '工作记录删除',
  workRename: '工作名称保存', workPin: '工作置顶', workUnpin: '取消置顶',
  imageRead: '图片任务读取', imageGenerate: '图片生成', imageImport: '参考图导入',
  imageSelection: '参考图选择保存', imagePreview: '图片预览', imageExport: '图片导出',
  imageResume: '图片跟踪恢复', imageSave: '图片成果重新保存', imageCancel: '图片取消请求',
  videoRead: '视频任务读取', videoGenerate: '视频生成', videoImport: '参考图导入',
  videoPreview: '视频预览', videoExport: '视频导出', videoResume: '视频跟踪恢复', videoSave: '视频成果重新保存',
  documentPreview: '文档预览', workOpenDirectory: '打开文件所在目录',
} as const

export type FeedbackOperation = keyof typeof FEEDBACK_OPERATIONS
const operationFailures: Partial<Record<FeedbackOperation, string>> = {
  documentPreview: '文档预览失败，客户端没有取得具体原因，请重新打开预览或查看原文件。',
  videoPreview: '视频文件格式不受支持或文件内容无法解码，请导出原文件后使用本地播放器打开。',
  imagePreview: '图片文件无法读取或解码，请重新保存原结果，或导出原文件后查看。',
  workOpenDirectory: '无法打开文件所在目录，请确认文件和目录仍存在，并检查系统访问权限。',
  workRetry: '本次重试未能完成，请稍后再试。',
  speech: '语音输入失败，客户端没有取得具体原因，请重新录音后重试。',
}
export const operationFailure = (operation: FeedbackOperation): string => operationFailures[operation]
  ?? `${FEEDBACK_OPERATIONS[operation]}失败，客户端没有取得具体原因，请重试；持续失败请联系平台管理员。`

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
export class UserFeedbackError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export function responseError(result: { error?: { message?: string; code?: string } }, operation: FeedbackOperation): UserFeedbackError {
  return new UserFeedbackError(result.error?.message || operationFailure(operation), result.error?.code)
}

export function isDraftRevisionConflict(error: unknown): boolean {
  return error instanceof UserFeedbackError && error.code === 'DRAFT_REVISION_CONFLICT'
}

export async function recoverDraftRevisionConflict(error: unknown, reload: () => Promise<unknown>, onReloadFailure: (error: unknown) => void): Promise<boolean> {
  if (!isDraftRevisionConflict(error)) return false
  try { await reload() } catch (cause) { onReloadFailure(cause) }
  return true
}

export function feedbackMessage(error: unknown, operation: FeedbackOperation): string {
  return error instanceof UserFeedbackError ? error.message : operationFailure(operation)
}
