import { Copy, Eye, FileText, Film, FolderOpen, Image, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WorkDeliverable } from '../../features/enterprise/types'
import { useResultFilePreview, type ResultFilePreviewSource } from '../../features/enterprise/use-result-file-preview'
import { resultFileReleaseSchema, type ResultArchiveStatus, type ResultFileRequest } from '../../shared/result-files'
import { imageCopyHandlers, useContentCopy, useImagePreviewCopy, type ContentMenuCommand, type CopyMenuHandler } from '../ContentCopyMenu'
import { useFeedback } from '../feedback/FeedbackProvider'
import { DocumentPreviewButton } from './DocumentPreviewButton'
import { SaveWordCopyButton } from './SaveWordCopyButton'
import { useFileMenuCommands } from './file-menu-actions'

export interface ResultFileCardProps {
  taskId: string
  file: WorkDeliverable
  visible?: boolean
  conversation?: boolean
  mediaRequest?: ResultFileRequest
  presentation?: 'card' | 'list'
}

export function resultFileRequest(taskId: string, file: WorkDeliverable): ResultFileRequest | null {
  return file.nodeId && file.deliverableId ? { taskId, nodeId: file.nodeId, deliverableId: file.deliverableId }
    : !file.nodeId ? { taskId, fileId: file.id } : null
}

function mediaKind(file: WorkDeliverable): 'image' | 'video' | null {
  if (file.sourceArtifact) return file.sourceArtifact.kind
  const format = (file.format || file.name.split('.').pop() || '').toLowerCase().replace(/^\./, '')
  return ['png', 'jpg', 'jpeg', 'webp'].includes(format) ? 'image' : ['mp4', 'webm'].includes(format) ? 'video' : null
}

async function readResultImage(url: string, signal: AbortSignal): Promise<Blob> {
  const lease = resultFileReleaseSchema.parse({ url })
  // Read through the existing authorized lease, rather than drawing a cross-origin preview to canvas.
  const response = await fetch(lease.url, { signal })
  if (!response.ok || !/^image\/(png|jpeg|webp)$/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('Result image is unavailable')
  return response.blob()
}

export function ResultFileMedia({ preview, name, onZoom, onError, onCopyMenu, commands }: {
  preview: ResultFilePreviewSource
  name: string
  onZoom: () => void
  onError: () => void
  onCopyMenu?: CopyMenuHandler
  commands?: readonly ContentMenuCommand[]
}) {
  return preview.kind === 'image'
    ? <button type="button" className="result-file-image" onClick={onZoom} title={`放大查看 ${name}`} aria-label={`放大查看 ${name}`}
      {...(onCopyMenu ? imageCopyHandlers(onCopyMenu, readResultImage, commands) : undefined)}><img src={preview.url} alt={name} onError={onError} /></button>
    : <video className="result-file-video" src={preview.url} controls preload="auto" playsInline aria-label={`播放 ${name}`} onError={onError} />
}

function EnlargedImage({ request, preview, name, onClose, onError }: { request: ResultFileRequest; preview: ResultFilePreviewSource; name: string; onClose: () => void; onError: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const commands = useFileMenuCommands(request, name, onClose)
  const { imageProps, copyButtonProps, menu, triggerProps } = useImagePreviewCopy(preview.url, readResultImage, commands)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [])
  return <dialog ref={dialog} className="result-image-dialog" aria-label={`图片预览 ${name}`} onCancel={event => { event.preventDefault(); onClose() }}
    onContextMenu={triggerProps.onContextMenu} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); else triggerProps.onKeyDown(event) }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="result-image-heading"><strong>{name}</strong><div className="result-image-actions">
      <button type="button" className="ent-icon-btn" {...copyButtonProps}><Copy size={18} aria-hidden /></button>
      <button type="button" className="ent-icon-btn" title="关闭图片预览" aria-label="关闭图片预览" onClick={onClose} autoFocus><X size={18} aria-hidden /></button>
    </div></div>
    <img {...imageProps} src={preview.url} alt={name} onError={() => { imageProps.onError(); onClose(); onError() }} />
    {menu}
  </dialog>
}

