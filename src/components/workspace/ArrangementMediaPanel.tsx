import { Image as ImageIcon, LoaderCircle, Play, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ArrangementMediaSummary } from '../../shared/types'

type PreviewTarget = {
  kind: 'image' | 'video'
  artifactId: string
  jobId?: string
  outputId?: string
}

function label(summary: ArrangementMediaSummary): string {
  if (summary.kind === 'image') return summary.operation === 'edit' ? '图片编辑' : '图片生成'
  return summary.operation === 'image-to-video' ? '图片生成视频' : '文字生成视频'
}

function MediaPreviewDialog({ taskId, target, onClose }: { taskId: string; target: PreviewTarget; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
    return () => { if (dialog.current?.open) dialog.current.close() }
  }, [])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    setUrl(null); setOpened(false); setError(null)
    const load = async () => {
      try {
        const result = target.kind === 'image'
          ? await window.electronAPI.previewMediaAsset({ taskId, assetId: target.artifactId })
          : await window.electronAPI.previewVideoOutput({ taskId, jobId: target.jobId!, outputId: target.outputId! })
        if (!active) return
        if (!result.success || !result.data) { setError(result.error?.message || '媒体预览读取失败'); return }
        if ('opened' in result.data && result.data.opened === true) { setOpened(true); return }
        if (!('bytes' in result.data) || !(result.data.bytes instanceof Uint8Array)) { setError('媒体预览数据无效'); return }
        const mime = result.data.mime
        const allowed = target.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'] : ['video/mp4', 'video/webm']
        if (!allowed.includes(mime) || result.data.bytes.byteLength === 0) { setError('媒体预览数据无效'); return }
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.data.bytes).buffer], { type: mime }))
        setUrl(objectUrl)
      } catch { if (active) setError('媒体预览读取失败') }
    }
    void load()
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [taskId, target])

  return <dialog ref={dialog} className="media-preview-dialog" aria-label="编排媒体预览" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="media-dialog-heading"><strong>{target.kind === 'image' ? '图片预览' : '视频预览'}</strong><button type="button" className="media-icon-button" title="关闭预览" aria-label="关闭预览" onClick={onClose}><X size={18} /></button></div>
    {error ? <p className="media-notice media-tone-error" role="alert">{error}</p>
      : url && target.kind === 'image' ? <img className="media-preview-image" src={url} alt="编排生成的图片" />
        : url && target.kind === 'video' ? <video className="video-player" src={url} controls preload="metadata" playsInline aria-label="编排生成的视频" />
          : <p className="media-notice" role="status">{opened ? '已在系统播放器打开' : <><LoaderCircle size={14} />正在读取媒体</>}</p>}
  </dialog>
}

export function ArrangementMediaPanel({ taskId, media }: { taskId: string; media: ArrangementMediaSummary[] }) {
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  if (!media.length) return null
  return <section className="artifact-section media-artifacts arrangement-media-artifacts" aria-label="编排媒体成果">
    <h3><ImageIcon size={15} />编排媒体成果</h3>
    <div className="media-jobs">
      {media.map(summary => {
        const saved = summary.outputs.filter(output => output.status === 'saved')
        const first = saved[0]
        const canPreview = summary.kind === 'image' ? !!first : !!first?.outputId && !!summary.jobId
        return <article className="media-job" key={`${summary.nodeRunId}:${summary.jobId}`}>
          <div className="media-job-heading"><strong>{label(summary)}</strong><span>{summary.phase === 'ready' ? '已保存' : summary.phase === 'blocked' ? '交付受阻' : '处理中'}</span></div>
          <small className="media-job-id">节点 {summary.nodeId} · 任务 {summary.jobId}</small>
          {saved.length ? <div className="media-job-actions">
            {saved.map((output, index) => <button key={output.artifactId} type="button" className="media-command" onClick={() => {
              if (summary.kind === 'image') setPreview({ kind: 'image', artifactId: output.artifactId })
              else if (output.outputId) setPreview({ kind: 'video', artifactId: output.artifactId, jobId: summary.jobId, outputId: output.outputId })
            }} disabled={!canPreview || (summary.kind === 'video' && !output.outputId)}><Play size={13} />预览成果 {index + 1}</button>)}
          </div> : <p className="media-notice">尚未保存可预览的媒体成果。</p>}
          {summary.phase === 'blocked' && <p className="media-notice media-tone-error">媒体交付存在冲突，请重试保存；已保存的其他成果仍可预览。</p>}
        </article>
      })}
    </div>
    {preview ? <MediaPreviewDialog taskId={taskId} target={preview} onClose={() => setPreview(null)} /> : null}
  </section>
}
