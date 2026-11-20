import { attachmentRefSchema, type AttachmentRef } from '../../src/shared/attachment-contracts'
import type { AttachmentInputPort, ConversationAttachmentReader, ResolvedAttachmentInput } from '../domain/attachment-input'
import type { ConversationMessage } from '../domain/conversation-context'
import type { TaskOwnerScope } from '../data/scope-path'

export async function prepareConversationAttachments(input: {
  store: AttachmentInputPort
  scope: TaskOwnerScope
  taskId: string
  messages: readonly ConversationMessage[]
  current: readonly ResolvedAttachmentInput[]
  assertActive: (signal?: AbortSignal) => void
  canRead: (item: ResolvedAttachmentInput) => boolean
  allowsImages: boolean
}): Promise<{ history: ResolvedAttachmentInput[]; reader?: ConversationAttachmentReader }> {
  const { store, scope, taskId, current, assertActive } = input
  const currentById = new Map(current.map(item => [item.attachmentId, item]))
  const entries = new Map<string, { ref: AttachmentRef; messageNumber: number }>()
  let messageNumber = 0
  for (const message of input.messages) {
    if (message.taskId !== taskId || message.role !== 'user') continue
    messageNumber++
    for (const raw of Array.isArray(message.attachmentRefs) ? message.attachmentRefs : []) {
      const ref = attachmentRefSchema.safeParse(raw)
      if (ref.success && !entries.has(ref.data.attachmentId)) entries.set(ref.data.attachmentId, { ref: ref.data, messageNumber })
    }
  }
  for (const item of current) {
    if (!entries.has(item.attachmentId)) entries.set(item.attachmentId, { ref: { attachmentId: item.attachmentId, sha256: item.sha256 }, messageNumber: messageNumber + 1 })
  }
  const historicalRefs = [...entries.values()].map(entry => entry.ref).filter(ref => !currentById.has(ref.attachmentId))
  const history = historicalRefs.length ? await store.describeTaskInputs(scope, taskId, historicalRefs) : []
  assertActive()
  const byId = new Map([...history, ...current].map(item => [item.attachmentId, item]))
  if (!byId.size) return { history }
  let imageNumber = 0
  const files = [...entries.values()].flatMap(({ ref, messageNumber }) => {
    const item = byId.get(ref.attachmentId)
    if (!item) return []
    const number = item.mediaType.startsWith('image/') ? ++imageNumber : undefined
    if (!input.canRead(item)) return []
    return [{ attachmentId: item.attachmentId, name: item.displayName, mediaType: item.mediaType, messageNumber, imageNumber: number }]
  })
  const visible = new Set(files.map(file => file.attachmentId))
  return { history, reader: files.length ? {
    list(offset) {
      assertActive()
      const page = files.slice(offset, offset + 30)
      return { files: page, nextOffset: offset + page.length < files.length ? offset + page.length : null }
    },
    async read(id, offset, signal) {
      assertActive(signal)
      const item = visible.has(id) ? byId.get(id) : undefined
      if (!item || !input.canRead(item)) throw new Error('Attachment is not available in this conversation.')
      const ref: AttachmentRef = { attachmentId: id, sha256: item.sha256 }
      let resolved: Awaited<ReturnType<AttachmentInputPort['resolveTaskInputs']>>
      try { resolved = await store.resolveTaskInputs(scope, taskId, [ref]) }
      catch {
        assertActive(signal)
        throw new Error('The attachment snapshot is missing or failed verification.')
      }
      assertActive(signal)
      const attachment = resolved.attachments[0]!
      const text = attachment.extractedText ?? ''
      const chunk = text.slice(offset, offset + 8000)
      const image = input.allowsImages && !offset ? resolved.images[0] : undefined
      return {
        text: JSON.stringify({ attachmentId: id, name: attachment.displayName, mediaType: attachment.mediaType,
          extractionStatus: attachment.extractionStatus, offset, text: chunk,
          nextOffset: offset + chunk.length < text.length ? offset + chunk.length : null,
          ...(!offset && !item.mediaType.startsWith('image/') && attachment.readPath ? { readOnlyPath: attachment.readPath } : {}),
          ...(item.mediaType.startsWith('image/') && !input.allowsImages ? { imageUnavailable: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } : {}),
        }),
        ...(image ? { image: { data: Buffer.from(image.bytes).toString('base64'), mimeType: image.mediaType } } : {}),
      }
    },
  } : undefined }
}
