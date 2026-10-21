import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KnowledgeData } from '../../shared/knowledge-contracts'
import { KnowledgeClient, isKnowledgeCancelled, type KnowledgeCommand } from './knowledge-client'

export function useKnowledgeClient(): { client: KnowledgeClient; pending: number } {
  const client = useMemo(() => new KnowledgeClient(window.electronAPI), [])
  const [pending, setPending] = useState(0)
  useEffect(() => {
    client.onChange = setPending
    return () => { client.onChange = undefined; client.cancelAll() }
  }, [client])
  return { client, pending }
}
export function useKnowledgeQuery<R extends KnowledgeCommand>(client: KnowledgeClient, input: R | null, revision = 0) {
  const group = useId()
  const key = JSON.stringify(input)
  const [state, setState] = useState<{ data: KnowledgeData<R['action']> | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: !!input })
  useEffect(() => {
    if (key === 'null') { setState({ data: null, error: null, loading: false }); return }
    let active = true
    setState({ data: null, error: null, loading: true })
    void client.run(JSON.parse(key) as R, group).then(data => {
      if (active) setState({ data, error: null, loading: false })
    }).catch((error: unknown) => {
      if (active) setState({ data: null, error: isKnowledgeCancelled(error) ? null : error, loading: false })
    })
    return () => { active = false; client.cancelGroup(group) }
  }, [client, group, key, revision])
  return state
}
export function useKnowledgeMutation() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const locked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function perform(work: () => Promise<void>): Promise<boolean> {
    if (locked.current) return false
    locked.current = true; setBusy(true); setError(null)
    try { await work(); return mounted.current } catch (reason) {
      if (mounted.current && !isKnowledgeCancelled(reason)) setError(reason)
      return false
    } finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  return { busy, error, clearError: () => setError(null), perform }
}
