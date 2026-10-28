import { z } from 'zod'
import type { FeedbackController } from './feedback-controller'
import type { TaskExecutionEvent } from './types'

export const RUNTIME_FAILURE_EVENT = 'run_failure_notice'
export const RUNTIME_FAILURE_MESSAGES = {
  MODEL_TIMEOUT: '模型请求超时，请稍后重试',
  MODEL_RESPONSE_INTERRUPTED: '模型响应中断，请稍后重试',
  NETWORK_ERROR: '网络连接失败，请检查网络后重试',
  AUTH_REQUIRED: '登录验证未通过，请重新登录',
  REQUEST_DENIED: '模型请求被拒绝，请联系平台管理员',
  RATE_LIMITED: '模型请求过于频繁，请稍后重试',
  SERVICE_UNAVAILABLE: '模型服务暂时不可用，请联系平台管理员',
  EMPLOYEE_UNAVAILABLE: '所选员工当前不可用，请重新选择员工',
  MODEL_NOT_ALLOWED: '所选模型不可用，请联系平台管理员',
  DELIVERY_FAILED: '工作成果校验未通过，请联系平台管理员',
  MEDIA_UNAVAILABLE: '当前媒体交付暂不可用，请联系平台管理员',
  STORAGE_FAILED: '工作运行结果保存失败，请联系平台管理员',
  SESSION_UNRECOVERABLE: '工作历史会话无法恢复，请联系平台管理员',
  SIDE_EFFECT_UNCONFIRMED: '上次操作结果尚未确认，请先核实后再重试',
  INTERNAL_ERROR: '工作运行失败，请联系平台管理员',
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
