import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReferenceVideoPanel } from '../components/workspace/ReferenceVideoPanel'
import { FeedbackProvider } from '../components/feedback/FeedbackProvider'
import { sepVideoToVideoRuntimeFixture } from '../shared/fixtures/sep-media-runtime-v3'
import { videoRuntimeSchema } from '../shared/video-media'
import type { VideoReferenceView } from '../shared/video-references'
import type { ElectronAPI } from '../shared/ipc'
import '../index.css'
import '../components/workspace/media-artifacts.css'
import '../styles/video-artifacts.css'

const runtime = videoRuntimeSchema.parse(sepVideoToVideoRuntimeFixture())
const taskId = 'reference-video-preview'
function Fixture() {
  const [assets, setAssets] = useState<VideoReferenceView[]>([
    { localAssetId: `vref_${'1'.repeat(32)}`, taskId, name: '商品正面展示.mp4', mime: 'video/mp4', size: 12345678, status: 'SAVED', uploadStatus: 'LOCAL' },
    { localAssetId: `vref_${'2'.repeat(32)}`, taskId, name: '非常长的参考视频文件名称用于验证窄屏布局不会发生文字与操作按钮重叠.mov', mime: 'video/quicktime', size: 23456789, status: 'SAVED', uploadStatus: 'FAILED', uploadError: '参考视频上传超时，请重试上传。' },
  ])
  const patch = (id: string, values: Partial<VideoReferenceView>) => setAssets(assets => assets.map(asset => asset.localAssetId === id ? { ...asset, ...values } : asset))
  const api: Pick<ElectronAPI, 'importReferenceVideos' | 'uploadReferenceVideo' | 'cancelReferenceVideoUpload' | 'removeReferenceVideo'> = {
    importReferenceVideos: async () => ({ success: true, data: [] }),
    uploadReferenceVideo: async ({ localAssetId }) => {
      patch(localAssetId, { uploadStatus: 'UPLOADING', uploadProgress: 35, uploadError: undefined })
      await new Promise(resolve => setTimeout(resolve, 800))
      patch(localAssetId, { uploadStatus: 'UPLOADED', uploadProgress: 100, uploadProfileId: 'video_example', uploadConfigVersion: '1', uploadExpiresAt: new Date(Date.now() + 60_000).toISOString() })
      return { success: true }
    },
    cancelReferenceVideoUpload: async ({ localAssetId }) => { patch(localAssetId, { uploadStatus: 'FAILED', uploadError: '上传已取消。' }); return { success: true } },
    removeReferenceVideo: async ({ localAssetId }) => { setAssets(assets => assets.filter(asset => asset.localAssetId !== localAssetId)); return { success: true } },
  }
  window.electronAPI = { ...window.electronAPI, ...api }
  return <main style={{ maxWidth: 680, margin: '24px auto', padding: 16 }}><ReferenceVideoPanel taskId={taskId} runtime={runtime} assets={assets} onChanged={async () => {}} /></main>
}
createRoot(document.getElementById('root')!).render(<FeedbackProvider><Fixture /></FeedbackProvider>)
