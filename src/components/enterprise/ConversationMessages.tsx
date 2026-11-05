import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Maximize, Paperclip, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { SiliconEmployee, WorkItem, WorkMessage } from '../../features/enterprise/types'
import { useArrangementTranscript } from '../../features/enterprise/use-arrangement-transcript'
import { buildConversationReplies, buildConversationTranscript, type ConversationRunTranscript } from '../../features/enterprise/conversation-transcript'
import { ConversationProcessView } from './ConversationProcess'
import { EmployeeFace } from './EmployeeFace'
import { MessageContent } from './MessageContent'

interface Props {
  work: WorkItem
  employees: SiliconEmployee[]
  scopeKey: string
  preparing: boolean
}

export const ConversationMessages = React.memo(function ConversationMessages({ work, employees, scopeKey, preparing }: Props) {
  const transcript = useArrangementTranscript(work.id, scopeKey)
  const runs = useMemo(() => buildConversationTranscript(transcript.events), [transcript.events])
  return <ConversationMessagesView key={`${scopeKey}:${work.id}`} work={work} employees={employees} preparing={preparing} runs={runs}
    loading={transcript.loading} error={transcript.error} onReload={transcript.reload} />
})

export function ConversationMessagesView({ work, employees, preparing, runs, loading, error, onReload }: Omit<Props, 'scopeKey'> & {
  runs: readonly ConversationRunTranscript[]
  loading: boolean
  error: string | null
  onReload: () => void
}) {
  const items = buildConversationReplies(work, preparing)
  const byRun = new Map(runs.map(run => [run.runId, run.entries]))
  const lastReply = [...items].reverse().find(item => item.kind === 'reply')
  return <>{items.map(item => {
    if (item.kind === 'message') {
      const message = item.message
      if (message.role === 'system') return <p className="ent-talk-sys" key={item.id}>{message.content}</p>
      return <div className="ent-say user" key={item.id}>
        <p>{message.content}</p>
        {message.attachments?.length ? <div className="ent-message-attachments" aria-label="本轮附件">{message.attachments.map(attachment =>
          <MessageAttachment key={`${work.id}:${attachment.attachmentId}:${attachment.sha256}`} taskId={work.id} attachment={attachment} />,
        )}</div> : null}
        <MessageTime message={message} />
      </div>
    }
    const first = item.messages[0]
    const employeeId = first?.employeeId || work.currentEmployeeId
    const employeeName = first?.employeeName || work.currentEmployeeName
    const entries = item.runId ? byRun.get(item.runId) ?? [] : []
    const hasContent = item.messages.some(message => message.content.trim())
    const processError = item.id === lastReply?.id ? error : null
    return <div className="ent-say ent-conversation-reply" key={item.id} data-conversation-reply={item.id} data-run-id={item.runId}>
      <span className="ent-say-who"><EmployeeFace employee={employees.find(employee => employee.id === employeeId)} name={employeeName} size="sm" round />{employeeName}</span>
      {item.runId && (entries.length > 0 || loading || processError) ? <ConversationProcessView entries={entries} active={item.active} loading={loading} error={processError} onReload={onReload} /> : null}
      {!hasContent && (!entries.length || !item.active) ? <div className="ent-conversation-reply-status" role="status">
        {item.active ? <LoaderCircle size={14} className="ent-spin" aria-hidden /> : null}
        {item.active ? '正在进行…' : '本轮未返回回复'}
      </div> : null}
      {item.messages.filter(message => message.content.trim()).map(message => <MessageContent key={message.id} content={message.content} />)}
      <MessageTime message={{ createdAt: first?.createdAt ?? item.createdAt }} />
    </div>
  })}</>
}

