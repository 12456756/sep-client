import { ChevronLeft, ChevronRight, Copy, LoaderCircle, Minus, Plus, RotateCcw, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocumentPreview, DocumentPreviewRequest } from '../../shared/document-preview'
import { documentPreviewFrame } from './document-preview-frame'

const PdfPreview = lazy(() => import('./PdfDocumentPreview'))
export interface DocumentPreviewDialogProps extends DocumentPreviewRequest { name: string; version?: string; onClose(): void }

export default function DocumentPreviewDialog({ taskId, nodeId, deliverableId, name, version, onClose }: DocumentPreviewDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [data, setData] = useState<DocumentPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [section, setSection] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const element = dialog.current
    element?.showModal(); close.current?.focus()
    return () => element?.close()
  }, [])
  useEffect(() => {
    let active = true
    setData(null); setError(null); setSection(0); setZoom(1)
    void window.electronAPI.previewArrangementDocument({ taskId, nodeId, deliverableId }).then(result => {
      if (!active) return
      if (!result.success || !result.data) { setError(result.error?.message || '文档预览读取失败'); return }
      setData(result.data)
    }).catch(() => { if (active) setError('文档预览读取失败，可重试或复制路径查看原件。') })
    return () => { active = false }
  }, [taskId, nodeId, deliverableId, version, attempt])
  const content = data?.content
  const text = content?.kind === 'text' || content?.kind === 'markdown' ? content.text : ''
  const count = content?.kind === 'html' ? content.sections.length : Math.max(1, Math.ceil(text.length / 100_000))
  const index = Math.min(section, count - 1)
  const part = text.slice(index * 100_000, (index + 1) * 100_000)
  const copyText = async () => {
    try { await navigator.clipboard.writeText(part); setCopied(true) } catch { setCopied(false) }
  }
  return <dialog ref={dialog} className="document-preview-dialog" aria-label={`文档预览：${name}`} onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className="document-preview-heading"><div><strong title={name}>{name}</strong><small>{data?.source === 'verified-original' ? '已核对原件' : data?.source === 'recovered-snapshot' ? '历史恢复版本' : '节点验收版本'}</small></div>
      <div className="document-preview-actions">
        <button type="button" title="重新读取" aria-label="重新读取文档" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={17} /></button>
        <button ref={close} type="button" title="关闭预览" aria-label="关闭文档预览" onClick={onClose}><X size={18} /></button>
      </div>
    </header>
    {error ? <div className="document-preview-state" role="alert"><p>{error}</p><button type="button" className="ent-btn sm" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={14} />重试预览</button></div>
      : !content ? <div className="document-preview-state" role="status"><LoaderCircle size={22} className="animate-spin" /><p>正在读取文档</p></div>
        : content.kind === 'pdf' ? <Suspense fallback={<div className="document-preview-state" role="status">正在加载 PDF</div>}><PdfPreview bytes={content.bytes} /></Suspense>
          : <>
            <div className="document-preview-toolbar">
              {content.kind === 'html' && count > 1 ? <select aria-label="选择文档章节、工作表或页面" value={index} onChange={event => setSection(Number(event.target.value))}>{content.sections.map((item, i) => <option key={i} value={i}>{item.title}</option>)}</select> : <span>{content.kind === 'html' ? content.sections[0].title : content.kind === 'markdown' ? 'Markdown' : '文本'}</span>}
              {count > 1 ? <div className="document-preview-pager"><button type="button" title="上一页" aria-label="上一页" disabled={index === 0} onClick={() => setSection(value => value - 1)}><ChevronLeft size={17} /></button><span>{index + 1} / {count}</span><button type="button" title="下一页" aria-label="下一页" disabled={index + 1 === count} onClick={() => setSection(value => value + 1)}><ChevronRight size={17} /></button></div> : null}
              <div className="document-preview-actions"><button type="button" title="缩小" aria-label="缩小文档" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.1))}><Minus size={16} /></button><span className="document-preview-zoom">{Math.round(zoom * 100)}%</span><button type="button" title="放大" aria-label="放大文档" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.1))}><Plus size={16} /></button>{text ? <button type="button" title={copied ? '已复制' : '复制当前页文本'} aria-label="复制当前页文本" onClick={() => void copyText()}><Copy size={16} /></button> : null}</div>
            </div>
            {content.kind === 'html' ? <>
              <p className="document-preview-notice">{content.notices.join(' ')}</p>
              <iframe key={index} className="document-preview-frame" title={`${name} · ${content.sections[index].title}`} sandbox="" referrerPolicy="no-referrer" srcDoc={documentPreviewFrame(content.sections[index].html, zoom)} />
            </> : <div className="document-preview-text" style={{ fontSize: `${Math.round(15 * zoom)}px` }}>{content.kind === 'markdown' ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => <span>［图片请查看原件］</span> }}>{part}</ReactMarkdown> : <pre>{part}</pre>}</div>}
          </>}
  </dialog>
}
