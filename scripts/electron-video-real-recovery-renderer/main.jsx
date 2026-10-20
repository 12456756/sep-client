import { createRoot } from 'react-dom/client'
import { VideoTaskPanel } from '../../src/components/workspace/VideoArtifactsPanel'
import '../../src/index.css'
import '../../src/components/workspace/media-artifacts.css'

const tasks = new URLSearchParams(location.search).getAll('taskId')
if (tasks.length !== 2 || tasks.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('INVALID_TASKS')
createRoot(document.getElementById('root')).render(<main style={{ maxWidth: 1100, margin: '24px auto', padding: 24 }}>
  <style>{'.video-creation{display:none}.video-artifacts{margin-top:24px}'}</style>
  <h1 style={{ fontSize: 24 }}>真实视频 · 原任务保存与恢复验收</h1>
  <p>隔离 userData · 两份原已结算成果 · 全程离线 · 不提供生成能力</p>
  <p>保留原任务身份和文件，不代表 Pi 员工流程或生产授权验收。预览由系统原生应用打开。</p>
  {tasks.map(taskId => <div key={taskId} data-task-id={taskId}><VideoTaskPanel taskId={taskId} /></div>)}
</main>)
