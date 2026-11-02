import { useEffect, useMemo, useState } from 'react'
import type { MediaAssetView, MediaTaskView } from '../../shared/media'

export function groupSavedConversationImages(taskId: string, view: MediaTaskView): Map<string, MediaAssetView[]> {
  const byRun = new Map<string, MediaAssetView[]>()
  const seen = new Set<string>()
  for (const job of view.jobs) {
    if (job.taskId !== taskId || !job.runId) continue
    for (const asset of job.assets) {
      if (asset.taskId !== taskId || asset.source !== 'output' || asset.status !== 'SAVED' || seen.has(asset.localAssetId)) continue
      seen.add(asset.localAssetId)
      byRun.set(job.runId, [...(byRun.get(job.runId) ?? []), asset])
    }
  }
  return byRun
}

export function ConversationMedia({ taskId, visible = true }: { taskId: string; visible?: boolean }) {
  const [view, setView] = useState<MediaTaskView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const result = await window.electronAPI.getTaskMedia(taskId)
        if (!active) return
        if (result.success && result.data) { setView(result.data); setError(null) }
        else if (result.error) setError(result.error.message)
      } catch { if (active) setError('图片成果暂时无法读取') }
    }
    void refresh()
    if (!visible) return () => { active = false }
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [taskId, visible, retry])
  const groups = useMemo<Map<string, MediaAssetView[]>>(() => view ? groupSavedConversationImages(taskId, view) : new Map<string, MediaAssetView[]>(), [taskId, view])
  if (!groups.size) return error ? <p className="ent-talk-media-status">{error}</p> : null
  return <div className="ent-talk-media" aria-label="本轮图片成果">
    {[...groups.entries()].map(([runId, assets]) => <div className="ent-talk-media-run" key={runId}>
      <small>已生成并保存 · {assets.length} 张</small>
      <div className="ent-talk-media-grid">{assets.map(asset => <ConversationAsset key={asset.localAssetId} taskId={taskId} asset={asset} onRetry={() => setRetry(value => value + 1)} />)}</div>
    </div>)}
  </div>
}

function ConversationAsset({ taskId, asset, onRetry }: { taskId: string; asset: MediaAssetView; onRetry: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    setUrl(null); setFailed(false)
    void window.electronAPI.previewMediaAsset({ taskId, assetId: asset.localAssetId }).then(result => {
      if (!active || !result.success || !result.data) { if (active) setFailed(true); return }
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.data.bytes)], { type: result.data.mime }))
      setUrl(objectUrl)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [taskId, asset.localAssetId])
  return <figure className="ent-talk-media-asset">
    {url && !failed ? <img src={url} alt="图片成果" onError={() => setFailed(true)} /> : <button type="button" onClick={onRetry}>{failed ? '重新读取图片' : '读取图片…'}</button>}
    <figcaption>{asset.width} × {asset.height}</figcaption>
  </figure>
}
