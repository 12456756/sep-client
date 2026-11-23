import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CalendarClock, Copy, LoaderCircle, Maximize, Paperclip, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { SiliconEmployee, WorkItem, WorkMessage } from '../../features/enterprise/types'
import { useArrangementTranscript } from '../../features/enterprise/use-arrangement-transcript'
import { buildConversationReplies, buildConversationTranscript, type ConversationRunTranscript } from '../../features/enterprise/conversation-transcript'
import { ConversationProcessView } from './ConversationProcess'
import { DiagnosticExport } from './DiagnosticExport'
import type { ElectronAPI } from '../../shared/ipc'
import { EmployeeFace } from './EmployeeFace'
import { MessageContent } from './MessageContent'
import { groupConversationResults, type ConversationResult } from '../../features/enterprise/conversation-results'
import { imageCopyHandlers, useContentCopy, useImagePreviewCopy, type CopyMenuHandler } from '../ContentCopyMenu'
import { ResultFileCard } from '../workspace/ResultFileCard'
import { DocumentPreviewButton } from '../workspace/DocumentPreviewButton'
import { SaveWordCopyButton } from '../workspace/SaveWordCopyButton'
import { useFileMenuCommands } from '../workspace/file-menu-actions'
import '../workspace/result-file-card.css'
import { formatScheduleReceiptTime, type ConversationScheduleReceipt } from '../../shared/scheduled-creation'
import { RUNTIME_FAILURE_MESSAGES } from '../../shared/runtime-feedback'

interface Props {
  work: WorkItem
  employees: SiliconEmployee[]
  scopeKey: string
  preparing: boolean
  mediaState: { results: ConversationResult[]; error: string | null; retry: () => void }
  onOpenSchedule?: (id: string) => void
}

export const ConversationMessages = React.memo(function ConversationMessages(props: Props) {
  return <ConversationMessagesContent key={`${props.scopeKey}:${props.work.id}`} {...props} />
})

function ConversationMessagesContent({ work, employees, scopeKey, preparing, mediaState: media, onOpenSchedule }: Props) {
  const transcript = useArrangementTranscript(work.id, scopeKey)
  const runs = useMemo(() => buildConversationTranscript(transcript.events), [transcript.events])
  return <><ConversationMessagesView work={work} employees={employees} preparing={preparing} runs={runs} media={media.results} onOpenSchedule={onOpenSchedule}
    loading={transcript.loading} error={transcript.error} onReload={transcript.reload} onExportDiagnostic={window.electronAPI?.exportWorkDiagnostic} />
    {media.error ? <div className="ent-conversation-results-error" role="alert"><span>{media.error}</span><button type="button" className="ent-btn sm ghost" onClick={media.retry}><RotateCcw size={14} />重新读取</button></div> : null}</>
}

