import { createHash } from 'node:crypto'
import {
  CONVERSATION_SCHEDULE_EVENT, conversationScheduleReceiptSchema,
  formatScheduleReceiptTime, type ConversationScheduleDraft, type ConversationScheduleReceipt, type ScheduledCreationRequest, type ScheduleInterpretation,
} from '../../src/shared/scheduled-creation'
import type { ScheduleInput } from '../../src/shared/scheduled-tasks'
import type { ConversationScheduleTool } from '../pi/sdk/pi-conversation-schedule'
import type { ConversationMessage } from '../domain/conversation-context'
import type { TaskExecutionEvent } from '../../src/shared/types'
import { conversationScheduleClock } from '../domain/scheduled-creation'

export type SubmitConversationSchedule = (request: ScheduledCreationRequest, review: {
  signal: AbortSignal; receivedAt: number; approve(input: ScheduleInput): Promise<boolean | 'revise_time'>
  candidate?: ScheduleInterpretation; resumeDrafts?: ConversationScheduleDraft[]
}) => Promise<ConversationScheduleReceipt>

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

export async function conversationScheduleReceipt(previous: ConversationMessage, timeline: (runId: string) => Promise<TaskExecutionEvent[]>): Promise<ConversationScheduleReceipt | undefined> {
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
  approve(input: ScheduleInput): Promise<boolean | 'revise_time'>
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
    if (!message.split('\n').some(line => line.trim() && !/^\s*>/.test(line)) || /^(```|~~~)/.test(message)) {
      return { status: 'blocked', message: '请在会话正文中直接说明要定时执行的工作和开始时间。' }
    }
    if (!options.draft && input?.action !== 'resume' && isConversationScheduleTimeReply(message)) {
      return { status: 'blocked', message: '这条消息没有对应的待补充定时草稿。请说明要定时执行的工作。' }
    }
    operation ??= (async () => {
      await options.receipt({ status: 'pending' })
      let receipt: ConversationScheduleReceipt
      try {
        assertCurrent()
        const resumeDrafts = input?.action === 'resume' ? await options.resumeDrafts?.() ?? [] : undefined
        assertCurrent()
        const draft = input?.action ? undefined : options.draft
        receipt = await options.submit({
          requestId: draft?.id ?? conversationScheduleRequestId(options.taskId, options.messageId),
          ...(draft ? { expectedRevision: draft.revision } : {}),
          message, modelId: options.modelId, workDir: options.workDir,
          ...(options.parserSubscriptionId ? { parserSubscriptionId: options.parserSubscriptionId } : {}),
          timezone,
          permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' },
        }, { signal, receivedAt: options.receivedAt, candidate: input?.candidate, resumeDrafts, approve: async input => {
          assertCurrent()
          const approved = await options.approve(input)
          assertCurrent()
          return approved
        } })
      } catch {
        receipt = { status: signal.aborted ? 'cancelled' : 'failed', message: options.draft || input?.action === 'resume'
          ? '未能更新这份定时草稿，请在「定时任务」中查看当前状态后再试。'
          : '未能确认创建结果，请在「定时任务」中查看后再试。' }
      }
      if (options.isCurrent()) await options.receipt(receipt)
      return receipt
    })()
    return operation
  }
}
