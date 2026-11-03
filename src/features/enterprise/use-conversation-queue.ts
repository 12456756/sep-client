import { useCallback, useEffect, useRef, useState } from 'react'
import { conversationQueueViewSchema, type ConversationQueueView } from '../../shared/conversation-queue'
import { feedbackMessage, responseError } from '../../shared/arrangement-feedback'
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback'
import { useFeedback } from '../../components/feedback/FeedbackProvider'

export function useConversationQueue(taskId: string, scopeKey: string) {
  const [queue, setQueue] = useState<ConversationQueueView>({ paused: false, items: [], failed: null })
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const request = useRef(0)
  const resuming = useRef(false)
  const { capture } = useOperationFeedback(`${scopeKey}:${taskId}`)
  const feedback = useFeedback()
  const failedRead = useRef(false)
  const refresh = useCallback(async () => {
    const version = generation.current, sequence = ++request.current, notice = capture()
    try {
      const result = await window.electronAPI.conversationQueue({ taskId, action: 'get' })
      if (version !== generation.current || sequence !== request.current || !notice.isCurrent()) return
      if (!result.success) throw responseError(result, 'workSend')
      setQueue(conversationQueueViewSchema.parse(result.queue))
      failedRead.current = false
    } catch (error) {
      if (version !== generation.current || sequence !== request.current || !notice.isCurrent() || failedRead.current) return
      failedRead.current = true
      notice.fail(error, 'workMessages')
    }
  }, [taskId, capture])
  const invalidate = useCallback(() => { generation.current++ }, [])
  useEffect(() => {
    let active = true
    setQueue({ paused: false, items: [], failed: null })
    setBusy(false)
    resuming.current = false
    failedRead.current = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => { await refresh(); if (active) timer = setTimeout(poll, 1000) }
    void poll()
    return () => { active = false; invalidate(); if (timer) clearTimeout(timer) }
  }, [refresh, scopeKey, invalidate])
  const resume = useCallback(async (messageId?: string): Promise<{ success: boolean; message?: string }> => {
    if (resuming.current) return { success: false }
    resuming.current = true
    const version = generation.current, sequence = ++request.current, notice = capture()
    setBusy(true)
    try {
      const result = await window.electronAPI.conversationQueue(messageId
        ? { taskId, action: 'recover', messageId, confirmRecovery: true }
        : { taskId, action: 'resume' })
      if (version !== generation.current || !notice.isCurrent()) return { success: false }
      if (!result.success) throw responseError(result, 'workRetry')
      if (sequence === request.current) setQueue(conversationQueueViewSchema.parse(result.queue))
      else await refresh()
      return { success: true }
    } catch (error) {
      if (version === generation.current && notice.isCurrent()) {
        if (messageId) return { success: false, message: feedbackMessage(error, 'workRetry') }
        notice.fail(error, 'workRetry')
      }
      return { success: false }
    }
    finally { if (version === generation.current) { resuming.current = false; setBusy(false) } }
  }, [taskId, capture, refresh])
  const recover = useCallback(async () => {
    const failed = queue.failed, notice = capture()
    if (!failed?.recoveryConfirmationRequired) return
    await feedback.confirm({
      key: `conversation-recovery:${scopeKey}:${taskId}:${failed.id}`,
      message: '会话文件已损坏，将根据已保存的任务历史重建上下文，部分上下文可能无法还原。确认后重试这条消息并继续处理后续信息。',
      actionLabel: '确认重建并继续', busyLabel: '正在重建',
      onConfirm: () => notice.isCurrent() ? resume(failed.id) : Promise.resolve({ success: false }),
    })
  }, [queue.failed, capture, feedback, scopeKey, taskId, resume])
  return { queue, busy, refresh, resume: () => resume(), recover }
}
