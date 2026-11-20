import { useCallback, useEffect, useRef, useState } from 'react'
import { conversationQueueViewSchema, type ConversationQueueInput, type ConversationQueueView } from '../../shared/conversation-queue'
import { feedbackMessage, responseError, type FeedbackOperation } from '../../shared/arrangement-feedback'
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
      if (!result.success) throw responseError(result, 'workQueueRead')
      setQueue(conversationQueueViewSchema.parse(result.queue))
      failedRead.current = false
    } catch (error) {
      if (version !== generation.current || sequence !== request.current || !notice.isCurrent() || failedRead.current) return
      failedRead.current = true
      notice.fail(error, 'workQueueRead')
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
  const changeQueue = useCallback(async (input: ConversationQueueInput, operation: FeedbackOperation, inConfirmation = false): Promise<{ success: boolean; message?: string }> => {
    if (resuming.current) return { success: false }
    resuming.current = true
    const version = generation.current, sequence = ++request.current, notice = capture()
    setBusy(true)
    try {
      const result = await window.electronAPI.conversationQueue(input)
      if (version !== generation.current || !notice.isCurrent()) return { success: false }
      if (!result.success) throw responseError(result, operation)
      if (sequence === request.current) setQueue(conversationQueueViewSchema.parse(result.queue))
      else await refresh()
      return { success: true }
    } catch (error) {
      if (version === generation.current && notice.isCurrent()) {
        if (inConfirmation) return { success: false, message: feedbackMessage(error, operation) }
        notice.fail(error, operation)
      }
      return { success: false }
    }
    finally { if (version === generation.current) { resuming.current = false; setBusy(false) } }
  }, [capture, refresh])
  const prioritize = useCallback(async (entryId: string) => {
    if (resuming.current) return
    resuming.current = true
    const version = generation.current, notice = capture()
    setBusy(true)
    try {
      const result = await window.electronAPI.conversationQueue({ taskId, action: 'prioritize', entryId })
      if (version !== generation.current || !notice.isCurrent()) return
      if (!result.success) throw responseError(result, 'workRetry')
      setQueue(conversationQueueViewSchema.parse(result.queue))
    } catch (error) { if (version === generation.current && notice.isCurrent()) notice.fail(error, 'workRetry') }
    finally { if (version === generation.current) { resuming.current = false; setBusy(false) } }
  }, [taskId, capture])
  const recover = useCallback(async () => {
    const failed = queue.failed, notice = capture()
    if (!failed?.recoveryConfirmationRequired) return
    await feedback.confirm({
      key: `conversation-recovery:${scopeKey}:${taskId}:${failed.id}`,
      message: '会话文件已损坏，将根据已保存的任务历史重建上下文，部分上下文可能无法还原。确认后重试这条消息并继续处理后续信息。',
      actionLabel: '确认重建并继续', busyLabel: '正在重建',
      onConfirm: () => notice.isCurrent()
        ? changeQueue({ taskId, action: 'recover', messageId: failed.id, confirmRecovery: true }, 'workRetry', true)
        : Promise.resolve({ success: false }),
    })
  }, [queue.failed, capture, feedback, scopeKey, taskId, changeQueue])
  const skip = useCallback(async () => {
    const { skipToken, items } = queue, notice = capture()
    if (!skipToken) return
    await feedback.confirm({
      key: `conversation-skip:${scopeKey}:${taskId}:${skipToken}`,
      message: `跳过未完成的请求${items.length ? `，并取消 ${items.length} 条等待处理的消息` : ''}？聊天记录和已有产出会保留，这不会取消或重提平台媒体任务。`,
      actionLabel: '跳过并继续', busyLabel: '正在跳过',
      onConfirm: () => notice.isCurrent()
        ? changeQueue({ taskId, action: 'skip', skipToken }, 'workSkip', true)
        : Promise.resolve({ success: false }),
    })
  }, [queue, capture, feedback, scopeKey, taskId, changeQueue])
  return { queue, busy, refresh, resume: () => changeQueue({ taskId, action: 'resume' }, 'workRetry'), recover, prioritize, skip }
}
