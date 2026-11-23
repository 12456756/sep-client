import { createHash } from 'node:crypto'
import {
  type ConversationScheduleReceipt, type ScheduledCreationRequest,
} from '../../src/shared/scheduled-creation'
import type { ScheduleInput } from '../../src/shared/scheduled-tasks'
import type { ConversationScheduleTool } from '../pi/sdk/pi-conversation-schedule'

export type SubmitConversationSchedule = (request: ScheduledCreationRequest, review: {
  signal: AbortSignal; receivedAt: number; approve(input: ScheduleInput): Promise<boolean>
}) => Promise<ConversationScheduleReceipt>

/** A queued message keeps its identity on retry even when its execution run changes. */
export function conversationScheduleRequestId(taskId: string, messageId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['conversation-schedule', taskId, messageId])).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function bindConversationSchedule(options: {
  submit: SubmitConversationSchedule
  taskId: string; messageId: string; userMessage: string; receivedAt: number
  workDir: string; modelId: string; signal: AbortSignal; isCurrent(): boolean
  approve(input: ScheduleInput): Promise<boolean>
  receipt(receipt: ConversationScheduleReceipt): Promise<void>
}): ConversationScheduleTool {
  const message = options.userMessage.trim()
  let operation: Promise<ConversationScheduleReceipt> | undefined
  return async toolSignal => {
    const signal = toolSignal ? AbortSignal.any([options.signal, toolSignal]) : options.signal
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (!options.isCurrent()) throw new Error('Conversation turn is no longer active.')
    }
    assertCurrent()
    if (!message.split('\n').some(line => line.trim() && !/^\s*>/.test(line)) || /^(```|~~~)/.test(message)) {
      return { status: 'blocked', message: '请在会话正文中直接说明要定时执行的工作和开始时间。' }
    }
    operation ??= (async () => {
      await options.receipt({ status: 'pending' })
      let receipt: ConversationScheduleReceipt
      try {
        assertCurrent()
        receipt = await options.submit({
          requestId: conversationScheduleRequestId(options.taskId, options.messageId),
          message, modelId: options.modelId, workDir: options.workDir,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' },
        }, { signal, receivedAt: options.receivedAt, approve: async input => {
          assertCurrent()
          const approved = await options.approve(input)
          assertCurrent()
          return approved
        } })
      } catch {
        receipt = { status: signal.aborted ? 'cancelled' : 'failed', message: '未能确认创建结果，请在「定时任务」中查看后再试。' }
      }
      if (options.isCurrent()) await options.receipt(receipt)
      return receipt
    })()
    return operation
  }
}
