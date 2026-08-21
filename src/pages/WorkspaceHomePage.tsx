import { useMemo, useState } from 'react';
import { Bot, Check, Download, Filter, FolderKanban, MessageSquareText, Wrench } from 'lucide-react';
import { ConversationView } from '../components/workspace/ConversationView';
import { WorkspaceComposer } from '../components/workspace/WorkspaceComposer';
import { WorkspaceSidebar } from '../components/workspace/WorkspaceSidebar';
import { WorkflowView } from '../components/workspace/WorkflowView';
import { useWorkspaceDemo, type TaskStatus } from '../features/workspace/useWorkspaceDemo';
import type { EmployeeInstanceSnapshot } from '../shared/types';

interface Props { userName: string; enterpriseName?: string; employeeInstanceId: string; employeeInstanceName: string; instances?: EmployeeInstanceSnapshot[]; onLogout: () => Promise<void> }
const statusLabel: Record<TaskStatus, string> = { queued: '排队中', running: '运行中', 'waiting-approval': '待审批', completed: '已完成', failed: '失败', cancelled: '已取消', stopped: '已停止' };

export function WorkspaceHomePage({ userName, enterpriseName, employeeInstanceId, employeeInstanceName, instances, onLogout }: Props) {
  const workspace = useWorkspaceDemo({ employeeInstanceId, employeeName: employeeInstanceName, instances });
  const [mode, setMode] = useState<'conversation' | 'workflow'>('conversation');
  const [navigationBusy, setNavigationBusy] = useState(false);
  const selectedTask = workspace.tasks.find((item) => item.id === workspace.selectedTaskId);
  const activeEmployee = workspace.employees.find((item) => item.id === workspace.conversationDraft.employeeId);
  const models = activeEmployee?.modelOptions ?? workspace.employees[0]?.modelOptions ?? [];
  const filteredTasks = useMemo(() => workspace.tasks.filter((task) => !workspace.filters.status.length || workspace.filters.status.includes(task.status)), [workspace.tasks, workspace.filters.status]);
  const navigate = async (action: () => Promise<void>) => { setNavigationBusy(true); try { await action(); } finally { setNavigationBusy(false); } };
  const newTask = () => { workspace.newTask(); setMode('conversation'); };

  const renderResource = () => {
    if (workspace.view === 'employees') return <ResourcePage icon={<Bot size={26} />} title="硅基员工" subtitle={`企业授权给你的 ${workspace.employees.length} 名 AI 员工。新建任务时选择执行身份。`} items={workspace.employees.map((item) => ({ title: item.displayName, description: item.description, meta: `${item.modelOptions.length} 个可用模型`, action: '查看员工' }))} />;
    if (workspace.view === 'skills') return <ResourcePage icon={<Wrench size={26} />} title="技能" subtitle="安装是客户端资源准备，启用关系只属于当前任务。" items={workspace.skills.map((item) => ({ title: item.name, description: `${item.description} · v${item.version}`, meta: item.installed ? '已安装，可在任务中启用' : '可下载', action: item.installed ? '已安装' : '下载', disabled: item.installed }))} onAction={(index) => workspace.installSkill(workspace.skills[index].id)} />;
    if (workspace.view === 'workflows') return <ResourcePage icon={<FolderKanban size={26} />} title="已授权工作流" subtitle={`${enterpriseName || '当前企业'}分配给你的工作流模板。`} items={workspace.workflows.map((item) => ({ title: item.name, description: item.description, meta: `v${item.version} · ${item.inputs.length} 个输入参数`, action: '使用工作流' }))} onAction={() => { workspace.newTask(); setMode('workflow'); workspace.setView('tasks'); }} />;
    if (workspace.view === 'status') return <StatusPage tasks={filteredTasks} onSelect={workspace.selectTask} />;
    if (selectedTask) return selectedTask.type === 'conversation' ? <ConversationView task={selectedTask} onStop={workspace.stopTask} onRetry={workspace.retryTask} onModelChange={workspace.switchTaskModel} models={models} /> : <WorkflowView task={selectedTask} onCancel={workspace.cancelTask} onRetry={workspace.retryTask} />;
    return <WelcomePage userName={userName} mode={mode} onMode={setMode} />;
  };

  return (
    <main className="workspace-shell">
      <div className="workspace-titlebar electron-drag-region" aria-hidden="true" />
      <WorkspaceSidebar expanded={workspace.sidebarExpanded} view={workspace.view} tasks={workspace.tasks} selectedTaskId={workspace.selectedTaskId} filters={workspace.filters} onToggle={() => workspace.setSidebarExpanded(!workspace.sidebarExpanded)} onNew={newTask} onView={workspace.setView} onSelectTask={workspace.selectTask} onFilters={workspace.setFilters} onLogout={() => void navigate(onLogout)} />
      <section className="workspace-main">
        <div className="workspace-canvas">
          {workspace.error && <div className="workspace-inline-error workspace-page-error">{workspace.error}</div>}
          <div className="workspace-content">{renderResource()}</div>
          {workspace.view === 'tasks' && !selectedTask && (
            <div className="workspace-docked-composer">
              <WorkspaceComposer mode={mode} busy={navigationBusy} draft={workspace.conversationDraft} employees={workspace.employees} skills={workspace.skills} workflows={workspace.workflows} onDraftChange={workspace.updateConversationDraft} onConversationSubmit={workspace.createConversationTask} onWorkflowSubmit={workspace.createWorkflowTask} />
            </div>
          )}
          {workspace.view === 'tasks' && selectedTask?.type === 'conversation' && (
            <div className="workspace-docked-composer">
              <WorkspaceComposer compact mode="conversation" busy={selectedTask.status === 'queued' || selectedTask.status === 'running'} draft={workspace.conversationDraft} employees={workspace.employees} skills={workspace.skills} workflows={workspace.workflows} currentTask={selectedTask} onDraftChange={workspace.updateConversationDraft} onConversationSubmit={workspace.sendMessage} onWorkflowSubmit={workspace.createWorkflowTask} />
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function WelcomePage({ userName, mode, onMode }: { userName: string; mode: 'conversation' | 'workflow'; onMode: (mode: 'conversation' | 'workflow') => void }) {
  return (
    <div className="workspace-home">
      <div className="workspace-home-heading">
        <h1>你好，{userName}</h1>
        <p>今天想让你的硅基员工帮你做什么？</p>
      </div>
      <div className="workspace-home-mode" role="tablist" aria-label="任务类型">
        <button role="tab" aria-selected={mode === 'conversation'} className={mode === 'conversation' ? 'active' : ''} onClick={() => onMode('conversation')}><MessageSquareText size={15} />对话任务</button>
        <button role="tab" aria-selected={mode === 'workflow'} className={mode === 'workflow' ? 'active' : ''} onClick={() => onMode('workflow')}><FolderKanban size={15} />工作流任务</button>
      </div>
    </div>
  );
}

function ResourcePage({ icon, title, subtitle, items, onAction }: { icon: React.ReactNode; title: string; subtitle: string; items: { title: string; description: string; meta: string; action: string; disabled?: boolean }[]; onAction?: (index: number) => void }) {
  return <div className="resource-page"><header><div className="resource-heading-icon">{icon}</div><div><small>个人可用资源</small><h1>{title}</h1><p>{subtitle}</p></div><button className="workspace-secondary-button"><Filter size={15} />筛选</button></header><div className="resource-grid">{items.map((item, index) => <article key={item.title}><div className="resource-card-icon"><Check size={17} /></div><div><h2>{item.title}</h2><p>{item.description}</p><small>{item.meta}</small></div>{onAction && <button className="workspace-secondary-button" onClick={() => onAction(index)} disabled={item.disabled}>{item.action === '下载' ? <Download size={14} /> : <Check size={14} />}{item.action}</button>}</article>)}</div></div>;
}

function StatusPage({ tasks, onSelect }: { tasks: ReturnType<typeof useWorkspaceDemo>['tasks']; onSelect: (id: string) => void }) {
  const groups: TaskStatus[] = ['queued', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'stopped'];
  return <div className="status-page"><header><div><small>仅当前账号</small><h1>任务状态</h1><p>查看你创建的所有对话任务和工作流任务。</p></div><span className="status-count"><Check size={15} />{tasks.length} 个任务</span></header><div className="status-groups">{groups.map((status) => <section key={status}><h2>{statusLabel[status]} <small>{tasks.filter((task) => task.status === status).length}</small></h2>{tasks.filter((task) => task.status === status).map((task) => <button key={task.id} onClick={() => onSelect(task.id)}><span className={`workspace-task-status-dot ${task.status}`} /><span><strong>{task.title}</strong><small>{task.employeeName} · {task.type === 'conversation' ? '对话任务' : '工作流任务'}</small></span></button>)}</section>)}</div></div>;
}