function InlineMedia({ request, name, version, showMenu, commands }: { request: ResultFileRequest; name: string; version?: string; showMenu: CopyMenuHandler; commands: readonly ContentMenuCommand[] }) {
  const { preview, error, retry, fail } = useResultFilePreview(request, version)
  const [zoomed, setZoomed] = useState(false)
  return <>
    <div className="result-file-preview">
      {error ? <div className="result-file-placeholder" role="alert"><span>{error}</span><button type="button" className="ent-btn sm" onClick={() => { setZoomed(false); retry() }}><RefreshCw size={14} />重新读取</button></div>
        : preview ? <ResultFileMedia preview={preview} name={name} onZoom={() => setZoomed(true)} onError={fail} onCopyMenu={showMenu} commands={commands} />
          : <div className="result-file-placeholder" role="status"><LoaderCircle size={20} className="animate-spin" /><span>正在读取媒体</span></div>}
    </div>
    {zoomed && preview?.kind === 'image' && !error ? <EnlargedImage key={preview.url} request={request} preview={preview} name={name} onClose={() => setZoomed(false)} onError={fail} /> : null}
  </>
}

export function ResultFileCard({ taskId, file, visible = true, conversation = false, mediaRequest, presentation = 'card' }: ResultFileCardProps) {
  const request = mediaRequest ?? resultFileRequest(taskId, file)
  const detectedKind = mediaKind(file)
  const kind = conversation && !mediaRequest && detectedKind === 'video' ? null : detectedKind
  const list = presentation === 'list'
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const Icon = detectedKind === 'image' ? Image : detectedKind === 'video' ? Film : FileText
  const format = (file.format || (file.name.includes('.') ? file.name.split('.').at(-1) : '') || '').replace(/^\./, '').toUpperCase()
  const fileType = format === 'MD' || format === 'MARKDOWN' ? 'Markdown 文档' : [format, detectedKind === 'image' ? '图片' : detectedKind === 'video' ? '视频' : '文件'].filter(Boolean).join(' ')
  const commands = useFileMenuCommands(request, file.name)
  const feedback = useFeedback()
  const { showMenu, menu } = useContentCopy()
  const fileMenu = imageCopyHandlers(showMenu, readResultImage, commands)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<ResultArchiveStatus>({ state: 'none' })
  const [statusRefresh, setStatusRefresh] = useState(0)
  const requestKey = request ? JSON.stringify(request) : ''
  const mounted = useRef(true)
  const alternatePrompt = useRef<AbortController | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => () => {
    alternatePrompt.current?.abort()
    alternatePrompt.current = null
  }, [visible, requestKey, file.previewVersion])
  useEffect(() => {
    setSaveStatus({ state: 'none' })
    if (!visible || !requestKey) return
    const input = JSON.parse(requestKey) as ResultFileRequest
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const result = await window.electronAPI.getResultFileSaveStatus(input)
        if (!active) return
        if (result.success && result.data) {
          setSaveStatus(result.data)
          if (result.data.state === 'saved') setRetryError(null)
          if (result.data.state === 'pending') timer = setTimeout(() => void refresh(), 1000)
        }
      } catch { /* Folder reveal can still surface an unavailable copy. */ }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [visible, requestKey, file.previewVersion, statusRefresh])
  useEffect(() => { setRetryError(null) }, [requestKey, file.previewVersion])
  useEffect(() => { if (!visible) setPreviewExpanded(false) }, [visible])
  const reveal = async () => {
    if (!request) return
    setOpening(true); setError(null)
    try {
      const result = await window.electronAPI.revealResultFile(request)
      if (mounted.current) {
        if (!result.success) setError(result.error?.message || '暂时无法打开所在文件夹，请重试。')
        setStatusRefresh(value => value + 1)
      }
    } catch { if (mounted.current) setError('暂时无法打开所在文件夹，请重试。') }
    finally { if (mounted.current) setOpening(false) }
  }
  const retryArchive = async (confirmation?: string) => {
    if (!request) return
    setOpening(true); setError(null); setRetryError(null)
    try {
      const result = await window.electronAPI.runResultFileAction(confirmation
        ? { action: 'retry-archive-elsewhere', file: request, confirmation }
        : { action: 'retry-archive', file: request })
      if (mounted.current) {
        if (!result.success) setRetryError(result.error?.message || '副本未保存，请重试。')
      }
    } catch { if (mounted.current) setRetryError('副本未保存，请重试。') }
    finally { if (mounted.current) { setOpening(false); setStatusRefresh(value => value + 1) } }
  }
  const confirmAlternate = async (confirmation: string) => {
    if (opening || alternatePrompt.current || !visible) return
    const controller = new AbortController(), revision = feedback.getRevision()
    alternatePrompt.current = controller
    try {
      const confirmed = await feedback.ask({ key: `result-save-elsewhere:${confirmation}`, signal: controller.signal,
        message: '原保存位置可能已经有一份副本。仍要保存到设置中当前选定的文件夹吗？', actionLabel: '仍保存到新位置' })
      if (confirmed && !controller.signal.aborted && feedback.getRevision() === revision) await retryArchive(confirmation)
    } finally { if (alternatePrompt.current === controller) alternatePrompt.current = null }
  }
  const inlineMedia = kind && visible && request && (!list || previewExpanded)
    ? <InlineMedia key={`${file.id}:${file.previewVersion ?? ''}`} request={request} name={file.name} version={file.previewVersion} showMenu={showMenu} commands={commands} /> : null
  return <article className={`result-file-card${kind ? ' result-file-card-media' : ''}${list ? ' result-file-card-list' : ''}`} aria-label={`产物 ${file.name}`} tabIndex={request ? 0 : undefined} {...(request ? fileMenu : undefined)}>
    {!list && inlineMedia}
    <div className="result-file-footer">
      {list ? <span className="result-list-file-icon" data-kind={detectedKind ?? 'file'}><Icon size={17} aria-hidden /></span> : !kind ? <FileText size={22} aria-hidden /> : null}
      {list ? <div className="result-list-file-label"><strong className="result-file-name" title={file.name}>{file.name}</strong><small>{fileType}</small></div>
        : <strong className="result-file-name" title={file.name}>{file.name}</strong>}
      <div className="result-file-actions">
        {list && kind && request && <button type="button" className="ent-btn sm result-list-preview-toggle" aria-expanded={previewExpanded} aria-label={`${previewExpanded ? '收起' : '预览'}${kind === 'image' ? '图片' : '视频'}：${file.name}`} onClick={() => setPreviewExpanded(value => !value)}>
          <Eye size={14} aria-hidden /><span>{previewExpanded ? '收起预览' : '预览'}</span>
        </button>}
        {!mediaRequest && !kind && file.format && request && ('nodeId' in request || 'fileId' in request) ? <DocumentPreviewButton {...request} name={file.name} format={file.format} version={file.previewVersion} /> : null}
        {!mediaRequest && !kind && /^\.?docx?$/i.test(file.format ?? '') && request && ('nodeId' in request || 'fileId' in request) ? <SaveWordCopyButton request={request} name={file.name} /> : null}
        <button type="button" className="ent-btn sm result-file-reveal" aria-busy={opening} disabled={opening || !request} onClick={() => void reveal()} title="打开文件所在目录" aria-label={`打开 ${file.name} 所在文件夹`}>
          {opening ? <LoaderCircle size={14} className="animate-spin" /> : <FolderOpen size={14} />}<span>打开所在文件夹</span>
        </button>
      </div>
    </div>
    {list && inlineMedia}
    {error ? <p className="result-file-error" role="alert">{error}</p> : null}
    {saveStatus.state === 'pending' ? <div className="result-file-save-status" role="status">正在保存到指定文件夹…</div> : null}
    {saveStatus.state === 'failed' || saveStatus.state === 'missing' ? <div className="result-file-error result-file-save-status" role="status">
      <span>{retryError ?? (saveStatus.state === 'missing' ? '保存的副本已找不到。' : saveStatus.message)}</span>
      <button type="button" className="ent-btn sm" disabled={opening} onClick={() => void retryArchive()}><RefreshCw size={14} aria-hidden />重试保存</button>
      {visible && saveStatus.state === 'failed' && saveStatus.alternateConfirmation &&
        <button type="button" className="ent-btn sm" disabled={opening} onClick={() => void confirmAlternate(saveStatus.alternateConfirmation!)}>
          <FolderOpen size={14} aria-hidden />仍保存到新位置
        </button>}
    </div> : null}
    {visible ? menu : null}
  </article>
}