function MessageTime({ message }: { message: Pick<WorkMessage, 'createdAt'> }) {
  return <time className="ent-message-time" dateTime={new Date(message.createdAt).toISOString()}>
    {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
  </time>
}

function MessageAttachment({ taskId, attachment }: {
  taskId: string
  attachment: NonNullable<WorkMessage['attachments']>[number]
}) {
  const isPreviewableImage = ['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mediaType)
  const [preview, setPreview] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    if (!isPreviewableImage) return
    let active = true
    let objectUrl: string | undefined
    setPreview(null)
    setFailed(false)
    void window.electronAPI.previewAttachment({ taskId, attachmentId: attachment.attachmentId, sha256: attachment.sha256 })
      .then(result => {
        if (!active) return
        if (!result.success || !result.data) { setFailed(true); return }
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.data.bytes).buffer], { type: result.data.mediaType }))
        setPreview(objectUrl)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [taskId, attachment.attachmentId, attachment.sha256, isPreviewableImage, attempt])

  return <span className={`ent-message-attachment${isPreviewableImage ? ' is-image' : ''}`} title={`${attachment.mediaType} · ${attachment.sha256.slice(0, 12)}`}>
    {isPreviewableImage ? <button type="button" className="ent-message-attachment-preview" disabled={!preview && !failed}
      title={failed ? '重新读取图片' : `查看图片：${attachment.displayName}`} aria-label={failed ? '重新读取图片' : `查看图片：${attachment.displayName}`}
      onClick={() => failed ? setAttempt(value => value + 1) : setOpened(true)}>
      {preview && !failed ? <img src={preview} alt={attachment.displayName} onError={() => setFailed(true)} />
        : <span className="ent-message-attachment-placeholder" role="status">{failed ? <RotateCcw size={18} aria-hidden /> : <LoaderCircle size={18} className="ent-spin" aria-hidden />}{failed ? '预览不可用' : '图片加载中…'}</span>}
    </button> : null}
    <span className="ent-message-attachment-details">
      {!isPreviewableImage ? <Paperclip size={12} aria-hidden /> : null}
      <span className="ent-message-attachment-name">{attachment.displayName}</span>
      {isPreviewableImage && attachment.width && attachment.height ? <small>{attachment.width} × {attachment.height}</small> : null}
      <small>{formatAttachmentBytes(attachment.byteLength)}</small>
    </span>
    {opened && preview && !failed ? <AttachmentImageDialog url={preview} attachment={attachment} onClose={() => setOpened(false)} /> : null}
  </span>
}

function AttachmentImageDialog({ url, attachment, onClose }: {
  url: string
  attachment: NonNullable<WorkMessage['attachments']>[number]
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [zoom, setZoom] = useState(0)
  const [width, setWidth] = useState(attachment.width ?? 800)
  useEffect(() => {
    const element = dialog.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element?.showModal()
    return () => { element?.close(); opener?.focus() }
  }, [])
  return <dialog ref={dialog} className="ent-attachment-image-dialog" aria-label={`图片预览：${attachment.displayName}`}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className="ent-attachment-image-heading">
      <div><strong>{attachment.displayName}</strong><small>{attachment.width && attachment.height ? `${attachment.width} × ${attachment.height} · ` : ''}{formatAttachmentBytes(attachment.byteLength)}</small></div>
      <div className="ent-attachment-image-actions">
        <button type="button" title="缩小图片" aria-label="缩小图片" disabled={zoom > 0 && zoom <= 0.25} onClick={() => setZoom(value => value === 0 ? 0.75 : Math.max(0.25, value - 0.25))}><ZoomOut size={18} /></button>
        <span>{zoom ? `${Math.round(zoom * 100)}%` : '适应'}</span>
        <button type="button" title="放大图片" aria-label="放大图片" disabled={zoom >= 4} onClick={() => setZoom(value => value === 0 ? 1 : Math.min(4, value + 0.25))}><ZoomIn size={18} /></button>
        <button type="button" title="适应窗口" aria-label="适应窗口" onClick={() => setZoom(0)}><Maximize size={18} /></button>
        <button type="button" title="关闭图片预览" aria-label="关闭图片预览" onClick={onClose} autoFocus><X size={18} /></button>
      </div>
    </header>
    <div className={`ent-attachment-image-viewport${zoom ? ' is-zoomed' : ''}`}>
      <img src={url} alt={attachment.displayName} style={zoom ? { width: width * zoom } : undefined} onLoad={event => setWidth(event.currentTarget.naturalWidth)} />
    </div>
  </dialog>
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