export function ConversationMessagesView({ work, employees, preparing, runs, loading, error, onReload, onExportDiagnostic, onOpenSchedule, media = [] }: Omit<Props, 'scopeKey' | 'mediaState'> & {
  media?: ConversationResult[]
  runs: readonly ConversationRunTranscript[]
  loading: boolean
  error: string | null
  onReload: () => void
  onExportDiagnostic?: ElectronAPI['exportWorkDiagnostic']
}) {
  const { showMenu, menu } = useContentCopy()
  const items = buildConversationReplies(work, preparing)
  const results = groupConversationResults(work, items, media)
  const byRun = new Map(runs.map(run => [run.runId, run]))
  const lastReply = [...items].reverse().find(item => item.kind === 'reply')
  return <>{items.map(item => {
    if (item.kind === 'message') {
      const message = item.message
      if (message.role === 'system') return <p className="ent-talk-sys" key={item.id}>{message.content}</p>
      const copyText = (event: React.MouseEvent<HTMLParagraphElement> | React.KeyboardEvent<HTMLParagraphElement>) => {
        if (message.content.trim()) showMenu(event, { label: '复制文本', run: () => navigator.clipboard.writeText(message.content) })
      }
      return <div className="ent-say user" key={item.id}>
        <p tabIndex={message.content.trim() ? 0 : undefined} onContextMenu={copyText} onKeyDown={copyText}>{message.content}</p>
        {message.attachments?.length ? <div className="ent-message-attachments" aria-label="本轮附件">{message.attachments.map(attachment =>
          <MessageAttachment key={`${work.id}:${attachment.attachmentId}:${attachment.sha256}`} taskId={work.id} attachment={attachment} onCopyMenu={showMenu} />,
        )}</div> : null}
        <MessageTime message={message} />
      </div>
    }
    const first = item.messages[0]
    const employeeId = first?.employeeId || work.currentEmployeeId
    const employeeName = first?.employeeName || work.currentEmployeeName
    const run = item.runId ? byRun.get(item.runId) : undefined
    const entries = run?.entries ?? []
    const hasContent = item.messages.some(message => message.content.trim())
    const replyResults = results.get(item.id)
    const processError = item.id === lastReply?.id ? error : null
    const latestFailure = work.status === 'failed' && work.lastRunId && item.runId === work.lastRunId &&
      work.stopReason === RUNTIME_FAILURE_MESSAGES.MODEL_REQUEST_TOO_LARGE ? work.stopReason : undefined
    const failureMessage = !item.active ? run?.failureMessage ?? latestFailure : undefined
    return <div className="ent-say ent-conversation-reply" key={item.id} data-conversation-reply={item.id} data-run-id={item.runId}>
      <span className="ent-say-who"><EmployeeFace employee={employees.find(employee => employee.id === employeeId)} name={employeeName} size="sm" round />{employeeName}</span>
      {item.runId && (entries.length > 0 || loading || processError) ? <ConversationProcessView entries={entries} active={item.active} loading={loading} error={processError} onReload={onReload} /> : null}
      {run?.scheduleReceipt ? <ScheduleReceipt receipt={run.scheduleReceipt} active={item.active} onOpen={onOpenSchedule} /> : null}
      {failureMessage || (!run?.scheduleReceipt && !hasContent && !replyResults?.length && (!entries.length || !item.active)) ? <div className="ent-conversation-reply-status" role="status">
        {item.active ? <LoaderCircle size={14} className="ent-spin" aria-hidden /> : null}
        {failureMessage ?? (item.active ? '正在进行…' : run?.diagnosticAvailable ? '本轮执行失败' : '本轮未返回回复')}
      </div> : null}
      {item.messages.filter(message => message.content.trim()).map(message => <MessageContent key={message.id} content={message.content} />)}
      <ConversationResultCards taskId={work.id} results={replyResults} />
      {!item.active && item.runId && run?.diagnosticAvailable && onExportDiagnostic ?
        <DiagnosticExport input={{ taskId: work.id, runId: item.runId }} onExport={onExportDiagnostic} /> : null}
      <MessageTime message={{ createdAt: first?.createdAt ?? item.createdAt }} />
    </div>
  })}<ConversationResultCards taskId={work.id} results={results.get('unassigned')} />
    {menu}
  </>
}

function ScheduleReceipt({ receipt, active, onOpen }: { receipt: ConversationScheduleReceipt; active: boolean; onOpen?: (id: string) => void }) {
  const pending = receipt.status === 'pending' && active
  return <div className="ent-conversation-schedule-receipt">
    <div className="ent-conversation-schedule-copy" role="status">
      {pending ? <LoaderCircle size={16} className="ent-spin" aria-hidden /> : <CalendarClock size={16} aria-hidden />}
      <span>{receipt.status === 'created' ? <><strong>已启用「{receipt.title}」</strong><small>下次执行：{formatScheduleReceiptTime(receipt.nextRunAt, receipt.timezone)}</small></>
        : receipt.status === 'pending' ? pending ? '正在准备定时任务…' : '创建结果未确认，请前往「定时任务」查看。' : receipt.message}</span>
    </div>
    {receipt.status === 'created' && onOpen ? <button type="button" className="ent-btn sm ghost" onClick={() => onOpen(receipt.id)}>查看任务<ArrowRight size={14} aria-hidden /></button> : null}
  </div>
}

function ConversationResultCards({ taskId, results }: { taskId: string; results?: ConversationResult[] }) {
  if (!results?.length) return null
  return <div className="result-file-list ent-conversation-results" aria-label="生成的文件">
    {results.map(result => <ResultFileCard key={result.file.id} taskId={taskId} file={result.file} mediaRequest={result.request} />)}
  </div>
}

