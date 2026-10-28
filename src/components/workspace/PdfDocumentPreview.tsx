import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useOperationFeedback } from '../feedback/use-operation-feedback'

GlobalWorkerOptions.workerSrc = workerUrl
const cmaps = import.meta.glob<string>('../../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true })
const fonts = import.meta.glob<string>('../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url', import: 'default', eager: true })
async function assetBytes(assets: Record<string, string>, name: string): Promise<Uint8Array> {
  const url = Object.entries(assets).find(([key]) => key.endsWith(`/${name}`))?.[1]
  if (!url) throw new Error('PDF resource is unavailable')
  const response = await fetch(url)
  if (!response.ok) throw new Error('PDF resource is unavailable')
  return new Uint8Array(await response.arrayBuffer())
}
class CMapReader { async fetch({ name }: { name: string }) { return { cMapData: await assetBytes(cmaps, `${name}.bcmap`), compressionType: 1 } } }
class FontReader { fetch({ filename }: { filename: string }) { return assetBytes(fonts, filename) } }

export default function PdfDocumentPreview({ bytes }: { bytes: Uint8Array }) {
  const { capture } = useOperationFeedback()
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(true)
  const canvas = useRef<HTMLCanvasElement>(null)
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    const notice = capture()
    setDocument(null); setPage(1); setLoading(true)
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, useSystemFonts: true,
      useWorkerFetch: false, CMapReaderFactory: CMapReader, StandardFontDataFactory: FontReader })
    void task.promise.then(pdf => { if (active && notice.isCurrent()) setDocument(pdf) }).catch(() => { if (active && notice.isCurrent()) { notice.show('PDF 预览失败，请联系平台管理员'); setLoading(false) } })
    return () => { active = false; void task.destroy() }
  }, [bytes, capture])
  useEffect(() => {
    if (!document) return
    let active = true
    const notice = capture()
    let render: { cancel(): void } | undefined
    setLoading(true)
    void document.getPage(page).then(async pdfPage => {
      if (!active || !notice.isCurrent() || !canvas.current) return
      const base = pdfPage.getViewport({ scale: 1 })
      const width = Math.max(200, (container.current?.clientWidth ?? 700) - 32)
      const viewport = pdfPage.getViewport({ scale: width / base.width * zoom })
      const context = canvas.current.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.current.width = Math.ceil(viewport.width * ratio); canvas.current.height = Math.ceil(viewport.height * ratio)
      canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`
      const task = pdfPage.render({ canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
      render = task
      await task.promise
      if (active && notice.isCurrent()) setLoading(false)
    }).catch(() => { if (active && notice.isCurrent()) { notice.show('当前页面显示失败，请联系平台管理员', 'error', `pdf-page:${page}`, true); setLoading(false) } })
    return () => { active = false; render?.cancel() }
  }, [document, page, zoom, capture])
  return <>
    <div className="document-preview-toolbar"><div className="document-preview-pager"><button type="button" title="上一页" aria-label="PDF 上一页" disabled={!document || page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /></button><input type="number" aria-label="PDF 页码" min={1} max={document?.numPages ?? 1} value={page} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && document && value <= document.numPages) setPage(value) }} /><span>/ {document?.numPages ?? '…'}</span><button type="button" title="下一页" aria-label="PDF 下一页" disabled={!document || page >= document.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={17} /></button></div>
      <div className="document-preview-actions"><button type="button" title="缩小" aria-label="缩小 PDF" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><Minus size={16} /></button><span className="document-preview-zoom">{Math.round(zoom * 100)}%</span><button type="button" title="放大" aria-label="放大 PDF" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))}><Plus size={16} /></button></div>
    </div>
    <div className="document-preview-pdf" ref={container}>{loading ? <span role="status"><LoaderCircle size={20} className="animate-spin" />正在显示页面</span> : null}<canvas ref={canvas} role="img" aria-label={`PDF 第 ${page} 页`} /></div>
  </>
}
