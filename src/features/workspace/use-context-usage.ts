import { useEffect, useState } from 'react'
import { contextUsageSchema, type ContextUsage } from '../../shared/context-usage'
import type { TaskExecutionEvent } from '../../shared/types'

function readUsage(event: TaskExecutionEvent): ContextUsage | null {
  if (event.type !== 'context_usage') return null
  const parsed = contextUsageSchema.safeParse(event.data)
  return parsed.success ? parsed.data : null
}

export function useContextUsage(taskId: string | undefined, scopeKey = ''): ContextUsage | null {
  const key = JSON.stringify([scopeKey, taskId ?? ''])
  const [snapshot, setSnapshot] = useState<{ key: string; value: ContextUsage | null }>({ key: '', value: null })

  useEffect(() => {
    if (!taskId) return
    let active = true
    let receivedLiveUsage = false
    const update = (value: ContextUsage) => setSnapshot({ key, value })
    const unsubscribe = window.electronAPI.onPiEvent(event => {
      if (!active || event.taskId !== taskId) return
      const usage = readUsage(event)
      if (usage) { receivedLiveUsage = true; update(usage) }
    })

    void (async () => {
      try {
        const result = await window.electronAPI.getTaskContextUsage(taskId)
        if (!active || receivedLiveUsage || !result.success) return
        const parsed = contextUsageSchema.safeParse(result.usage)
        if (parsed.success) update(parsed.data)
      } catch { /* Keep the live or unknown state when history is unavailable. */ }
    })()

    return () => { active = false; unsubscribe() }
  }, [key, taskId])

  return snapshot.key === key ? snapshot.value : null
}
