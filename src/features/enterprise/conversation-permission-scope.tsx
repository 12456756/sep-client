import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ArrangementPermissionPreset } from '../../shared/types'
import { conversationPermissionKey, readConversationPermission, saveConversationPermission, type ConversationPermissionScope } from './conversation-permission-preference'
import { DEFAULT_CONVERSATION_PERMISSION } from './run-settings'

interface ConversationPermissionPreference {
  preset: ArrangementPermissionPreset
  error: string | null
  save: (preset: ArrangementPermissionPreset) => void
}

const ConversationPermissionContext = createContext<ConversationPermissionPreference>({ preset: DEFAULT_CONVERSATION_PERMISSION, error: null, save: () => {} })

function preferenceStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function ConversationPermissionProvider({ scope, children }: { scope: ConversationPermissionScope; children: ReactNode }) {
  const key = conversationPermissionKey(scope)
  return <ScopedConversationPermission key={key} storageKey={key}>{children}</ScopedConversationPermission>
}

function ScopedConversationPermission({ storageKey, children }: { storageKey: string | null; children: ReactNode }) {
  const [preset, setPreset] = useState(() => readConversationPermission(preferenceStorage(), storageKey))
  const [error, setError] = useState<string | null>(null)
  const save = (next: ArrangementPermissionPreset) => {
    if (!saveConversationPermission(preferenceStorage(), storageKey, next)) {
      setError('新会话默认权限保存失败，请重试。')
      return
    }
    setPreset(next)
    setError(null)
  }
  return <ConversationPermissionContext.Provider value={{ preset, error, save }}>{children}</ConversationPermissionContext.Provider>
}

export function useConversationPermissionPreference(): ConversationPermissionPreference {
  return useContext(ConversationPermissionContext)
}
