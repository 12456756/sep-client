import { useEffect, useRef } from 'react'
import { z } from 'zod'
import { useFeedback } from './feedback/FeedbackProvider'
import { approvalBrowserOrigin, isBrowserHandoffRequest, isMediaResubmissionRequest, OFFICE_TOOL_NAME, toolApprovalSummarySchema, toolApprovalTimeoutMs } from '../shared/tool-approval'
import type { ToolAuthorizationRequest } from '../shared/types'
import { conversationScheduleApprovalSchema, CREATE_SCHEDULED_TASK_TOOL, formatScheduleReceiptTime } from '../shared/scheduled-creation'

type ToolApprovalRequest = Pick<ToolAuthorizationRequest, 'toolName' | 'input' | 'registeredTool' | 'summary' | 'expiresAt'>
  & Partial<Pick<ToolAuthorizationRequest, 'requestId' | 'timestamp'>>
interface Props {
  request: ToolApprovalRequest | null
  onApprove: () => void
  onDeny: () => void
}

const paidQuote = z.object({ mock: z.literal(false), quote: z.object({
  amount: z.string().regex(/^\d+\.\d{6}$/).refine(value => Number.isFinite(Number(value))), currency: z.literal('CNY'),
}) })
const imageQuote = z.object({ quote: z.object({ amount: z.string().regex(/^\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value))), currency: z.string().min(1).max(20) }) })
const mediaSeconds = z.number().min(0).max(86400)
const mediaOverlay = { name: z.string().max(400), position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']), size: z.number().min(0.1).max(0.5) }
const mediaPlan = z.object({
  aspect: z.enum(['16:9', '9:16', '1:1']), resolution: z.literal([720, 1080]), durationSeconds: mediaSeconds,
  clips: z.array(z.object({ name: z.string().max(400), durationSeconds: mediaSeconds, start: mediaSeconds.optional(), end: mediaSeconds.optional(),
    crops: z.boolean(), rotation: z.literal([90, 180, 270]).optional(), volume: z.number().min(0).max(1).optional(),
    motion: z.enum(['still', 'zoom-in', 'pan-left', 'pan-right']).optional(), role: z.enum(['intro', 'outro']).optional(),
    speed: z.number().min(0.5).max(2).optional(), freeze: mediaSeconds.optional() })).min(1).max(8),
  transitions: z.array(mediaSeconds).max(7), fadeIn: mediaSeconds, fadeOut: mediaSeconds,
  music: z.object({ name: z.string().max(400), volume: z.number().min(0).max(1) }).optional(),
  watermark: z.object({ ...mediaOverlay, opacity: z.number().min(0.1).max(1) }).optional(),
  pip: z.object({ ...mediaOverlay, at: mediaSeconds, start: mediaSeconds, end: mediaSeconds }).optional(),
  audio: z.object({ denoise: z.boolean(), normalize: z.boolean(), duckMusic: z.boolean() }).optional(),
})
function compositionApproval(input: unknown): string | undefined {
  const parsed = mediaPlan.safeParse(input)
  if (!parsed.success) return undefined
  const { aspect, resolution, durationSeconds, clips, transitions, fadeIn, fadeOut, music, watermark, pip, audio } = parsed.data
  const seconds = (n: number) => String(Number(n.toFixed(3)))
  const motion = { still: '静止', 'zoom-in': '推近', 'pan-left': '向左横移', 'pan-right': '向右横移' }
  const position = { 'top-left': '左上', 'top-right': '右上', 'bottom-left': '左下', 'bottom-right': '右下' }
  const lines = clips.map((clip, i) => {
    const timing = clip.start !== undefined && clip.end !== undefined ? `${seconds(clip.start)}–${seconds(clip.end)} 秒` : `${seconds(clip.durationSeconds)} 秒`
    const settings = [timing, clip.speed && `${seconds(clip.speed)} 倍速`, clip.freeze && `静音定格 ${seconds(clip.freeze)} 秒`,
      clip.motion && motion[clip.motion], clip.crops ? '裁切' : '完整显示',
      clip.rotation && `顺时针 ${clip.rotation}°`, clip.volume === 0 ? '无原声' : clip.volume !== undefined ? `原声 ${Math.round(clip.volume * 100)}%` : undefined]
    return `${i + 1}. ${clip.role === 'intro' ? '片头：' : clip.role === 'outro' ? '片尾：' : ''}${clip.name.slice(0, 100)}（${settings.filter(Boolean).join('，')}）${transitions[i] ? ` → 交叉淡化 ${seconds(transitions[i])} 秒` : ''}`
  })
  if (fadeIn || fadeOut) lines.push(`整片淡入 ${seconds(fadeIn)} 秒，淡出 ${seconds(fadeOut)} 秒`)
  if (music) lines.push(`配乐：${music.name.slice(0, 100)}（音量 ${Math.round(music.volume * 100)}%）`)
  if (watermark) lines.push(`水印：${watermark.name.slice(0, 100)}（${position[watermark.position]}，尺寸上限 ${Math.round(watermark.size * 100)}%，不透明度 ${Math.round(watermark.opacity * 100)}%）`)
  if (pip) lines.push(`画中画：${pip.name.slice(0, 100)}（源片 ${seconds(pip.start)}–${seconds(pip.end)} 秒，成片第 ${seconds(pip.at)} 秒开始，${position[pip.position]}，尺寸上限 ${Math.round(pip.size * 100)}%，无原声）`)
  if (audio) {
    const effects = [audio.denoise && '原声降噪', audio.normalize && '响度统一（目标 −16 LUFS）', audio.duckMusic && '原声活动时自动压低配乐'].filter(Boolean)
    if (effects.length) lines.push(`声音：${effects.join('、')}`)
  }
  return `在本机合成并保存 MP4？${aspect}，${resolution}p，预计 ${seconds(durationSeconds)} 秒。原素材不会被覆盖。\n\n${lines.join('\n')}`
}
const messages: Readonly<Record<string, string>> = {
  mcp__playwright__browser_navigate: '允许打开指定网页？',
  mcp__playwright__browser_snapshot: '允许读取当前网页内容？',
  mcp__playwright__browser_click: '允许点击网页元素？此操作可能触发网页提交或其他操作。',
  mcp__playwright__browser_set_mode: '允许切换浏览器显示模式？',
  mcp__playwright__browser_scroll: '允许滚动当前网页？',
  mcp__playwright__browser_extract: '允许提取当前网页的可见内容？',
  mcp__playwright__browser_save_assets: '允许将当前网页已加载的素材保存到本对话的成果目录？',
  bash: '允许员工在本机执行命令？此操作可能修改文件或访问系统资源。',
  write: '允许员工创建或覆盖文件？覆盖后原有内容可能无法恢复。',
  edit: '允许员工修改文件内容？',
  media_generate_image: '允许员工生成图片？本次操作可能产生费用。',
  media_cancel_job: '允许请求平台取消图片任务？取消结果以平台返回为准，不代表退款。',
  video_generate: '允许员工按已确认的要求生成视频？',
  video_from_image: '允许员工上传所选参考图或生成视频？',
  local_media_process: '允许在本机处理所选素材并保存新文件？原素材不会被覆盖。',
}

function approvalSummaryMessage(request: ToolApprovalRequest): string | undefined {
  if (request.registeredTool !== true) return undefined
  const parsed = toolApprovalSummarySchema.safeParse(request.summary)
  if (!parsed.success) return undefined
  const summary = parsed.data
  switch (summary.kind) {
    case 'office': {
      if (request.toolName !== OFFICE_TOOL_NAME) return undefined
      const files = summary.files.map(name => `「${name}」`).join('、') + (summary.additionalFiles ? '等文件' : '')
      if (summary.operation === 'import-doc') return `允许用本机 Microsoft Word 打开旧版 Word 文件并创建编辑副本 ${files}？仅在信任文件来源时允许。原文件不会被覆盖。`
      if (summary.operation === 'export-doc') return `允许用本机 Microsoft Word 生成 Word 97–2003 文件 ${files}？原文件不会被覆盖。`
      if (summary.operation === 'write') return `允许 OfficeCLI 写入 ${files}？如果目标文件已存在，原有内容可能被覆盖。`
      return `允许 OfficeCLI ${summary.operation === 'batch' ? '批量修改' : '修改'} ${files}？更改将写入所列目标。`
    }
    case 'browser-navigate':
      if (request.toolName === 'mcp__playwright__browser_navigate') {
        return summary.origin ? `允许打开网页？目标站点：${summary.origin}` : messages[request.toolName]
      }
      break
    case 'browser-snapshot':
      if (request.toolName === 'mcp__playwright__browser_snapshot') {
        return summary.savesFile ? '允许读取当前网页内容并将快照保存为文件？' : messages[request.toolName]
      }
      break
    case 'browser-click':
      if (request.toolName === 'mcp__playwright__browser_click') return messages[request.toolName]
      break
    case 'browser-save-assets':
      if (request.toolName === 'mcp__playwright__browser_save_assets') return messages[request.toolName]
      break
  }
}

function scheduleRecurrenceLabel(expression: string): string {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/)
  if (day === '*' && month === '*' && weekday === '*') {
    if (minute === '*' && hour === '*') return '每分钟'
    if (minute !== undefined && /^(?:[0-5]?\d)$/.test(minute)) {
      if (hour === '*') return `每小时第 ${Number(minute)} 分钟`
      if (hour !== undefined && /^(?:[01]?\d|2[0-3])$/.test(hour)) return `每天 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    }
  }
  return `自定义（Cron：${expression}）`
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
    const deadline = request.expiresAt ?? (request.timestamp ?? Date.now()) + toolApprovalTimeoutMs(request)
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
    const browserHandoff = isBrowserHandoffRequest(request)
    const resubmission = isMediaResubmissionRequest(request)
    const transmission = (isVideo || request.toolName === 'media_generate_image') && input.success && input.data.operation === 'upload-references'
    if (!Number.isFinite(deadline) || remaining <= 0 || isVideo && !transmission && !resubmission && (!raw.success || raw.data.mock !== true && !quote.success)) {
      settle(false)
      return
    }
    const price = request.toolName === 'media_generate_image' ? imageQuote.safeParse(request.input) : null
    // The trusted host validates media quotes and spending before asking the renderer to proceed.
    if (!transmission && !resubmission && (isVideo || price?.success)) {
      settle(true)
      return
    }
    const toolName = request.toolName
    const name = toolName === OFFICE_TOOL_NAME ? 'OfficeCLI' : /^[\w.-]{1,128}$/.test(toolName) ? toolName : undefined
    let message = Object.hasOwn(messages, toolName) ? messages[toolName] : request.registeredTool === true
      ? name ? `允许本次使用 ${name}？` : '允许本次使用该工具？'
      : `员工请求执行未知工具“${toolName}”，风险无法确认，建议拒绝。是否仍允许？`
    if (request.toolName === 'mcp__playwright__browser_navigate' && input.success) {
      const destination = approvalBrowserOrigin(input.data.url)
      if (destination) message = `允许打开网页？目标站点：${destination}`
    }
    if (request.toolName === 'mcp__playwright__browser_set_mode' && input.success && input.data.profile === 'persistent') {
      message = '允许在本对话中保留浏览器资料和网站登录状态？'
    }
    if (request.toolName === 'mcp__playwright__browser_snapshot' && input.success && typeof input.data.filename === 'string') {
      message = '允许读取当前网页内容并将快照保存为文件？'
    }
    const scheduling = request.toolName === CREATE_SCHEDULED_TASK_TOOL
    if (scheduling) {
      const schedule = conversationScheduleApprovalSchema.safeParse(request.input)
      if (!schedule.success) { settle(false); return }
      const { title, goal, firstRunAt, timezone, recurrence } = schedule.data
      message = `创建并启用「${title}」？${recurrence ? '预计首次执行' : '计划执行时间'}：${formatScheduleReceiptTime(firstRunAt, timezone)}。${recurrence ? ` 重复规则：${scheduleRecurrenceLabel(recurrence)}。` : ' 仅执行一次。'}\n\n${goal}`
    }
    if (request.toolName === 'local_media_process' && input.success) {
      const labels = { trim: '裁剪', join: '拼接', compose: '合成视频', extract_audio: '提取音频', transcode: '转码',
        batch_transcode: '批量转码', frame: '提取视频帧', thumbnail_grid: '生成缩略图网格', gif: '导出 GIF', subtitle: '识别字幕' }
      const operation = z.custom<keyof typeof labels>(value => typeof value === 'string' && Object.hasOwn(labels, value)).safeParse(input.data.operation)
      const files = z.array(z.string()).max(8).safeParse(input.data.files)
      if (operation.success && operation.data === 'compose') {
        const summary = compositionApproval(input.data.plan)
        if (!summary) { settle(false); return }
        message = summary
      } else if (operation.success && operation.data === 'subtitle' && files.success && files.data.length === 1) {
        message = `允许在本机识别「${files.data[0].slice(0, 100)}」的语音并保存 SRT 字幕？不会上传素材或改动原文件。`
      } else if (operation.success && files.success) {
        const names = files.data.map(name => name.slice(0, 100)).join('、')
        const size = operation.data === 'transcode' || operation.data === 'batch_transcode'
          ? z.number().int().positive().max(1024 ** 3).safeParse(input.data.maxBytes).data : undefined
        const format = operation.data === 'extract_audio' ? z.enum(['m4a', 'mp3', 'wav']).safeParse(input.data.format).data : undefined
        const details = size ? `（每个成品上限 ${size.toLocaleString('zh-CN')} 字节）` : format ? `为 ${format.toUpperCase()}` : ''
        message = `允许在本机${labels[operation.data]}「${names}」${details}并保存新文件？原素材不会被覆盖。`
      }
    }
    const officeCommand = input.success && request.toolName === OFFICE_TOOL_NAME ? input.data.command : null
    if (Array.isArray(officeCommand) && officeCommand[0] === 'import-doc') message = '允许用本机 Microsoft Word 打开这个旧版 Word 文件并创建编辑副本？仅在信任文件来源时允许。原文件不会被覆盖。'
    if (Array.isArray(officeCommand) && officeCommand[0] === 'export-doc') message = '允许用本机 Microsoft Word 生成一个新的 Word 97–2003 文件？原文件不会被覆盖。'
    message = approvalSummaryMessage(request) ?? message
    if (browserHandoff) message = '浏览器窗口已打开，请完成登录、扫码或验证，再点击“已完成，继续”。员工将在原页面继续操作。请在 3 分钟内完成；取消或超时会关闭此浏览器会话。'
    if (transmission) message = '允许上传所选参考图？此操作仅传输参考图，生成前会校验报价。'
    if (resubmission) message = isVideo
      ? '原任务是否受理及计费尚未确认，可能仍在生成。仍要创建新的视频任务？新旧任务可能分别生成并计费，原任务状态仍会保留。'
      : `有 ${input.success ? Number(input.data.unconfirmedJobCount) : 1} 个原图片任务的提交结果尚未确认。仍要重新生成这批图片？新旧任务可能分别计费，原任务仍会保留。`
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
      actionLabel: scheduling ? '创建并启用' : browserHandoff ? '已完成，继续' : resubmission ? '仍然生成' : isVideo && quote.success ? '同意并生成' : '允许',
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
