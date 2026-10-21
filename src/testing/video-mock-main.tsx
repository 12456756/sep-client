import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ToolApprovalDialog } from '../components/ToolApprovalDialog'
import { VideoCreationForm, VideoTaskPanel } from '../components/workspace/VideoArtifactsPanel'
import { MediaCreationForm } from '../components/workspace/MediaArtifactsPanel'
import { MediaPreferenceScopeContext } from '../components/workspace/media-preference-scope'
import type { MediaGenerationInput, MediaProfile } from '../shared/media'
import type { VideoGenerationInput } from '../shared/video-host'
import type { VideoRuntime } from '../shared/video-media'
import type { ToolAuthorizationRequest } from '../shared/types'
import '../index.css'
import '../components/workspace/media-artifacts.css'

const imageProfiles: MediaProfile[] = ['a', 'b'].map(suffix => ({
  profileId: `image-synthetic-${suffix}`, kind: 'image', displayName: `合成图片模型 ${suffix.toUpperCase()}`,
  configVersion: 'image-ui-v2', operations: ['generate', 'edit'], executionMode: 'sync-response',
  capabilities: { referenceImage: true, cancel: false, recoverByRequestId: true },
  allowedAspectRatios: ['1:1', '3:2', '2:3'], allowedSizes: ['1024x1024', '1536x1024', '1024x1536'],
  allowedQualities: ['low', 'medium', 'high'], defaultSize: suffix === 'b' ? '1536x1024' : '1024x1024', defaultQuality: 'high', maxCount: 4,
}))
const fixedAudioRuntime: VideoRuntime = {
  protocolVersion: 2, executionMode: 'real', executionAvailable: true, defaultProfileId: 'synthetic-h3', tools: ['video_generate', 'video_get_job'],
  profiles: [{
    profileId: 'synthetic-h3', kind: 'video', displayName: '合成 H3 固定音轨', configVersion: 'video-ui-v2', executionMode: 'async-query', operations: ['text-to-video'],
    capabilities: {
      supportsTextToVideo: true, supportsImageToVideo: false, supportsAudio: true, durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24],
      maxInputBytes: 2048, maxReferenceCount: 0, outputFormats: ['video/mp4'], supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 3600,
      audioModes: [true], defaultAudio: true, defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', frameRate: 24, audio: true, outputFormat: 'video/mp4' },
    },
  }],
}

function MediaParameterFixture() {
  const [narrow, setNarrow] = useState(false)
  const [removeDefault, setRemoveDefault] = useState(false)
  const [member, setMember] = useState('member-a')
  const [fixedAudio, setFixedAudio] = useState(false)
  const [imageInput, setImageInput] = useState<MediaGenerationInput | null>(null)
  const [videoInput, setVideoInput] = useState<VideoGenerationInput | null>(null)
  const profiles = imageProfiles.filter(profile => !removeDefault || profile.profileId !== 'image-synthetic-b').map(profile => narrow ? {
    ...profile, configVersion: 'image-ui-v2-narrow', allowedAspectRatios: ['1:1'], allowedSizes: ['1024x1024'],
    allowedQualities: ['medium'], defaultSize: '1024x1024', defaultQuality: 'medium', maxCount: 1,
  } : profile)
  return <>
    <section aria-label="图片参数联动验收">
      <h2>图片参数联动 · 仅本地表单</h2>
      <div className="media-job-actions">
        <button type="button" onClick={() => setNarrow(value => !value)}>{narrow ? '恢复图片规格' : '收紧图片规格'}</button>
        <button type="button" onClick={() => setRemoveDefault(value => !value)}>{removeDefault ? '恢复默认图片模型' : '移除默认图片模型'}</button>
        <button type="button" onClick={() => setMember(value => value === 'member-a' ? 'member-b' : 'member-a')}>切换参数偏好身份</button>
      </div>
      <p data-testid="media-preference-member">{member}</p>
      <MediaPreferenceScopeContext.Provider key={member} value={{ enterpriseId: 'synthetic-enterprise', memberId: member }}>
        <MediaCreationForm taskId="image-parameter-fixture" profiles={profiles} defaultProfileId="image-synthetic-b" references={[]} archived={false} busy={false}
          onImport={() => undefined} onPreview={() => undefined} onGenerate={setImageInput} />
      </MediaPreferenceScopeContext.Provider>
      <output style={{ overflowWrap: 'anywhere' }} data-testid="image-parameters-submit">{imageInput ? JSON.stringify(imageInput) : ''}</output>
    </section>
    <button type="button" onClick={() => setFixedAudio(value => !value)}>{fixedAudio ? '收起固定音轨验收' : '展开固定音轨验收'}</button>
    {fixedAudio && <section aria-label="固定音轨参数验收">
      <h2>合成 H3 · 仅本地提交，不请求网关</h2>
      <VideoCreationForm taskId="video-fixed-audio-fixture" runtime={fixedAudioRuntime} references={[]} busy={false} onImport={() => undefined} onGenerate={setVideoInput} />
      <output style={{ overflowWrap: 'anywhere' }} data-testid="video-fixed-audio-submit">{videoInput ? JSON.stringify(videoInput) : ''}</output>
    </section>}
  </>
}

function VideoMockWindow() {
  const [request, setRequest] = useState<ToolAuthorizationRequest | null>(null)
  useEffect(() => window.electronAPI.onToolApprovalRequest(setRequest), [])
  const respond = useCallback((approved: boolean) => {
    if (!request) return
    window.electronAPI.sendToolApprovalResponse({ requestId: request.requestId, approved })
    setRequest(null)
  }, [request])
  const approve = useCallback(() => respond(true), [respond])
  const deny = useCallback(() => respond(false), [respond])
  return <main style={{ maxWidth: 1080, margin: '40px auto', padding: 24 }}>
    <h1 style={{ fontSize: 24 }}>电商视频工作台</h1>
    <p style={{ color: '#625c5c', marginBottom: 24 }}>隔离验收窗口 · 模拟企业与任务 · 显式 mock · 不调用真实模型、不扣费</p>
    <VideoTaskPanel taskId="video-task-a" />
    <MediaParameterFixture />
    <ToolApprovalDialog request={request} onApprove={approve} onDeny={deny} />
  </main>
}

createRoot(document.getElementById('root')!).render(<VideoMockWindow />)
