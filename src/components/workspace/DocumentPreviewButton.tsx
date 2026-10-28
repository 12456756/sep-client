import { Eye, LoaderCircle } from 'lucide-react'
import { Component, useState, type ComponentType, type ReactNode } from 'react'
import { useOperationFeedback } from '../feedback/use-operation-feedback'
import { operationFailure } from '../../shared/arrangement-feedback'
import { supportsDocumentPreview, type DocumentPreviewRequest } from '../../shared/document-preview'
import type { DocumentPreviewDialogProps } from './DocumentPreviewDialog'

interface Props extends DocumentPreviewRequest { name: string; format: string; version?: string }

class PreviewBoundary extends Component<{ children: ReactNode; onClose(): void; onFailure(): void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch() { this.props.onFailure() }
  render() {
    if (!this.state.failed) return this.props.children
    return <span><button type="button" className="ent-btn sm" onClick={this.props.onClose}>关闭</button></span>
  }
}

export function DocumentPreviewButton(props: Props) {
  const { capture } = useOperationFeedback(`${props.taskId}:${props.nodeId}:${props.deliverableId}`)
  const [Dialog, setDialog] = useState<ComponentType<DocumentPreviewDialogProps> | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  if (!supportsDocumentPreview(props.format)) return null
  const show = async () => {
    const notice = capture()
    setError(false)
    if (Dialog) { setOpen(true); return }
    setLoading(true)
    try {
      const module = await import('./DocumentPreviewDialog')
      if (notice.isCurrent()) { setDialog(() => module.default); setOpen(true) }
    } catch { if (notice.isCurrent()) { setError(true); notice.show(operationFailure('documentPreview')) } }
    finally { if (notice.isCurrent()) setLoading(false) }
  }
  return <>
    <button type="button" className="ent-btn sm" title={error ? '预览加载失败，点击重试' : '预览文档'} aria-label={`预览文档：${props.name}`} disabled={loading} onClick={() => void show()}>
      {loading ? <LoaderCircle size={14} className="animate-spin" /> : <Eye size={14} />}<span>{error ? '重试' : '预览'}</span>
    </button>
    {Dialog && open ? <PreviewBoundary onFailure={() => capture().show(operationFailure('documentPreview'))} onClose={() => setOpen(false)}><Dialog {...props} onClose={() => setOpen(false)} /></PreviewBoundary> : null}
  </>
}
