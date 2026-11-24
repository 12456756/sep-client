import type { ArrangementPermissionPreset } from '../../shared/types'
import { DEFAULT_CONVERSATION_PERMISSION, RUN_PERMISSIONS } from './run-settings'

export interface ConversationPermissionScope { enterpriseId: string; memberId: string }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>

export function conversationPermissionKey({ enterpriseId, memberId }: ConversationPermissionScope): string | null {
  if (!enterpriseId.trim() || !memberId.trim()) return null
  return `sep.default-conversation-permission.v1:${JSON.stringify([enterpriseId, memberId])}`
}

export function readConversationPermission(storage: StoragePort | null, key: string | null): ArrangementPermissionPreset {
  if (!storage || !key) return DEFAULT_CONVERSATION_PERMISSION
  try {
    const stored = storage.getItem(key)
    return RUN_PERMISSIONS.find(option => option.id === stored)?.id ?? DEFAULT_CONVERSATION_PERMISSION
  } catch { return DEFAULT_CONVERSATION_PERMISSION }
}

export function saveConversationPermission(storage: StoragePort | null, key: string | null, preset: ArrangementPermissionPreset): boolean {
  if (!storage || !key || !RUN_PERMISSIONS.some(option => option.id === preset)) return false
  try { storage.setItem(key, preset); return true } catch { return false }
}
