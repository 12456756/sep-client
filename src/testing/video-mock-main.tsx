import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ToolApprovalDialog } from '../components/ToolApprovalDialog'
import { VideoTaskPanel } from '../components/workspace/VideoArtifactsPanel'
import type { ToolAuthorizationRequest } from '../shared/types'
import '../index.css'
import '../components/workspace/media-artifacts.css'

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
    <ToolApprovalDialog request={request} onApprove={approve} onDeny={deny} />
  </main>
}

createRoot(document.getElementById('root')!).render(<VideoMockWindow />)
