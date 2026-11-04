import { useCallback, useEffect, useRef, useState } from 'react'
import { conversationQueueViewSchema, type ConversationQueueView } from '../../shared/conversation-queue'
import { responseError } from '../../shared/arrangement-feedback'
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback'

export function useConversationQueue(taskId: string, scopeKey: string) {
  const [queue, setQueue] = useState<ConversationQueueView>({ paused: false, items: [], failed: null })
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const request = useRef(0)
  const resuming = useRef(false)
  const { capture } = useOperationFeedback(`${scopeKey}:${taskId}`)
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
  const resume = useCallback(async () => {
    if (resuming.current) return
    resuming.current = true
    const version = generation.current, sequence = ++request.current, notice = capture()
    setBusy(true)
    try {
      const result = await window.electronAPI.conversationQueue({ taskId, action: 'resume' })
      if (version !== generation.current || !notice.isCurrent()) return
      if (!result.success) throw responseError(result, 'workRetry')
      if (sequence === request.current) setQueue(conversationQueueViewSchema.parse(result.queue))
      else await refresh()
    } catch (error) { if (version === generation.current && notice.isCurrent()) notice.fail(error, 'workRetry') }
    finally { if (version === generation.current) { resuming.current = false; setBusy(false) } }
  }, [taskId, capture, refresh])
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
  return { queue, busy, refresh, resume, prioritize }
}
