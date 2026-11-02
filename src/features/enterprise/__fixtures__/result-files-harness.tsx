import { FeedbackProvider } from '../../../components/feedback/FeedbackProvider'
import { WorkDetailPage } from '../../../pages/enterprise/WorkDetailPage'
import type { WorkDeliverable, WorkItem } from '../types'
import type { EnterpriseWorkspace } from '../useEnterpriseWorkspace'
import '../../../index.css'
import '../../../styles/enterprise.css'
import '../../../styles/work-hub.css'
import '../../../styles/work-detail.css'

const files: WorkDeliverable[] = [
  { id: 'node:image', nodeId: 'node', deliverableId: 'image', name: 'product.png', format: 'png', path: '', note: '' },
  { id: 'node:video', nodeId: 'node', deliverableId: 'video', name: 'product.mp4', format: 'mp4', path: '', note: '' },
  { id: 'node:document', nodeId: 'node', deliverableId: 'document', name: 'brief.md', format: 'md', path: '', note: '' },
]

export function ResultFilesHarness() {
  const conversation = new URLSearchParams(window.location.search).has('conversation')
  const work: WorkItem = {
    id: 'results-test', title: '商品主图与展示视频', goal: '制作商品主图与展示视频', kind: 'flow',
    workType: { state: 'resolved', kind: 'arrangement' }, status: 'completed', progress: 100,
    currentEmployeeId: 'employee', currentEmployeeName: '商品创作员工', steps: [], nextUserAction: null,
    createdAt: 1, startedAt: 1, completedAt: 2, updatedAt: 2, isActive: false, participants: [], deliverables: files, timeline: [], messages: [], activities: [],
    sharedContext: { goal: '商品主图与展示视频', confirmedInputs: [], previousResults: [], userNotes: [] },
    stopReason: null, workDir: null,
    arrangementExecution: { activeRunId: null, status: 'completed', updatedAt: 2, nodes: [] },
  }
  const item: WorkItem = conversation ? { ...work, id: 'conversation-test', kind: 'conversation',
    workType: { state: 'resolved', kind: 'conversation' }, deliverables: [], arrangementExecution: undefined } : work
  const workspace = { works: [item], employees: [], myEmployees: [], busy: false, canGoBack: false, attachmentScopeKey: 'result-test' } as unknown as EnterpriseWorkspace
  return <FeedbackProvider><main className="ent-shell" style={{ height: '100dvh' }}><div className="ent-work-hub" style={{ flex: 1, minWidth: 0 }}>
    <WorkDetailPage workspace={workspace} workId={item.id} />
  </div></main></FeedbackProvider>
}
