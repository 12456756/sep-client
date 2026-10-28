import { useEffect, useRef } from 'react'
import { z } from 'zod'
import { useFeedback } from './feedback/FeedbackProvider'

interface ToolApprovalRequest {
  requestId?: string
  toolName: string
  input: unknown
  timestamp?: number
  expiresAt?: number
}
interface Props {
  request: ToolApprovalRequest | null
  onApprove: () => void
  onDeny: () => void
}

const paidQuote = z.object({ mock: z.literal(false), quote: z.object({
  amount: z.string().regex(/^\d+\.\d{6}$/).refine(value => Number.isFinite(Number(value))), currency: z.literal('CNY'),
}) })
const imageQuote = z.object({ quote: z.object({ amount: z.string().regex(/^\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value))), currency: z.string().min(1).max(20) }) })
const messages: Readonly<Record<string, string>> = {
  bash: '允许员工在本机执行命令？此操作可能修改文件或访问系统资源。',
  write: '允许员工创建或覆盖文件？覆盖后原有内容可能无法恢复。',
  edit: '允许员工修改文件内容？',
  media_generate_image: '允许员工生成图片？本次操作可能产生费用。',
  media_cancel_job: '允许请求平台取消图片任务？取消结果以平台返回为准，不代表退款。',
  video_generate: '允许员工按已确认的要求生成视频？',
  video_from_image: '允许员工上传所选参考图或生成视频？',
}

/** The main process owns the deadline; queueing never restarts its approval budget. */
export function ToolApprovalDialog({ request, onApprove, onDeny }: Props) {
  const feedback = useFeedback()
  const lifetime = useRef<{ request: ToolApprovalRequest; token: object } | null>(null)
  const resolved = useRef<ToolApprovalRequest | null>(null)
  useEffect(() => {
    if (!request || resolved.current === request) return
    const token = {}
    lifetime.current = { request, token }
    let active = true
    const approval = new AbortController()
    const revision = feedback.getRevision()
    const deadline = request.expiresAt ?? (request.timestamp ?? Date.now()) + 60_000
    const remaining = deadline - Date.now()
    let settled = false
    const settle = (accepted: boolean) => {
      if (settled || !active) return
      settled = true
      resolved.current = request
      if (accepted && !approval.signal.aborted && Date.now() < deadline && revision === feedback.getRevision()) onApprove()
      else onDeny()
    }
    const quote = paidQuote.safeParse(request.input)
    const isVideo = request.toolName === 'video_generate' || request.toolName === 'video_from_image'
    const raw = z.object({ mock: z.boolean().optional() }).safeParse(request.input)
    const input = z.record(z.string(), z.unknown()).safeParse(request.input)
    const transmission = (isVideo || request.toolName === 'media_generate_image') && input.success && input.data.operation === 'upload-references'
    if (!Number.isFinite(deadline) || remaining <= 0 || isVideo && !transmission && (!raw.success || raw.data.mock !== true && !quote.success)) {
      settle(false)
      return
    }
    let message = Object.hasOwn(messages, request.toolName) ? messages[request.toolName] : `员工请求执行未知工具“${request.toolName}”，风险无法确认，建议拒绝。是否仍允许？`
    if (transmission) message = '允许上传所选参考图？此操作仅传输参考图，生成前将另行确认报价。'
    const price = request.toolName === 'media_generate_image' ? imageQuote.safeParse(request.input) : null
    if (price?.success) message += ` 本次报价 ${price.data.quote.amount} ${price.data.quote.currency}。`
    if (input.success && ['bash', 'write', 'edit'].includes(request.toolName)) {
      const target = request.toolName === 'bash' ? input.data.command : input.data.path
      if (typeof target === 'string') message += ` ${request.toolName === 'bash' ? '命令' : '文件'}：${target}`
      else if (target && typeof target === 'object') message += ` 命令：${JSON.stringify(target)}`
    }
    const timer = window.setTimeout(() => { approval.abort(); settle(false) }, remaining)
    void feedback.ask({
      key: `approval:${request.requestId ?? request.timestamp ?? deadline}`,
      message: isVideo && quote.success ? `${message} 本次报价 ¥${quote.data.quote.amount}。` : message,
      actionLabel: isVideo && quote.success ? '同意并生成' : '允许',
      signal: approval.signal,
    }).then(settle)
    return () => {
      active = false
      window.clearTimeout(timer)
      approval.abort()
      // StrictMode replays the same request's effect; only a real departure denies it.
      queueMicrotask(() => {
        if (!settled && (lifetime.current?.token === token || lifetime.current?.request !== request)) {
          settled = true
          resolved.current = request
          onDeny()
        }
      })
    }
  }, [request, feedback, onApprove, onDeny])
  return null
}
