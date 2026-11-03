import { FileText, FolderOpen, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WorkDeliverable } from '../../features/enterprise/types'
import { useResultFilePreview, type ResultFilePreviewSource } from '../../features/enterprise/use-result-file-preview'
import type { ResultFileRequest } from '../../shared/result-files'
import { DocumentPreviewButton } from './DocumentPreviewButton'

export interface ResultFileCardProps {
  taskId: string
  file: WorkDeliverable
  visible?: boolean
  conversation?: boolean
  mediaRequest?: ResultFileRequest
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

export function ResultFileMedia({ preview, name, onZoom, onError }: {
  preview: ResultFilePreviewSource
  name: string
  onZoom: () => void
  onError: () => void
}) {
  return preview.kind === 'image'
    ? <button type="button" className="result-file-image" onClick={onZoom} title={`放大查看 ${name}`} aria-label={`放大查看 ${name}`}><img src={preview.url} alt={name} onError={onError} /></button>
    : <video className="result-file-video" src={preview.url} controls preload="auto" playsInline aria-label={`播放 ${name}`} onError={onError} />
}

function EnlargedImage({ preview, name, onClose, onError }: { preview: ResultFilePreviewSource; name: string; onClose: () => void; onError: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [])
  return <dialog ref={dialog} className="result-image-dialog" aria-label={`图片预览 ${name}`} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="result-image-heading"><strong>{name}</strong><button type="button" className="ent-icon-btn" title="关闭图片预览" aria-label="关闭图片预览" onClick={onClose}><X size={18} /></button></div>
    <img src={preview.url} alt={name} onError={onError} />
  </dialog>
}

function InlineMedia({ request, name, version }: { request: ResultFileRequest; name: string; version?: string }) {
  const { preview, error, retry, fail } = useResultFilePreview(request, version)
  const [zoomed, setZoomed] = useState(false)
  return <>
    <div className="result-file-preview">
      {error ? <div className="result-file-placeholder" role="alert"><span>{error}</span><button type="button" className="ent-btn sm" onClick={() => { setZoomed(false); retry() }}><RefreshCw size={14} />重新读取</button></div>
        : preview ? <ResultFileMedia preview={preview} name={name} onZoom={() => setZoomed(true)} onError={fail} />
          : <div className="result-file-placeholder" role="status"><LoaderCircle size={20} className="animate-spin" /><span>正在读取媒体</span></div>}
    </div>
    {zoomed && preview && !error ? <EnlargedImage preview={preview} name={name} onClose={() => setZoomed(false)} onError={fail} /> : null}
  </>
}

export function ResultFileCard({ taskId, file, visible = true, conversation = false, mediaRequest }: ResultFileCardProps) {
  const request = mediaRequest ?? resultFileRequest(taskId, file)
  const kind = mediaRequest ? mediaKind(file) : conversation ? null : mediaKind(file)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const reveal = async () => {
    if (!request) return
    setOpening(true); setError(null)
    try {
      const result = await window.electronAPI.revealResultFile(request)
      if (mounted.current && !result.success) setError(result.error?.message || '暂时无法打开所在文件夹，请重试。')
    } catch { if (mounted.current) setError('暂时无法打开所在文件夹，请重试。') }
    finally { if (mounted.current) setOpening(false) }
  }
  return <article className={`result-file-card${kind ? ' result-file-card-media' : ''}`} aria-label={`产物 ${file.name}`}>
    {kind && visible && request ? <InlineMedia key={`${file.id}:${file.previewVersion ?? ''}`} request={request} name={file.name} version={file.previewVersion} /> : null}
    <div className="result-file-footer">
      {!kind ? <FileText size={22} aria-hidden /> : null}
      <strong className="result-file-name" title={file.name}>{file.name}</strong>
      <div className="result-file-actions">
        {!mediaRequest && !kind && file.format && request && ('nodeId' in request || 'fileId' in request) ? <DocumentPreviewButton {...request} name={file.name} format={file.format} version={file.previewVersion} /> : null}
        <button type="button" className="ent-btn sm" aria-busy={opening} disabled={opening || !request} onClick={() => void reveal()} title="打开文件所在目录" aria-label={`打开 ${file.name} 所在文件夹`}>
          {opening ? <LoaderCircle size={14} className="animate-spin" /> : <FolderOpen size={14} />}<span>打开所在文件夹</span>
        </button>
      </div>
    </div>
    {error ? <p className="result-file-error" role="alert">{error}</p> : null}
  </article>
}
