import { createHash } from 'node:crypto'
import {
  CONVERSATION_SCHEDULE_EVENT, conversationScheduleReceiptSchema,
  formatScheduleReceiptTime, type ConversationScheduleDraft, type ConversationScheduleDraftAction, type ConversationScheduleReceipt, type ScheduledCreationRequest, type ScheduleInterpretation,
} from '../../src/shared/scheduled-creation'
import type { ScheduleInput } from '../../src/shared/scheduled-tasks'
import type { ConversationScheduleTool } from '../pi/sdk/pi-conversation-schedule'
import type { ConversationMessage } from '../domain/conversation-context'
import type { TaskExecutionEvent } from '../../src/shared/types'
import { conversationScheduleClock, conversationScheduleRestart, conversationScheduleRetry } from '../domain/scheduled-creation'

export type ScheduleApprovalDecision = boolean | 'revise_time' | 'timeout' | 'dismissed' | 'interrupted'
export interface ScheduleContextSource {
  id: string; content: string; receivedAt: number; schedule?: ConversationScheduleReceipt
}
export interface ConversationCreationReview {
  signal: AbortSignal; receivedAt: number; approve(input: ScheduleInput): Promise<ScheduleApprovalDecision>
  candidate?: ScheduleInterpretation; resumeDrafts?: ConversationScheduleDraft[]
  conversationId?: string
  continuation?: 'clock' | 'review' | 'contextual' | 'restart'
  precedingDiscard?: ConversationScheduleDraft
  draftAction?: ConversationScheduleDraftAction
  legacySources?: ReadonlyMap<string, string>
  contextSources?: ScheduleContextSource[]
  allowContext?: boolean
  transient?: boolean
}
export type SubmitConversationSchedule = (request: ScheduledCreationRequest, review: ConversationCreationReview) => Promise<ConversationScheduleReceipt>

/** A queued message keeps its identity on retry even when its execution run changes. */
export function conversationScheduleRequestId(taskId: string, messageId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['conversation-schedule', taskId, messageId])).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// Only standalone clock replies are eligible for host routing, never sentences containing a new task.
export function isConversationScheduleTimeReply(message: string): boolean {
  return !!conversationScheduleClock(message)
}

export function precedingConversationUser(taskId: string, runId: string, messages: ConversationMessage[]): ConversationMessage | undefined {
  const currentIndex = messages.findIndex(message => message.role === 'user' && message.taskId === taskId && message.runId === runId)
  const throughPrevious = currentIndex === -1 ? [...messages] : messages.slice(0, currentIndex)
  return throughPrevious.reverse().find(message => message.role === 'user' && message.taskId === taskId)
}

