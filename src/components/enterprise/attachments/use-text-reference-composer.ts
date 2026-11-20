import { useRef, useState, type RefObject } from 'react'
import { referenceFileLimit, type ReferenceAttachmentSelection } from '../../../shared/attachment-contracts'
import { useAttachmentComposer, type RetainedAttachmentState } from '../../../features/enterprise/use-attachment-composer'
import { useFileMention } from './FileMentionPicker'
import type { AttachmentComposerOperations } from './AttachmentComposer'

interface Options {
  input: RefObject<HTMLTextAreaElement | null>
  value: string
  update(value: string): void
  bindingKey: string
  disabled: boolean
  retained?: RetainedAttachmentState
}

export function useTextReferenceComposer({ input, value, update, bindingKey, disabled, retained }: Options) {
  const composerId = useRef(retained?.session?.target.kind === 'compose' ? retained.session.target.composerId : `reference-${crypto.randomUUID()}`)
  const [error, setError] = useState('')
  const composer = useAttachmentComposer({ target: { kind: 'compose', composerId: composerId.current }, bindingKey, disabled, retainedState: retained, onError: setError })
  const operations = useRef<AttachmentComposerOperations | null>(null)
  operations.current = { select: async single => { setError(''); return composer.select(single) }, addFile: composer.addFile }
  const mention = useFileMention({ input, text: value, update, attachments: composer.attachments,
    attachmentSessionId: composer.session?.sessionId, operations, disabled: disabled || composer.busy, memory: retained ? retained.fileMentions ??= {} : undefined })
  const unsupported = mention.attachments.find(item => !['ready', 'partial'].includes(item.extractionStatus) || !item.extractionSummary?.trim())
  const overlength = input.current && input.current.maxLength >= 0 && mention.submissionText.trim().length > input.current.maxLength
  const invalid = mention.invalid || mention.attachments.length > referenceFileLimit || Boolean(unsupported) || Boolean(overlength) || (mention.attachments.length > 0 && !composer.session)
  const referenceFiles: ReferenceAttachmentSelection | undefined = mention.attachments.length && composer.session ? {
    sessionId: composer.session.sessionId, attachments: mention.attachments.map(({ attachmentId, sha256 }) => ({ attachmentId, sha256 })),
  } : undefined
  return { mention, referenceFiles, blocked: composer.busy || mention.pending || invalid,
    error: error || (unsupported ? `无法读取「${unsupported.displayName}」的文本，请删除该引用或更换可提取文本的文件。`
      : mention.attachments.length > referenceFileLimit ? `最多引用 ${referenceFileLimit} 份文件。` : overlength ? '引用后的内容过长，请缩短正文。' : '') }
}
