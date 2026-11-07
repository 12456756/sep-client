import { z } from 'zod'
import type { FeedbackController } from './feedback-controller'
import type { TaskExecutionEvent } from './types'

export const RUNTIME_FAILURE_EVENT = 'run_failure_notice'
export const RUNTIME_FAILURE_MESSAGES = {
  MODEL_TIMEOUT: '模型请求超时，请稍后重试',
  MODEL_RESPONSE_INTERRUPTED: '模型响应中断，请稍后重试',
  NETWORK_ERROR: '网络连接失败，请检查网络后重试',
  AUTH_REQUIRED: '登录验证未通过，请重新登录',
  REQUEST_DENIED: '模型服务拒绝了本次请求，请检查模型权限和工作设置；如需授权，请联系平台管理员。',
  RATE_LIMITED: '模型请求过于频繁，请稍后重试',
  SERVICE_UNAVAILABLE: '模型服务暂时不可用，请稍后重试；持续失败请联系平台管理员。',
  EMPLOYEE_UNAVAILABLE: '所选员工当前不可用，请重新选择员工',
  MODEL_NOT_ALLOWED: '当前员工没有所选模型的使用权限，请更换员工或模型；如需授权，请联系平台管理员。',
  MODEL_VISION_UNSUPPORTED: '所选模型不支持图片输入，请选择支持图片的模型，或新建不含图片的对话。',
  DELIVERY_FAILED: '工作成果未满足计划中的交付要求，请检查交付清单、文件路径和文件内容后重试。',
  MEDIA_UNAVAILABLE: '当前流程暂不支持该媒体交付方式，请保留已生成的媒体资产，不要重复生成。',
  MEDIA_DOWNLOAD_FAILED: '原图片或视频下载失败，自动恢复未成功，请恢复原任务下载，勿重复生成。',
  MEDIA_DELIVERY_FAILED: '图片或视频已生成，但无法保存到交付目录，请检查目录权限和磁盘空间后恢复交付，勿重复生成。',
  STORAGE_FAILED: '工作成果保存失败，请检查磁盘空间、成果目录读写权限后重试。',
  SESSION_UNRECOVERABLE: '工作历史会话文件或运行记录丢失、损坏或与当前任务不匹配，无法继续原会话。',
  SIDE_EFFECT_UNCONFIRMED: '上次操作结果尚未确认，请先核实后再重试',
  INTERNAL_ERROR: '工作运行失败，客户端没有取得更具体的原因，请重试并保留发生时间，便于排查。',
} as const
export type RuntimeFailureCode = keyof typeof RUNTIME_FAILURE_MESSAGES
export interface RuntimeFailure { code: RuntimeFailureCode; message: string }

export const runtimeFailureNoticeSchema = z.object({
  owner: z.object({ memberId: z.string().min(1), enterpriseId: z.string().min(1) }).strict(),
  code: z.enum(Object.keys(RUNTIME_FAILURE_MESSAGES) as [RuntimeFailureCode, ...RuntimeFailureCode[]]),
}).strict()

/** This listener lives with the signed-in workspace, independently of its route. */
export function createRuntimeFailureListener(feedback: FeedbackController, owner: { memberId: string; enterpriseId: string }) {
  const revision = feedback.getRevision()
  const startedAt = Date.now()
  const seen = new Set<string>()
  let active = true
  return {
    receive(event: TaskExecutionEvent): void {
      if (!active || revision !== feedback.getRevision() || event.type !== RUNTIME_FAILURE_EVENT || event.occurredAt < startedAt) return
      const parsed = runtimeFailureNoticeSchema.safeParse(event.data)
      if (!parsed.success || parsed.data.owner.memberId !== owner.memberId || parsed.data.owner.enterpriseId !== owner.enterpriseId) return
      const key = JSON.stringify([event.taskId, event.runId])
      if (seen.has(key)) return
      seen.add(key)
      feedback.show({ key: `runtime:${key}`, tone: 'error', message: RUNTIME_FAILURE_MESSAGES[parsed.data.code] })
    },
    dispose(): void { active = false; seen.clear() },
  }
}
