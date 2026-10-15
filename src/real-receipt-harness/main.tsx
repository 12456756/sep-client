import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MediaArtifactsPanel } from '../components/workspace/MediaArtifactsPanel'
import '../components/workspace/media-artifacts.css'
import './style.css'

// Only a task identifier crosses into this page; no fixture path, credentials, request or quote.
const taskId = new URLSearchParams(location.search).get('taskId')
createRoot(document.getElementById('root')!).render(<StrictMode><main>
  <h1>已有真实回执 · 本地恢复验收</h1>
  <p>显式 fixture：仅接管已有回执；不证明 Pi、人工审批或员工订阅流程。</p>
  {taskId && /^[A-Za-z0-9_-]{1,128}$/.test(taskId) ? <MediaArtifactsPanel taskId={taskId} /> : <p>缺少验收任务</p>}
</main></StrictMode>)
