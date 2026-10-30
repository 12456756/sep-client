import { useCallback, useEffect, useRef } from 'react'
import { useFeedback } from './FeedbackProvider'
import type { FeedbackNotice } from '../../shared/feedback-controller'
import { feedbackMessage, isDraftRevisionConflict, type FeedbackOperation } from '../../shared/arrangement-feedback'

export function useOperationFeedback(bindingKey = '') {
  const feedback = useFeedback()
  const revision = feedback.getRevision()
  const identity = useRef({ bindingKey, revision: feedback.getRevision(), active: true })
  if (identity.current.bindingKey !== bindingKey || identity.current.revision !== feedback.getRevision()) {
    identity.current.active = false
    identity.current = { bindingKey, revision: feedback.getRevision(), active: true }
  }
  useEffect(() => {
    const current = identity.current
    current.active = true
    return () => { current.active = false }
  }, [bindingKey, feedback, revision])
  const capture = useCallback(() => {
    const current = identity.current
    const isCurrent = () => current.active && identity.current === current && current.revision === feedback.getRevision()
    const show = (message: string, tone: FeedbackNotice['tone'] = 'error', key?: string, once = false) => {
      if (isCurrent()) feedback.show({ message, tone, key, once })
    }
    return { isCurrent, show, fail: (error: unknown, operation: FeedbackOperation, key?: string, once = false) => {
      if (!isDraftRevisionConflict(error)) show(feedbackMessage(error, operation), 'error', key, once)
    } }
  }, [feedback])
  return { capture }
}
