import { Download, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useOperationFeedback } from '../feedback/use-operation-feedback'
import type { DocumentPreviewRequest } from '../../shared/document-preview'

export function SaveWordCopyButton({ request, name }: { request: DocumentPreviewRequest; name: string }) {
  const { capture } = useOperationFeedback(JSON.stringify(request))
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const notice = capture()
    setSaving(true)
    try {
      const result = await window.electronAPI.saveWordCopy(request)
      if (notice.isCurrent() && !result.success) notice.show(result.error?.message || '暂时无法另存 Word 文件，请重试。')
    } catch { if (notice.isCurrent()) notice.show('暂时无法另存 Word 文件，请重试。') }
    finally { if (notice.isCurrent()) setSaving(false) }
  }
  return <button type="button" className="ent-btn sm" title="另存为" aria-label={'另存为：' + name} disabled={saving} onClick={() => void save()}>
    {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}<span>另存为</span>
  </button>
}
