import { LoaderCircle, Play, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ArrangementMediaSummary } from '../../shared/types'
import { useOperationFeedback } from '../feedback/use-operation-feedback'
import { operationFailure, responseError } from '../../shared/arrangement-feedback'

type PreviewTarget = {
  kind: 'image' | 'video'
  artifactId: string
  jobId?: string
  outputId?: string
}

function phaseLabel(phase: ArrangementMediaSummary['phase']): string {
  switch (phase) {
    case 'preparing': return '准备中'
    case 'awaiting-approval': return '等待确认'
    case 'submitted': return '等待生成'
    case 'tracking': return '生成中'
    case 'saving': return '保存中'
    case 'materializing': return '整理结果中'
    case 'ready': return '已完成'
    case 'blocked': return '交付受阻'
  }
}

function MediaPreviewDialog({ taskId, target, onClose }: { taskId: string; target: PreviewTarget; onClose: () => void }) {
  const { capture } = useOperationFeedback(`${taskId}:${target.artifactId}`)
  const operation = target.kind === 'image' ? 'imagePreview' : 'videoPreview'
  const dialog = useRef<HTMLDialogElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [])

  useEffect(() => {
    let active = true
    const notice = capture()
    const failed = (message: string) => {
      if (!active || !notice.isCurrent()) return
      setError(message)
      notice.show(message, 'error', `arrangement-preview:${taskId}:${target.artifactId}`, true)
    }
    let objectUrl: string | null = null
    setUrl(null); setOpened(false); setError(null)
    const load = async () => {
      try {
        const result = target.kind === 'image'
          ? await window.electronAPI.previewMediaAsset({ taskId, assetId: target.artifactId })
          : await window.electronAPI.previewVideoOutput({ taskId, jobId: target.jobId!, outputId: target.outputId! })
        if (!active || !notice.isCurrent()) return
        if (!result.success || !result.data) { failed(responseError(result, operation).message); return }
        if ('opened' in result.data && result.data.opened === true) { setOpened(true); return }
        if (!('bytes' in result.data) || !(result.data.bytes instanceof Uint8Array)) { failed(operationFailure(operation)); return }
        const mime = result.data.mime
        const allowed = target.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'] : ['video/mp4', 'video/webm']
        if (!allowed.includes(mime) || result.data.bytes.byteLength === 0) { failed(operationFailure(operation)); return }
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.data.bytes).buffer], { type: mime }))
        setUrl(objectUrl)
      } catch { failed(operationFailure(operation)) }
    }
    void load()
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [taskId, target, operation, capture])
  const decodeFailure = () => { setError(operationFailure(operation)); capture().show(operationFailure(operation), 'error', `arrangement-preview:${taskId}:${target.artifactId}`, true) }

  return <dialog ref={dialog} className="media-preview-dialog" aria-label="编排媒体预览" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="media-dialog-heading"><strong>{target.kind === 'image' ? '图片预览' : '视频预览'}</strong><button type="button" className="media-icon-button" title="关闭预览" aria-label="关闭预览" onClick={onClose}><X size={18} /></button></div>
    {error ? null
      : url && target.kind === 'image' ? <img className="media-preview-image" src={url} alt="编排生成的图片" onError={decodeFailure} />
        : url && target.kind === 'video' ? <video className="video-player" src={url} controls preload="metadata" playsInline aria-label="编排生成的视频" onError={decodeFailure} />
          : <p className="media-notice" role="status">{opened ? '已在系统播放器打开' : <><LoaderCircle size={14} />正在读取媒体</>}</p>}
  </dialog>
}

export function ArrangementMediaPanel({ taskId, media }: { taskId: string; media: ArrangementMediaSummary[] }) {
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  if (!media.length) return null
  return <section className="artifact-section media-artifacts arrangement-media-artifacts media-results-compact" aria-label="编排媒体成果">
    <div className="media-jobs">
      {media.map(summary => {
        const saved = summary.outputs.filter(output => output.status === 'saved')
        const first = saved[0]
        const canPreview = summary.kind === 'image' ? !!first : !!first?.outputId && !!summary.jobId
        const issue = summary.phase === 'blocked'
        const pending = !['ready', 'blocked'].includes(summary.phase)
        return <article className="media-job" key={`${summary.nodeRunId}:${summary.jobId}`}>
          {pending || issue ? <p className={`media-result-status${issue ? ' error' : ''}`} role={issue ? 'alert' : 'status'}>{phaseLabel(summary.phase)}</p> : null}
          {saved.length ? <div className="media-job-actions">
            {saved.map((output, index) => <button key={output.artifactId} type="button" className="media-command" onClick={() => {
              if (summary.kind === 'image') setPreview({ kind: 'image', artifactId: output.artifactId })
              else if (output.outputId) setPreview({ kind: 'video', artifactId: output.artifactId, jobId: summary.jobId, outputId: output.outputId })
            }} disabled={!canPreview || (summary.kind === 'video' && !output.outputId)}><Play size={13} />预览{summary.kind === 'image' ? '图片' : '视频'} {index + 1}</button>)}
          </div> : !pending && !issue ? <p className="media-notice">暂无可预览的媒体</p> : null}
        </article>
      })}
    </div>
    {preview ? <MediaPreviewDialog taskId={taskId} target={preview} onClose={() => setPreview(null)} /> : null}
  </section>
}
