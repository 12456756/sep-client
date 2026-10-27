import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FeedbackProvider } from '../../../components/feedback/FeedbackProvider'
import { ChatArrange } from '../../../components/enterprise/arrange/ChatArrange'
import { GoalComposer } from '../../../components/enterprise/arrange/GoalComposer'
import { ManualArrange } from '../../../components/enterprise/arrange/ManualArrange'
import { WorkConversation } from '../../../components/enterprise/WorkTalkDrawer'
import { EmployeeDetailPage } from '../../../pages/enterprise/EmployeeDetailPage'
import { SpeechSettings } from '../../../components/speech/SpeechSettings'
import type { SiliconEmployee, WorkItem } from '../../enterprise/types'
import type { EnterpriseWorkspace } from '../../enterprise/useEnterpriseWorkspace'
import { defaultRunSettings } from '../../enterprise/run-settings'
import { speechInput } from '../speech-input'
import '../../../styles/enterprise.css'
import '../../../styles/arrange.css'

const employee: SiliconEmployee = {
  id: 'employee-test', name: '测试员工', avatar: null, avatarAsset: null, mark: '测', roleName: '', department: null,
  availability: 'ready', assignedToMe: true, intro: '测试员工介绍', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: ['test-model'], skillIds: [], permissions: [], templateVersion: '1.0',
}
const work: WorkItem = {
  id: 'work-a', title: '测试工作', goal: '测试工作', kind: 'conversation', workType: { state: 'resolved', kind: 'conversation' },
  status: 'completed', progress: 100, currentEmployeeId: employee.id, currentEmployeeName: employee.name, steps: [], nextUserAction: null,
  createdAt: 1, startedAt: 1, completedAt: 2, updatedAt: 2, participants: [], deliverables: [], timeline: [], messages: [], activities: [],
  sharedContext: { goal: '', confirmedInputs: [], previousResults: [], userNotes: [] }, stopReason: null, workDir: null,
}

function Harness() {
  const [surface, setSurface] = useState('chat')
  const [sent, setSent] = useState(0)
  const [value, setValue] = useState('')
  const [workId, setWorkId] = useState('work-a')
  const [settings, setSettings] = useState(defaultRunSettings)
  const [employeeId, setEmployeeId] = useState(employee.id)
  const send = () => setSent(count => count + 1)
  const workspace = {
    employees: [employee], myEmployees: [employee], skills: [], busy: false, error: null,
    navigate: () => {}, startConversation: async () => { send(); return true }, sendMessage: async () => { send() }, switchEmployee: async () => {},
  } as unknown as EnterpriseWorkspace
  const shared = { settings, models: ['test-model'], onSettingsChange: (patch: Partial<typeof settings>) => setSettings(current => ({ ...current, ...patch })), onChooseFolder: async () => null }
  return <div className="ent-shell" style={{ display: 'block', height: 'auto', minHeight: '100vh', padding: 24 }}>
    <select aria-label="测试入口" value={surface} onChange={event => setSurface(event.target.value)}>
      {['chat', 'auto', 'manual', 'employee', 'work', 'settings', 'two'].map(item => <option key={item}>{item}</option>)}
    </select>
    <output data-testid="sent">{sent}</output>
    <button type="button" data-testid="switch-work" onClick={() => setWorkId(id => id === 'work-a' ? 'work-b' : 'work-a')}>switch</button>
    <button type="button" data-testid="copy" onClick={() => { void navigator.clipboard.writeText('clipboard-regression') }}>copy</button>
    <button type="button" data-testid="snapshot" onClick={() => { document.body.dataset.speechPhase = speechInput.getSnapshot().phase }}>snapshot</button>
    <main style={{ maxWidth: 1100, margin: '20px auto', position: 'relative' }}>
      {surface === 'chat' ? <ChatArrange employees={[employee]} busy={false} employeeId={employeeId} onEmployeeChange={setEmployeeId} onStart={send} {...shared} /> : null}
      {surface === 'auto' || surface === 'two' ? <GoalComposer value={value} onChange={setValue} placeholder="工作目标" submitLabel="开始" submitDisabled={!value} onSubmit={send} {...shared} /> : null}
      {surface === 'two' ? <ChatArrange employees={[employee]} busy={false} employeeId={employeeId} onEmployeeChange={setEmployeeId} onStart={send} {...shared} /> : null}
      {surface === 'manual' ? <ManualArrange employees={[employee]} busy={false} seed={null} onSave={() => true} onStart={send} {...shared} /> : null}
      {surface === 'employee' ? <EmployeeDetailPage workspace={workspace} employeeId={employeeId} /> : null}
      {surface === 'work' ? <WorkConversation work={{ ...work, id: workId }} workspace={workspace} /> : null}
      {surface === 'settings' ? <SpeechSettings /> : null}
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<FeedbackProvider><Harness /></FeedbackProvider>)
