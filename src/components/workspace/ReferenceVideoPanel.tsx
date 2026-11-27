import { Film, LoaderCircle, RotateCcw, Trash2, Upload, VideoIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { VideoRuntime } from '../../shared/video-media'
import type { VideoReferenceView } from '../../shared/video-references'
import type { IpcCommandResult } from '../../shared/ipc'
import { responseError } from '../../shared/arrangement-feedback'
import { useOperationFeedback } from '../feedback/use-operation-feedback'

export function ReferenceVideoPanel({ taskId, runtime, assets, onChanged }: {
  taskId: string; runtime: VideoRuntime; assets: VideoReferenceView[]; onChanged(): Promise<void>
}) {
  const profiles = runtime.protocolVersion === 3 && runtime.executionMode === 'real' && runtime.executionAvailable && runtime.tools.includes('video_from_video')
    ? runtime.profiles.filter(profile => profile.operations.includes('video-to-video') && profile.videoReferenceSupport?.maxCount) : []
  const [chosenProfile, setProfile] = useState('')
  const profile = profiles.find(profile => profile.profileId === chosenProfile) ?? profiles.find(profile => profile.profileId === runtime.defaultProfileId) ?? profiles[0]
  const [pending, setPending] = useState<Set<string>>(new Set())
  const active = useRef(new Set<string>())
  const alive = useRef(true)
  const { capture } = useOperationFeedback(taskId)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [taskId])
  if (!profiles.length && !assets.length) return null

  async function run(key: string, call: (current: () => boolean) => Promise<IpcCommandResult>) {
    if (active.current.has(key)) return
    active.current.add(key); setPending(new Set(active.current))
    const notice = capture()
    try {
      const result = await call(() => alive.current && notice.isCurrent())
      if (!alive.current || !notice.isCurrent()) return
      if (!result.success) notice.show(responseError(result, 'videoImport').message)
    } catch { if (alive.current && notice.isCurrent()) notice.show('参考视频操作失败，请重试。') }
    finally {
      active.current.delete(key)
      if (alive.current) { setPending(new Set(active.current)); await onChanged() }
    }
  }
  const uploading = assets.some(asset => asset.uploadStatus === 'UPLOADING') || [...pending].some(key => key.startsWith('upload:'))
  return <div className="reference-videos">
    <div className="media-subheading">
      <span>参考视频</span>
      <div className="reference-video-actions">
        {profiles.length > 1 && <select aria-label="参考视频模型" value={profile?.profileId ?? ''} disabled={uploading || pending.has('import')} onChange={event => setProfile(event.target.value)}>
          {profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>)}
        </select>}
        {!!profile && <button type="button" className="media-command" disabled={pending.has('import')} title={`每次最多 ${Math.min(10, profile.videoReferenceSupport!.maxCount)} 个；单个不超过 ${Math.floor(profile.videoReferenceSupport!.maxInputBytes / 1024 / 1024)} MiB；${profile.videoReferenceSupport!.mimeTypes.map(mime => mime === 'video/mp4' ? 'MP4' : 'MOV').join('、')}`} onClick={() => {
          const profileId = profile.profileId
          void run('import', async current => {
            const imported = await window.electronAPI.importReferenceVideos({ taskId, profileId })
            if (!imported.success) return imported
            await onChanged()
            for (const asset of imported.data ?? []) {
              if (!current()) return { success: false }
              const result = await window.electronAPI.uploadReferenceVideo({ taskId, profileId, localAssetId: asset.localAssetId })
              if (!result.success) return result
            }
            return { success: true }
          })
        }}>{pending.has('import') ? <LoaderCircle size={14} className="spin" /> : <VideoIcon size={14} />}导入视频</button>}
      </div>
    </div>
    {assets.length > 0 && <ol className="reference-video-list">{assets.map(asset => {
      const uploadKey = `upload:${asset.localAssetId}`
      const busy = asset.uploadStatus === 'UPLOADING' || pending.has(uploadKey)
      const uploaded = asset.uploadStatus === 'UPLOADED' && asset.uploadProfileId === profile?.profileId
        && asset.uploadConfigVersion === profile.configVersion && Date.parse(asset.uploadExpiresAt ?? '') > Date.now()
      const id = { taskId, localAssetId: asset.localAssetId }
      return <li key={asset.localAssetId}>
        <Film size={16} aria-hidden="true" />
        <div className="reference-video-name"><span title={asset.name}>{asset.name}</span><small>
          {(asset.size / 1024 / 1024).toFixed(1)} MiB · {asset.status === 'MISSING' ? '文件缺失' : busy ? `上传中 ${asset.uploadProgress ?? 0}%` : uploaded ? '已上传' : asset.uploadStatus === 'FAILED' ? '上传失败' : '已导入'}
        </small>{asset.uploadError && <span className="reference-video-error" role="status">{asset.uploadError}</span>}
        {busy && <progress max={100} value={asset.uploadProgress ?? 0} aria-label={`${asset.name} 上传进度`} />}</div>
        <div className="reference-video-actions">
          {busy ? <button type="button" className="media-icon-button" title="取消上传" aria-label={`取消上传 ${asset.name}`} onClick={() => { void run(`cancel:${asset.localAssetId}`, () => window.electronAPI.cancelReferenceVideoUpload(id)) }}><X size={14} /></button>
            : <>
              {!!profile && asset.status === 'SAVED' && <button type="button" className="media-icon-button" title="重新上传参考视频" aria-label={`上传 ${asset.name}`} disabled={pending.has('import')} onClick={() => { void run(uploadKey, () => window.electronAPI.uploadReferenceVideo({ ...id, profileId: profile.profileId })) }}>{asset.uploadStatus === 'FAILED' ? <RotateCcw size={14} /> : <Upload size={14} />}</button>}
              <button type="button" className="media-icon-button" title="移除参考视频" aria-label={`移除 ${asset.name}`} disabled={pending.has(`remove:${asset.localAssetId}`) || pending.has('import')} onClick={() => { void run(`remove:${asset.localAssetId}`, () => window.electronAPI.removeReferenceVideo(id)) }}><Trash2 size={14} /></button>
            </>}
        </div>
      </li>
    })}</ol>}
  </div>
}
