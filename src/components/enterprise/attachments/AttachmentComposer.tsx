import * as Dialog from '@radix-ui/react-dialog'
import { FileText, Film, FolderOpen, Image, Music2, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { attachmentImportLimits, type AttachmentFolderPreview, type AttachmentImportSession, type AttachmentImportTarget, type AttachmentView } from '../../../shared/attachment-contracts'
import { isAttachmentAudioVideo } from '../../../shared/attachment-media-formats'
import { useAttachmentComposer, type RetainedAttachmentState } from '../../../features/enterprise/use-attachment-composer'
import { useOperationFeedback } from '../../feedback/use-operation-feedback'
import { ComposerAddMenu } from '../home/ComposerAddMenu'
import { ComposerConnectorChip } from './ComposerConnectorChip'
import type { ConnectorId } from '../../../shared/connectors'
import type { AddFileToConversation } from '../../workspace/file-menu-actions'

interface Props {
  addFileRef?: Ref<AddFileToConversation>
  operationsRef?: Ref<AttachmentComposerOperations>
  target: AttachmentImportTarget
  bindingKey?: string
  disabled?: boolean
  allowFolderPaste?: boolean
  retainedState?: RetainedAttachmentState
  onChange?: (attachments: AttachmentView[]) => void
  visibleAttachments?: AttachmentView[]
  onSessionChange?: (session: AttachmentImportSession | null) => void
  onPasteEdit?: (input: { operationId: string; composerId: string; text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => boolean
  onPasteImported?: (operationId: string, attachments: AttachmentView[]) => void
  onPasteStarted?: (operationId: string) => void
  onSelectStarted?: () => void
  onSelectFinished?: (attachments: AttachmentView[] | null) => void
  onBusyChange?: (busy: boolean) => void
  listContainer?: HTMLDivElement | null
  connectorId?: ConnectorId
  onConnectorChange: (id?: ConnectorId) => void
}

export interface AttachmentComposerOperations {
  select(single?: boolean): Promise<AttachmentView[] | null>
  addFile(file: Parameters<AddFileToConversation>[0]): Promise<AttachmentView[] | undefined>
}

export function AttachmentComposer({ target, bindingKey, disabled = false, allowFolderPaste, retainedState, onChange, onSessionChange, onPasteEdit, onPasteImported, onPasteStarted, onSelectStarted, onSelectFinished, onBusyChange, listContainer, connectorId, onConnectorChange, addFileRef, operationsRef, visibleAttachments }: Props) {
  const { capture } = useOperationFeedback(bindingKey)
  const notice = capture()
  const composer = useAttachmentComposer({ target, bindingKey, disabled, allowFolderPaste, retainedState, onError: message => notice.show(message), onPasteEdit, onPasteImported, onPasteStarted, onSelectStarted, onSelectFinished })
  const { attachments, select, addFile } = composer
  const folderButton = useRef<HTMLButtonElement>(null)
  useImperativeHandle(addFileRef, () => async file => { await addFile(file) }, [addFile])
  useImperativeHandle(operationsRef, () => ({ select, addFile }), [select, addFile])
  const chip = <ComposerConnectorChip value={connectorId} disabled={disabled || composer.busy} onRemove={() => onConnectorChange(undefined)} />
  useEffect(() => { onChange?.(attachments) }, [attachments, onChange])
  useEffect(() => { onSessionChange?.(composer.session) }, [composer.session, onSessionChange])
  useEffect(() => { onBusyChange?.(composer.busy) }, [composer.busy, onBusyChange])
  const visible = visibleAttachments ?? attachments
  const attachmentList = visible.length ? (
    <div className={`ent-attachment-list${listContainer ? ' ent-attachment-list-tiles' : ''}`} aria-label="已添加附件">
      {visible.map(item => {
        const audioVideo = isAttachmentAudioVideo(item.mediaType)
        const Icon = item.mediaType.startsWith('video/') ? Film : audioVideo ? Music2 : FileText
        return (
        <div className="ent-attachment-item" key={item.attachmentId}>
          {listContainer ? <div className="ent-attachment-preview" aria-hidden><Icon size={28} strokeWidth={1.5} /></div> : null}
          <div className="ent-attachment-details">
            <span className="ent-attachment-name" title={item.displayName}>{item.displayName}</span>
            <small>{formatBytes(item.byteLength)} · {audioVideo && item.extractionStatus === 'not-required' ? (Icon === Film ? '视频素材' : '音频素材') : statusLabel(item.extractionStatus)}</small>
          </div>
          <button type="button" className="ent-icon-btn" aria-label={`移除 ${item.displayName}`} onClick={() => void composer.remove(item.attachmentId)} disabled={disabled}>
            <X size={13} aria-hidden />
          </button>
        </div>
      )})}
    </div>
  ) : null
  return (
    <div className="ent-attachment-composer" data-attachment-composer data-composer-id={composer.composerId}>
      {listContainer ? createPortal(<>{chip}{attachmentList}</>, listContainer) : <>{chip}{attachmentList}</>}
      <ComposerAddMenu disabled={disabled || composer.busy} selected={connectorId} onFile={() => void composer.select()} onSelect={onConnectorChange} />
      {composer.folderPaste ? <button type="button" ref={folderButton} className="ent-btn sm" disabled={disabled || composer.busy} onClick={() => void composer.viewFolder()}><FolderOpen size={15} aria-hidden />查看素材</button> : null}
      {composer.folderPreview ? <FolderMaterials key={composer.folderPreview.previewId} preview={composer.folderPreview}
        busy={composer.busy} disabled={disabled} onClose={composer.closeFolder} onImport={composer.importFolder}
        restoreFocus={() => folderButton.current?.focus({ preventScroll: true })} /> : null}
    </div>
  )
}

function FolderMaterials({ preview, busy, disabled, onClose, onImport, restoreFocus }: { preview: AttachmentFolderPreview; busy: boolean; disabled: boolean;
  onClose: () => void; onImport: (ids: string[]) => Promise<void>; restoreFocus: () => void }) {
  const [selected, setSelected] = useState<string[]>([])
  const full = selected.length >= attachmentImportLimits.maxImportFiles
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="sep-composer-connectors-overlay" />
      <Dialog.Content className="sep-composer-connectors-dialog ent-folder-materials" onEscapeKeyDown={event => { event.stopPropagation(); if (busy) event.preventDefault() }}
        onCloseAutoFocus={event => { event.preventDefault(); restoreFocus() }}>
        <Dialog.Title>选择素材</Dialog.Title>
        <Dialog.Description className="ent-folder-name" title={preview.folderName}>{preview.folderName}</Dialog.Description>
        {preview.candidates.length ? <ul className="ent-folder-entries" aria-label="文件夹素材">
          {preview.candidates.map(item => {
            const checked = selected.includes(item.id)
            const Icon = item.kind === 'image' ? Image : item.kind === 'video' ? Film : Music2
            return <li key={item.id}><label className="ent-folder-entry">
              <input type="checkbox" checked={checked} disabled={busy || !!item.unavailable || (full && !checked)}
                onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
              <Icon size={16} aria-hidden />
              <span title={item.name}>{item.name}</span>
              <small>{item.unavailable === 'too-large' ? '超过 20 MiB' : item.unavailable === 'empty' ? '空文件' : formatBytes(item.byteLength)}</small>
            </label></li>
          })}
        </ul> : <p role="status">未找到支持的图片、视频或音频文件。</p>}
        {preview.truncated ? <p role="status">仅显示部分素材。</p> : null}
        <footer><span role="status">已选 {selected.length} / {attachmentImportLimits.maxImportFiles}</span>
          <Dialog.Close asChild><button type="button" className="ent-btn" disabled={busy}>取消</button></Dialog.Close>
          <button type="button" className="ent-btn primary" disabled={busy || disabled || !selected.length} onClick={() => void onImport(selected)}>{busy ? '正在添加…' : '添加所选素材'}</button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function statusLabel(status: AttachmentView['extractionStatus']): string {
  return ({ pending: '处理中', ready: '已就绪', partial: '部分解析', 'not-required': '待使用', unsupported: '不支持', failed: '失败' } as const)[status]
}

