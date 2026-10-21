import { useEffect, useId, useState } from 'react'
import type { KnowledgeDocument } from '../../shared/knowledge-contracts'
import { documentPresentation, isKnowledgeCancelled, KnowledgeClientError, processingDelay, type KnowledgeClient } from './knowledge-client'

export function useKnowledgeDocuments(client: KnowledgeClient, kbId: string, revision: number) {
  const group = useId()
  const [state, setState] = useState<{ data: KnowledgeDocument[]; loading: boolean; error: unknown; expired: boolean }>({ data: [], loading: true, error: null, expired: false })
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let docs: KnowledgeDocument[] = []
    let round = 0
    const startedAt = Date.now()
    const groups = new Set<string>([group])
    const poll = async (): Promise<void> => {
      if (!active) return
      if (Date.now() - startedAt >= 10 * 60_000) { setState(current => ({ ...current, expired: true })); return }
      const processing = docs.filter(doc => documentPresentation(doc).processing)
      if (!processing.length) return
      try {
        // Bound parallel detail reads; the API independently obeys platform Retry-After.
        const updated = new Map<string, KnowledgeDocument | null>()
        for (let index = 0; active && index < processing.length; index += 3) {
          await Promise.all(processing.slice(index, index + 3).map(async doc => {
            const key = group + ':' + doc.id; groups.add(key)
            try { updated.set(doc.id, await client.run({ action: 'getDocument', kbId, docId: doc.id }, key)) }
            catch (error) {
              if (error instanceof KnowledgeClientError && error.detail.statusCode === 404) updated.set(doc.id, null)
              else throw error
            }
          }))
        }
        if (!active) return
        docs = docs.flatMap(doc => updated.has(doc.id) ? updated.get(doc.id) ? [updated.get(doc.id)!] : [] : [doc])
        setState({ data: docs, loading: false, error: null, expired: false })
        if (docs.some(doc => documentPresentation(doc).processing)) timer = setTimeout(() => void poll(), processingDelay(++round))
      } catch (error) {
        if (active && !isKnowledgeCancelled(error)) setState(current => ({ ...current, data: error instanceof KnowledgeClientError && [403, 404].includes(error.detail.statusCode ?? 0) ? [] : current.data, loading: false, error }))
      }
    }
    setState({ data: [], loading: true, error: null, expired: false })
    void client.run({ action: 'documents', kbId }, group).then(result => {
      if (!active) return
      docs = result
      setState({ data: docs, loading: false, error: null, expired: false })
      if (docs.some(doc => documentPresentation(doc).processing)) timer = setTimeout(() => void poll(), processingDelay(0))
    }).catch(error => { if (active) setState({ data: [], loading: false, error: isKnowledgeCancelled(error) ? null : error, expired: false }) })
    return () => { active = false; clearTimeout(timer); for (const id of groups) client.cancelGroup(id) }
  }, [client, group, kbId, revision])
  return state
}
