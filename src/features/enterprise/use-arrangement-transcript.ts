import { useCallback, useEffect, useState } from 'react'
import type { TaskExecutionEvent } from '../../shared/types'
import { mergeTranscriptEvents, selectTranscriptEvent } from './arrangement-transcript'

/** Subscribe before reading disk so a slow history query cannot overwrite live output. */
export function useArrangementTranscript(taskId: string, scopeKey: string) {
  const [snapshot, setSnapshot] = useState<{ key: string; events: TaskExecutionEvent[]; loading: boolean; error: string | null }>({
    key: '', events: [], loading: true, error: null,
  })
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(value => value + 1), [])
  const key = JSON.stringify([scopeKey, taskId])
  useEffect(() => {
    let active = true
    const api = window.electronAPI
    let buffered: TaskExecutionEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const append = (incoming: TaskExecutionEvent[]) => {
      if (!active) return
      setSnapshot(previous => ({ key, loading: previous.key === key ? previous.loading : true,
        error: previous.key === key ? previous.error : null,
        events: mergeTranscriptEvents(previous.key === key ? previous.events : [], incoming) }))
    }
    const flush = () => { timer = undefined; append(buffered); buffered = [] }
    setSnapshot(previous => ({ key, events: previous.key === key ? previous.events : [], loading: true, error: null }))
    const unsubscribe = api.onPiEvent(event => {
      if (!active || event.taskId !== taskId) return
      const selected = selectTranscriptEvent(event)
      if (selected) buffered.push(selected)
      if (!timer && buffered.length) timer = setTimeout(flush, 80)
    })
    void (async () => {
      try {
        const runs = await api.listTaskRuns(taskId)
        if (!active) return
        if (!runs.success) throw new Error(runs.error?.message || '执行过程加载失败')
        const list = runs.runs ?? []
        // Bound concurrent disk queries for tasks with many prior node attempts.
        let cursor = 0
        const read = async () => {
          while (active && cursor < list.length) {
            const run = list[cursor++]
            const result = await api.getTaskTimeline(taskId, run.id)
            if (!active) return
            if (!result.success) throw new Error(result.error?.message || '执行过程加载失败')
            append((result.events ?? []).flatMap(event => {
              if (event.taskId !== taskId) return []
              const selected = selectTranscriptEvent(event)
              return selected ? [selected] : []
            }))
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, list.length) }, read))
        if (active) setSnapshot(previous => ({ ...previous, loading: false }))
      } catch (cause) {
        if (active) setSnapshot(previous => ({ ...previous, loading: false, error: cause instanceof Error ? cause.message : '执行过程加载失败' }))
      }
    })()
    return () => { active = false; unsubscribe(); clearTimeout(timer) }
  }, [key, taskId, revision])
  return { events: snapshot.key === key ? snapshot.events : [], loading: snapshot.key !== key || snapshot.loading,
    error: snapshot.key === key ? snapshot.error : null, reload }
}
