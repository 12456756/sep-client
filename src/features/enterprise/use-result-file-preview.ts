import { useEffect, useRef, useState } from 'react'
import type { ResultFileRequest } from '../../shared/result-files'

export interface ResultFilePreviewSource {
  url: string
  mime: string
  kind: 'image' | 'video'
}

export function useResultFilePreview(request: ResultFileRequest, version?: string) {
  const [preview, setPreview] = useState<ResultFilePreviewSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const disposeRef = useRef<(() => void) | null>(null)
  const { taskId } = request
  const nodeId = 'nodeId' in request ? request.nodeId : undefined
  const deliverableId = 'deliverableId' in request ? request.deliverableId : undefined
  const fileId = 'fileId' in request ? request.fileId : undefined
  useEffect(() => {
    let active = true
    let url: string | undefined
    let released = false
    const release = (value: string) => { void window.electronAPI.releaseResultFilePreview({ url: value }).catch(() => undefined) }
    const releaseCurrent = () => {
      if (!url || released) return
      released = true
      release(url)
    }
    const dispose = () => {
      active = false
      releaseCurrent()
      if (disposeRef.current === dispose) disposeRef.current = null
    }
    disposeRef.current = dispose
    setPreview(null)
    setError(null)
    const input: ResultFileRequest = nodeId && deliverableId ? { taskId, nodeId, deliverableId } : { taskId, fileId: fileId! }
    void window.electronAPI.previewResultFile(input).then(result => {
      if (result.success && result.data) {
        url = result.data.url
        if (!active) { releaseCurrent(); return }
        setPreview(result.data)
      } else if (active) setError(result.error?.message || '媒体暂时无法读取，请重试。')
    }).catch(() => { if (active) setError('媒体暂时无法读取，请重试。') })
    return dispose
  }, [taskId, nodeId, deliverableId, fileId, version, attempt])
  return {
    preview,
    error,
    retry: () => setAttempt(value => value + 1),
    fail: () => {
      disposeRef.current?.()
      setPreview(null)
      setError('媒体无法显示，请重试或打开所在文件夹查看。')
    },
  }
}
