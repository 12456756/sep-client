import { useEffect, useMemo, useState } from 'react'
import type { MediaAssetView, MediaTaskView } from '../../shared/media'
import type { VideoTaskView } from '../../shared/video-host'
import { savedConversationVideos, type ConversationResult } from './conversation-results'

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

export function savedConversationImages(taskId: string, view: MediaTaskView): ConversationResult[] {
  const groups = groupSavedConversationImages(taskId, view)
  const seen = new Set<string>()
  const results: ConversationResult[] = []
  const append = (asset: MediaAssetView, runId?: string) => {
    if (asset.taskId !== taskId || asset.source !== 'output' || asset.status !== 'SAVED' || seen.has(asset.localAssetId)) return
    seen.add(asset.localAssetId)
    const format = asset.mime.split('/')[1]
    results.push({ runId, file: { id: asset.localAssetId, name: `图片成果${results.length + 1}.${format}`, format, path: '', note: '',
      sourceArtifact: { kind: 'image', artifactId: asset.localAssetId, sha256: '' } }, request: { taskId, assetId: asset.localAssetId } })
  }
  for (const [runId, assets] of groups) for (const asset of assets) append(asset, runId)
  for (const asset of [...view.assets, ...view.jobs.filter(job => job.taskId === taskId).flatMap(job => job.assets)]) append(asset)
  return results
}

export function useConversationMedia(taskId: string, scopeKey: string) {
  const [images, setImages] = useState<MediaTaskView | null>(null)
  const [videos, setVideos] = useState<VideoTaskView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setImages(null); setVideos(null); setError(null)
    const refresh = async () => {
      const results = await Promise.allSettled([
        window.electronAPI.getTaskMedia(taskId), window.electronAPI.getTaskVideo(taskId),
      ])
      if (!active) return
      const [imageResult, videoResult] = results
      if (imageResult.status === 'fulfilled' && imageResult.value.success) setImages(imageResult.value.data ?? null)
      if (videoResult.status === 'fulfilled' && videoResult.value.success) setVideos(videoResult.value.data ?? null)
      setError(results.some(result => result.status === 'rejected' || !result.value.success) ? '部分媒体成果暂时无法读取' : null)
      timer = setTimeout(() => { void refresh() }, 3000)
    }
    void refresh()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [taskId, scopeKey, attempt])
  const results = useMemo<ConversationResult[]>(() => {
    const imageResults = images ? savedConversationImages(taskId, images) : []
    return [...imageResults, ...(videos ? savedConversationVideos(taskId, videos) : [])]
  }, [taskId, images, videos])
  return { results, error, retry: () => setAttempt(value => value + 1) }
}
