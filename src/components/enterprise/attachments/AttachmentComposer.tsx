import { Paperclip, RotateCw, X } from 'lucide-react'
import { useEffect } from 'react'
import type { AttachmentImportSession, AttachmentImportTarget, AttachmentView } from '../../../shared/attachment-contracts'
import { useAttachmentComposer } from '../../../features/enterprise/use-attachment-composer'

interface Props {
  target: AttachmentImportTarget
  bindingKey?: string
  disabled?: boolean
  onChange?: (attachments: AttachmentView[]) => void
  onSessionChange?: (session: AttachmentImportSession | null) => void
  onPasteEdit?: (input: { operationId: string; composerId: string; text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => boolean
  onPasteImported?: (operationId: string, attachments: AttachmentView[]) => void
  onPasteStarted?: (operationId: string) => void
  onSelectStarted?: () => void
  onSelectFinished?: (attachments: AttachmentView[] | null) => void
  onBusyChange?: (busy: boolean) => void
}

export function AttachmentComposer({ target, bindingKey, disabled = false, onChange, onSessionChange, onPasteEdit, onPasteImported, onPasteStarted, onSelectStarted, onSelectFinished, onBusyChange }: Props) {
  const composer = useAttachmentComposer({ target, bindingKey, disabled, onPasteEdit, onPasteImported, onPasteStarted, onSelectStarted, onSelectFinished })
  const attachments = composer.attachments
  useEffect(() => { onChange?.(attachments) }, [attachments, onChange])
  useEffect(() => { onSessionChange?.(composer.session) }, [composer.session, onSessionChange])
  useEffect(() => { onBusyChange?.(composer.busy) }, [composer.busy, onBusyChange])
  return (
    <div className="ent-attachment-composer" data-attachment-composer data-composer-id={composer.composerId}>
      {attachments.length ? (
        <div className="ent-attachment-list" aria-label="已添加附件">
          {attachments.map(item => (
            <div className="ent-attachment-item" key={item.attachmentId}>
              <span className="ent-attachment-name" title={item.displayName}>{item.displayName}</span>
              <small>{formatBytes(item.byteLength)} · {statusLabel(item.extractionStatus)}</small>
              <button type="button" className="ent-icon-btn" aria-label={`移除 ${item.displayName}`} onClick={() => void composer.remove(item.attachmentId)} disabled={disabled}>
                <X size={13} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <button type="button" className="ent-attachment-button" onClick={() => void composer.select()} disabled={disabled || composer.busy} title="添加附件">
        <Paperclip size={15} aria-hidden />
        <span>{composer.busy ? '处理中…' : '添加附件'}</span>
      </button>
      {composer.error ? <span className="ent-attachment-error" role="alert">{composer.error}<button type="button" onClick={() => composer.setError(null)} aria-label="关闭错误"><RotateCw size={12} aria-hidden /></button></span> : null}
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

