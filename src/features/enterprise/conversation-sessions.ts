import { createContext } from 'react'
import type { RetainedAttachmentState } from './use-attachment-composer'
import type { KnowledgeSelection } from '../../shared/knowledge-selection'

export interface ConversationSessionState {
  draft: string
  knowledge?: KnowledgeSelection
  attachment: RetainedAttachmentState
  scrollTop: number
  followsLatest: boolean
  revision: number
  attachmentEpoch: number
  subscribe: (listener: () => void) => () => void
  setDraft: (draft: string) => void
  setKnowledge: (knowledge: KnowledgeSelection) => void
  acceptSend: (sentDraft: string) => void
}

/** Memory belongs to one mounted login scope, never to the renderer module. */
export function createConversationSessions(cancelSession: (sessionId: string) => void) {
  const entries = new Map<string, ConversationSessionState>()
  let ownerEpoch = 0
  const remove = (workId: string) => {
    const session = entries.get(workId)?.attachment.session
    if (session?.status === 'open') cancelSession(session.sessionId)
    entries.delete(workId)
  }
  const clear = () => { for (const workId of entries.keys()) remove(workId) }
  return {
    // Effect replay reacquires the owner before the queued cleanup can run.
    retainOwner(): () => void {
      const epoch = ++ownerEpoch
      return () => queueMicrotask(() => { if (ownerEpoch === epoch) clear() })
    },
    get(workId: string): ConversationSessionState {
      let entry = entries.get(workId)
      if (!entry) {
        const listeners = new Set<() => void>()
        const notify = () => { current.revision++; listeners.forEach(listener => listener()) }
        const current: ConversationSessionState = {
          draft: '', attachment: { session: null, attachments: [] }, scrollTop: 0, followsLatest: true,
          revision: 0, attachmentEpoch: 0,
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
          setDraft(draft) { if (current.draft === draft) return; current.draft = draft; notify() },
          setKnowledge(knowledge) { current.knowledge = knowledge; notify() },
          acceptSend(sentDraft) {
            if (current.draft === sentDraft) current.draft = ''
            current.attachment.session = null
            current.attachment.attachments = []
            current.attachmentEpoch++
            if (current.knowledge?.mode === 'manual') current.knowledge = { ...current.knowledge, sources: [] }
            notify()
          },
        }
        entry = current
        entries.set(workId, entry)
      }
      return entry
    },
    retain(workId: string, entry: ConversationSessionState): void { entries.set(workId, entry) },
    remove,
    clear,
  }
}

export type ConversationSessions = ReturnType<typeof createConversationSessions>
export const ConversationSessionsContext = createContext<ConversationSessions | null>(null)