function MessageTime({ message }: { message: Pick<WorkMessage, 'createdAt'> }) {
  return <time className="ent-message-time" dateTime={new Date(message.createdAt).toISOString()}>
    {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
  </time>
}

function MessageAttachment({ taskId, attachment, onCopyMenu }: {
  taskId: string
  attachment: NonNullable<WorkMessage['attachments']>[number]
  onCopyMenu: CopyMenuHandler
}) {
  const isPreviewableImage = ['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mediaType)
  const wordFormat = /\.(docx?)$/i.exec(attachment.displayName)?.[1]?.toLowerCase()
  const documentRequest = { taskId, attachmentId: attachment.attachmentId, sha256: attachment.sha256 }
  const commands = useFileMenuCommands(documentRequest, attachment.displayName)
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

  return <span className={`ent-message-attachment${isPreviewableImage ? ' is-image' : ''}`} title={`${attachment.mediaType} · ${attachment.sha256.slice(0, 12)}`}
    tabIndex={isPreviewableImage ? undefined : 0} {...imageCopyHandlers(onCopyMenu, undefined, commands)}>
    {isPreviewableImage ? <button type="button" className="ent-message-attachment-preview" disabled={!preview && !failed}
      title={failed ? '重新读取图片' : `查看图片：${attachment.displayName}`} aria-label={failed ? '重新读取图片' : `查看图片：${attachment.displayName}`}
      {...imageCopyHandlers(onCopyMenu, undefined, commands)}
      onClick={() => failed ? setAttempt(value => value + 1) : setOpened(true)}>
      {preview && !failed ? <img src={preview} alt={attachment.displayName} onError={() => setFailed(true)} />
        : <span className="ent-message-attachment-placeholder" role="status">{failed ? <RotateCcw size={18} aria-hidden /> : <LoaderCircle size={18} className="ent-spin" aria-hidden />}{failed ? '预览不可用' : '图片加载中…'}</span>}
    </button> : null}
    <span className="ent-message-attachment-details">
      {!isPreviewableImage ? <Paperclip size={12} aria-hidden /> : null}
      <span className="ent-message-attachment-name">{attachment.displayName}</span>
      {isPreviewableImage && attachment.width && attachment.height ? <small>{attachment.width} × {attachment.height}</small> : null}
      <small>{formatAttachmentBytes(attachment.byteLength)}</small>
      {wordFormat ? <>
        <DocumentPreviewButton {...documentRequest} name={attachment.displayName} format={wordFormat} version={attachment.sha256} />
        <SaveWordCopyButton request={documentRequest} name={attachment.displayName} />
      </> : null}
    </span>
    {opened && preview && !failed ? <AttachmentImageDialog taskId={taskId} url={preview} attachment={attachment} onClose={() => setOpened(false)} onError={() => { setOpened(false); setFailed(true) }} /> : null}
  </span>
}

function AttachmentImageDialog({ taskId, url, attachment, onClose, onError }: {
  taskId: string
  url: string
  attachment: NonNullable<WorkMessage['attachments']>[number]
  onClose: () => void
  onError: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const commands = useFileMenuCommands({ taskId, attachmentId: attachment.attachmentId, sha256: attachment.sha256 }, attachment.displayName, onClose)
  const { imageProps, copyButtonProps, menu, triggerProps } = useImagePreviewCopy(url, undefined, commands)
  const [zoom, setZoom] = useState(0)
  const [width, setWidth] = useState(attachment.width ?? 800)
  useEffect(() => {
    const element = dialog.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element?.showModal()
    return () => { element?.close(); opener?.focus() }
  }, [])
  return <dialog ref={dialog} className="ent-attachment-image-dialog" aria-label={`图片预览：${attachment.displayName}`}
    onCancel={event => { event.preventDefault(); onClose() }} onContextMenu={triggerProps.onContextMenu}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); else triggerProps.onKeyDown(event) }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className="ent-attachment-image-heading">
      <div><strong>{attachment.displayName}</strong><small>{attachment.width && attachment.height ? `${attachment.width} × ${attachment.height} · ` : ''}{formatAttachmentBytes(attachment.byteLength)}</small></div>
      <div className="ent-attachment-image-actions">
        <button type="button" title="缩小图片" aria-label="缩小图片" disabled={zoom > 0 && zoom <= 0.25} onClick={() => setZoom(value => value === 0 ? 0.75 : Math.max(0.25, value - 0.25))}><ZoomOut size={18} /></button>
        <span>{zoom ? `${Math.round(zoom * 100)}%` : '适应'}</span>
        <button type="button" title="放大图片" aria-label="放大图片" disabled={zoom >= 4} onClick={() => setZoom(value => value === 0 ? 1 : Math.min(4, value + 0.25))}><ZoomIn size={18} /></button>
        <button type="button" title="适应窗口" aria-label="适应窗口" onClick={() => setZoom(0)}><Maximize size={18} /></button>
        <button type="button" {...copyButtonProps}><Copy size={18} aria-hidden /></button>
        <button type="button" title="关闭图片预览" aria-label="关闭图片预览" onClick={onClose} autoFocus><X size={18} /></button>
      </div>
    </header>
    <div className={`ent-attachment-image-viewport${zoom ? ' is-zoomed' : ''}`}>
      <img {...imageProps} src={url} alt={attachment.displayName} style={zoom ? { width: width * zoom } : undefined}
        onLoad={event => { imageProps.onLoad(); setWidth(event.currentTarget.naturalWidth) }} onError={() => { imageProps.onError(); onError() }} />
    </div>
    {menu}
  </dialog>
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
