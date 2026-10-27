import { FileText, LoaderCircle, Paperclip, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { AttachmentImportSession, AttachmentImportTarget, AttachmentView } from '../../../shared/attachment-contracts'
import { useAttachmentComposer, type RetainedAttachmentState } from '../../../features/enterprise/use-attachment-composer'
import { useOperationFeedback } from '../../feedback/use-operation-feedback'

interface Props {
  target: AttachmentImportTarget
  bindingKey?: string
  disabled?: boolean
  retainedState?: RetainedAttachmentState
  onChange?: (attachments: AttachmentView[]) => void
  onSessionChange?: (session: AttachmentImportSession | null) => void
  onPasteEdit?: (input: { operationId: string; composerId: string; text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => boolean
  onPasteImported?: (operationId: string, attachments: AttachmentView[]) => void
  onPasteStarted?: (operationId: string) => void
  onSelectStarted?: () => void
  onSelectFinished?: (attachments: AttachmentView[] | null) => void
  onBusyChange?: (busy: boolean) => void
  listContainer?: HTMLDivElement | null
}

export function AttachmentComposer({ target, bindingKey, disabled = false, retainedState, onChange, onSessionChange, onPasteEdit, onPasteImported, onPasteStarted, onSelectStarted, onSelectFinished, onBusyChange, listContainer }: Props) {
  const { capture } = useOperationFeedback(bindingKey)
  const notice = capture()
  const composer = useAttachmentComposer({ target, bindingKey, disabled, retainedState, onError: message => notice.show(message), onPasteEdit, onPasteImported, onPasteStarted, onSelectStarted, onSelectFinished })
  const attachments = composer.attachments
  useEffect(() => { onChange?.(attachments) }, [attachments, onChange])
  useEffect(() => { onSessionChange?.(composer.session) }, [composer.session, onSessionChange])
  useEffect(() => { onBusyChange?.(composer.busy) }, [composer.busy, onBusyChange])
  const attachmentList = attachments.length ? (
    <div className={`ent-attachment-list${listContainer ? ' ent-attachment-list-tiles' : ''}`} aria-label="已添加附件">
      {attachments.map(item => (
        <div className="ent-attachment-item" key={item.attachmentId}>
          {listContainer ? <div className="ent-attachment-preview" aria-hidden><FileText size={28} strokeWidth={1.5} /></div> : null}
          <div className="ent-attachment-details">
            <span className="ent-attachment-name" title={item.displayName}>{item.displayName}</span>
            <small>{formatBytes(item.byteLength)} · {statusLabel(item.extractionStatus)}</small>
          </div>
          <button type="button" className="ent-icon-btn" aria-label={`移除 ${item.displayName}`} onClick={() => void composer.remove(item.attachmentId)} disabled={disabled}>
            <X size={13} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  ) : null
  return (
    <div className="ent-attachment-composer" data-attachment-composer data-composer-id={composer.composerId}>
      {listContainer ? createPortal(attachmentList, listContainer) : attachmentList}
      <button type="button" className="ent-attachment-button" onClick={() => void composer.select()} disabled={disabled || composer.busy} title={composer.busy ? '处理中…' : '添加附件'} aria-label={composer.busy ? '附件处理中' : '添加附件'}>
        {composer.busy ? <LoaderCircle size={16} aria-hidden className="ent-attachment-spinner" /> : <Paperclip size={16} aria-hidden />}
      </button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function statusLabel(status: AttachmentView['extractionStatus']): string {
  return ({ pending: '处理中', ready: '已就绪', partial: '部分解析', 'not-required': '待使用', unsupported: '不支持', failed: '失败' } as const)[status]
}

