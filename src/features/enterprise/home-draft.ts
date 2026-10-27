import { useEffect, useState } from 'react'
import { GENERAL_ASSISTANT_ID } from './general-assistant'
import type { RetainedAttachmentState } from './use-attachment-composer'

/** One mutable editor buffer belongs to one mounted authenticated workspace. */
export interface HomeDraft {
  text: string
  employeeId: string
  context: string
  composerId: string
  epoch: number
  attachment: RetainedAttachmentState
}

export function createHomeDraft(): HomeDraft {
  return {
    text: '', employeeId: GENERAL_ASSISTANT_ID, context: '',
    composerId: `home-${crypto.randomUUID()}`, epoch: 0,
    attachment: { session: null, attachments: [] },
  }
}

/** Survives page navigation; releases unclaimed imports when the login scope ends. */
export function useHomeDraftOwner(): HomeDraft {
  const [owner] = useState(() => ({ draft: createHomeDraft(), revision: 0 }))
  useEffect(() => {
    const revision = ++owner.revision
    return () => queueMicrotask(() => {
      if (revision !== owner.revision) return
      const session = owner.draft.attachment.session
      if (session?.status === 'open') {
        void window.electronAPI.cancelAttachmentImport({ sessionId: session.sessionId }).catch(() => undefined)
      }
      owner.draft.text = ''
      owner.draft.context = ''
      owner.draft.attachment.session = null
      owner.draft.attachment.attachments = []
    })
  }, [owner])
  return owner.draft
}

export function homeMessage(text: string, context: string): string {
  const goal = text.trim()
  const background = context.trim()
  return background ? `${goal}\n\n补充上下文：\n${background}` : goal
}
