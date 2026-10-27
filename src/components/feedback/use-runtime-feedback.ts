import { useEffect } from 'react'
import { useFeedback } from './FeedbackProvider'
import { createRuntimeFailureListener } from '../../shared/runtime-feedback'

export function useRuntimeFeedback(memberId: string, enterpriseId: string): void {
  const feedback = useFeedback()
  const revision = feedback.getRevision()
  useEffect(() => {
    const listener = createRuntimeFailureListener(feedback, { memberId, enterpriseId })
    const unsubscribe = window.electronAPI.onPiEvent(listener.receive)
    return () => { listener.dispose(); unsubscribe() }
  }, [feedback, memberId, enterpriseId, revision])
}