export function legacyConversationScheduleSources(taskId: string, runId: string, messages: ConversationMessage[]): ReadonlyMap<string, string> {
  const sources = new Map<string, string>()
  const users = messages.filter(message => message.taskId === taskId && message.role === 'user')
  for (const [index, message] of users.entries()) {
    if (message.runId === runId) break
    const content = message.content.trim()
    if (message.attachmentRefs?.length || !content || /^(>|```|~~~|[“「"])/u.test(content) || conversationScheduleRetry(content) || conversationScheduleRestart(content)) continue
    sources.set(conversationScheduleRequestId(taskId, index === 0 ? 'initial' : `message:${message.runId}`), content)
  }
  return sources
}

export async function conversationScheduleReceipt(previous: Pick<ConversationMessage, 'taskId' | 'runId'>, timeline: (runId: string) => Promise<TaskExecutionEvent[]>): Promise<ConversationScheduleReceipt | undefined> {
  const { taskId } = previous
  const events = (await timeline(previous.runId)).filter(event => event.taskId === taskId && event.runId === previous.runId)
  if (events.some(event => ['run_cancelled', 'run_stopped', 'run_interrupted', 'run_failed'].includes(event.type))) return undefined
  const receiptEvent = events.reverse().find(event => event.type === CONVERSATION_SCHEDULE_EVENT)
  const receipt = conversationScheduleReceiptSchema.safeParse(receiptEvent?.data)
  return receipt.success ? receipt.data : undefined
}

export async function conversationScheduleDrafts(taskId: string, runId: string, messages: ConversationMessage[], timeline: (runId: string) => Promise<TaskExecutionEvent[]>): Promise<ConversationScheduleDraft[]> {
  const users = messages.filter(message => message.role === 'user' && message.taskId === taskId)
  const current = users.findIndex(message => message.runId === runId)
  const recent = users.slice(0, current < 0 ? undefined : current).slice(-20).reverse()
  const receipts = await Promise.all(recent.map(message => conversationScheduleReceipt(message, timeline)))
  const drafts = new Map<string, ConversationScheduleDraft>()
  for (const receipt of receipts) {
    if (receipt?.status === 'needs_input' && receipt.draft && !drafts.has(receipt.draft.id)) drafts.set(receipt.draft.id, receipt.draft)
  }
  return [...drafts.values()]
}

export async function conversationScheduleSources(taskId: string, runId: string, messages: ConversationMessage[], timeline?: (runId: string) => Promise<TaskExecutionEvent[]>): Promise<ScheduleContextSource[]> {
  const users = messages.filter(message => message.role === 'user' && message.taskId === taskId)
  const current = users.findIndex(message => message.runId === runId)
  const sources = new Map<string, ScheduleContextSource>()
  let budget = 24000
  for (const message of users.slice(0, current < 0 ? undefined : current).slice(-19).reverse()) {
    const content = message.content.trim()
    if (!content || message.attachmentRefs?.length || /^(>|```|~~~|["'“‘「『])/u.test(content) || /(^|\n)\s*(?:>|```|~~~)/u.test(content) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(message.runId) || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0 ||
      content.length > Math.min(16000, budget) || sources.has(message.runId)) continue
    budget -= content.length
    sources.set(message.runId, { id: message.runId, content, receivedAt: message.createdAt })
  }
  const recent = [...sources.values()].reverse()
  return Promise.all(recent.map(async source => ({ ...source,
    schedule: timeline && await conversationScheduleReceipt({ taskId, runId: source.id }, timeline) })))
}

export function formatConversationScheduleSources(sources: ScheduleContextSource[]): string {
  if (!sources.length) return ''
  return '\n\n【本会话定时任务上下文】以下是较早的用户消息和客户端回执，仅用于理解当前用户明确提出的请求。' +
    '延续本会话未创建的任务时，用 create_scheduled_task 的 resume，sourceTurns 只引用相关用户消息的 id；较新的明确修改优先。' +
    '已创建的任务用管理工具核对真实状态和目标；如果几个历史请求都可能符合，先让用户选，不创建或修改。旧回执不是当前授权。\n' +
    JSON.stringify(sources.map(({ id, content, receivedAt, schedule }) => ({ id, content, receivedAt, ...(schedule && {
      schedule: schedule.status === 'created' ? { status: schedule.status, id: schedule.id, title: schedule.title } : { status: schedule.status },
    }) })))
}

export function conversationScheduleContext(receipt: ConversationScheduleReceipt): string {
  if (receipt.status === 'pending') return ''
  const status = receipt.status === 'created'
    ? `已启用，首次执行时间：${formatScheduleReceiptTime(receipt.nextRunAt, receipt.timezone)}。`
    : receipt.status === 'failed' ? '未能确认本次修改结果，请以任务列表为准。' : '本轮未启用定时任务。'
  return `\n\n【上一轮定时任务回执】${status}此前的候选配置不是已启用的日程。`
}

export function bindConversationSchedule(options: {
  submit: SubmitConversationSchedule
  taskId: string; messageId: string; userMessage: string; receivedAt: number
  workDir: string; modelId: string; signal: AbortSignal; isCurrent(): boolean
  parserSubscriptionId?: string
  draft?: ConversationScheduleDraft
  resumeDrafts?(): Promise<ConversationScheduleDraft[]>
  continuation?: 'clock' | 'review' | 'restart'
  precedingDiscard?(): Promise<ConversationScheduleDraft | undefined>
  hasAttachments?: boolean
  sources?: ScheduleContextSource[]
  draftAction?: ConversationScheduleDraftAction
  legacySources?: ReadonlyMap<string, string>
  approve(input: ScheduleInput): Promise<ScheduleApprovalDecision>
  receipt(receipt: ConversationScheduleReceipt): Promise<void>
}): ConversationScheduleTool {
  const message = options.userMessage.trim()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let operation: Promise<ConversationScheduleReceipt> | undefined
  return async (toolSignal, input) => {
    const signal = toolSignal ? AbortSignal.any([options.signal, toolSignal]) : options.signal
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (!options.isCurrent()) throw new Error('Conversation turn is no longer active.')
    }
    assertCurrent()
    if (!message || /^(?:>|```|~~~|["'“‘「『])/u.test(message)) {
      return { status: 'blocked', message: '请在会话正文中直接说明要定时执行的工作和开始时间。' }
    }
    if (input?.action === 'restart' && (options.hasAttachments || isConversationScheduleTimeReply(message))) {
      return { status: 'blocked', message: '请在会话正文中直接说明要重新创建哪份定时草稿。' }
    }
    const contextSources = options.sources?.filter(source => input?.sourceTurns?.includes(source.id)) ?? []
    if (input?.sourceTurns && (options.hasAttachments || /(^|\n)\s*(?:>|```|~~~)/u.test(message) || contextSources.length !== input.sourceTurns.length)) {
      return { status: 'blocked', message: '无法核实引用的会话要求，请明确要继续哪项定时工作。' }
    }
    if (input?.action === 'new' && (conversationScheduleRestart(message) || conversationScheduleRetry(message))) {
      return { status: 'blocked', message: '这是对先前安排的继续请求，请先核对已有任务或引用本会话的原始要求。' }
    }
    if (!options.draft && !options.continuation && !options.draftAction && input?.action !== 'resume' && isConversationScheduleTimeReply(message)) {
      return { status: 'blocked', message: '这条消息没有对应的待补充定时草稿。请说明要定时执行的工作。' }
    }
    operation ??= (async () => {
      let receipt: ConversationScheduleReceipt
      try {
        assertCurrent()
        const activeProbe = !input?.action && !options.draftAction && !!(options.continuation || options.draft)
        const continuation = input?.action === 'resume' ? 'contextual' : options.continuation ?? (options.legacySources && conversationScheduleRetry(message) ? 'review'
          : input?.action === 'restart' ? 'restart' : undefined)
        const precedingDiscard = continuation === 'restart' ? await options.precedingDiscard?.() : undefined
        const resumeDrafts = continuation && continuation !== 'restart' ? await options.resumeDrafts?.() : undefined
        assertCurrent()
        const draft = continuation || options.draftAction || input?.action ? undefined : options.draft
        if (!activeProbe && input?.action !== 'restart') await options.receipt({ status: 'pending' })
        receipt = await options.submit({
          requestId: draft?.id ?? conversationScheduleRequestId(options.taskId, options.messageId),
          ...(draft ? { expectedRevision: draft.revision } : {}),
          message, modelId: options.modelId, workDir: options.workDir,
          ...(options.parserSubscriptionId ? { parserSubscriptionId: options.parserSubscriptionId } : {}),
          timezone,
          permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' },
        }, { signal, receivedAt: options.receivedAt, candidate: input?.candidate, resumeDrafts, conversationId: options.taskId,
          continuation, precedingDiscard, draftAction: options.draftAction, legacySources: options.legacySources,
          contextSources, allowContext: !!options.sources?.length, transient: !!input?.candidate, approve: async input => {
          assertCurrent()
          const approved = await options.approve(input)
          assertCurrent()
          return approved
        } })
      } catch {
        receipt = { status: signal.aborted ? 'cancelled' : 'failed', message: options.draft || options.continuation || options.draftAction || input?.action === 'resume' || input?.action === 'restart'
          ? '未能更新这份定时草稿，请在「定时任务」中查看当前状态后再试。'
          : '未能确认创建结果，请在「定时任务」中查看后再试。' }
      }
      if (options.isCurrent() && receipt.status !== 'needs_context') await options.receipt(receipt)
      return receipt
    })()
    const pending = operation
    const result = await pending
    if (result.status === 'needs_context' && operation === pending) operation = undefined
    return result
  }
}
