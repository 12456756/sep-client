import { Bot, ChevronLeft, ChevronRight, FolderOpen, MessageSquareText, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConversationArtifactsPanel } from '../components/workspace/ConversationArtifactsPanel';
import { ConversationView } from '../components/workspace/ConversationView';
import { NewTaskTypePicker } from '../components/workspace/NewTaskTypePicker';
import { TaskCenterCreatePage } from '../components/workspace/TaskCenterCreatePage';
import { TaskCenterHomePage } from '../components/workspace/TaskCenterHomePage';
import { WorkflowView } from '../components/workspace/WorkflowView';
import { WorkspaceComposer } from '../components/workspace/WorkspaceComposer';
import { WorkspaceSidebar } from '../components/workspace/WorkspaceSidebar';
import { useWorkspaceDemo } from '../features/workspace/useWorkspaceDemo';
import type { EmployeeInstanceSnapshot } from '../shared/types';

interface Props { userName: string; enterpriseName?: string; subscriptionId?: string; employeeInstanceName?: string; instances?: EmployeeInstanceSnapshot[]; onLogout: () => Promise<void> }

export function WorkspaceHomePage({ userName, enterpriseName, subscriptionId, employeeInstanceName, instances, onLogout }: Props) {
  const workspace = useWorkspaceDemo({ subscriptionId, employeeName: employeeInstanceName, instances });
  const [mode, setMode] = useState<'conversation' | 'workflow'>('conversation');
  const [artifactsExpanded, setArtifactsExpanded] = useState(() => typeof window === 'undefined' || window.innerWidth > 960);
  const [taskCenterPage, setTaskCenterPage] = useState<'home' | 'create'>('home');
  const [taskCenterTemplateId, setTaskCenterTemplateId] = useState<string | undefined>();
  const selectedTask = workspace.tasks.find(item => item.id === workspace.selectedTaskId);
  const [activeEmployeeId, setActiveEmployeeId] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [workspace.view, selectedTask?.id, taskCenterPage]);

  const startConversation = () => { setMode('conversation'); workspace.setView('tasks'); };
  const startTaskCenter = () => { setMode('workflow'); setTaskCenterTemplateId(undefined); setTaskCenterPage('create'); workspace.setView('workflows'); };
  const newTask = () => workspace.newTask();
  const selectEmployee = (id: string) => { setActiveEmployeeId(id); workspace.updateConversationDraft({ employeeId: id, modelId: workspace.employees.find(item => item.id === id)?.modelOptions[0]?.id || '' }); };
  const selectTask = (id: string) => { const task = workspace.tasks.find(item => item.id === id); if (task?.employeeId) setActiveEmployeeId(task.employeeId); workspace.selectTask(id); };
  const renderContent = () => {
    if (workspace.view === 'new-task') return <NewTaskTypePicker onConversation={startConversation} onTaskCenter={startTaskCenter} />;
    if (workspace.view === 'employees') return <EmployeeResourcePage employees={workspace.employees} onSelect={selectEmployee} />;
    if (workspace.view === 'skills') return <ResourcePage icon={<Wrench size={22} />} title="技能与资源" subtitle="为员工准备可复用的工作能力。" items={workspace.skills.map(skill => ({ title: skill.name, description: skill.description, meta: skill.installed ? '已安装，可在任务中使用' : '可安装', action: skill.installed ? '已安装' : '安装' }))} />;
    if (workspace.view === 'workflows') return taskCenterPage === 'create' ? <TaskCenterCreatePage key={taskCenterTemplateId || 'blank-plan'} employees={workspace.employees} workflows={workspace.workflows} initialWorkflowId={taskCenterTemplateId} onBack={() => setTaskCenterPage('home')} onSubmit={workspace.createWorkflowTask} /> : <TaskCenterHomePage tasks={workspace.tasks} workflows={workspace.workflows} onCreate={workflowId => { setTaskCenterTemplateId(workflowId); setTaskCenterPage('create'); }} onSelectTask={selectTask} onRetry={workspace.retryTask} />;
    if (selectedTask?.type === 'conversation') return <div className={`conversation-layout ${artifactsExpanded ? '' : 'artifacts-collapsed'}`}><div className="conversation-column"><ConversationView task={selectedTask} employees={workspace.employees} activeEmployeeId={activeEmployeeId || selectedTask.employeeId} onStop={workspace.stopTask} onRetry={workspace.retryTask} /><div className="workspace-docked-composer"><WorkspaceComposer compact mode="conversation" busy={selectedTask.status === 'queued' || selectedTask.status === 'running'} draft={workspace.conversationDraft} employees={workspace.employees} skills={workspace.skills} workflows={workspace.workflows} currentTask={selectedTask} activeEmployeeId={activeEmployeeId} onEmployeeChange={selectEmployee} onDraftChange={workspace.updateConversationDraft} onConversationSubmit={workspace.sendMessage} onWorkflowSubmit={workspace.createWorkflowTask} /></div></div>{artifactsExpanded && <ConversationArtifactsPanel task={selectedTask} expanded onToggle={() => setArtifactsExpanded(false)} />}<button className={`conversation-artifacts-launcher ${artifactsExpanded ? 'expanded' : ''}`} type="button" onClick={() => setArtifactsExpanded(value => !value)} aria-expanded={artifactsExpanded} aria-label={artifactsExpanded ? '收起成果与进展' : '展开成果与进展'} title={artifactsExpanded ? '收起成果与进展' : '展开成果与进展'}><ChevronLeft size={16} className="conversation-artifacts-launcher-icon" /></button></div>;
    if (selectedTask) return <WorkflowView task={selectedTask} employees={workspace.employees} onBack={() => { setTaskCenterPage('home'); workspace.setView('workflows'); }} onCancel={workspace.cancelTask} onRetry={() => workspace.retryTask()} />;
    return <ConversationLanding userName={userName} />;
  };

  const handleView = (view: Parameters<typeof workspace.setView>[0]) => { if (view === 'tasks') setMode('conversation'); if (view === 'workflows') { setMode('workflow'); setTaskCenterPage('home'); } workspace.setView(view); };
  return <main className={`workspace-shell ${workspace.sidebarExpanded ? '' : 'sidebar-collapsed'}`}><div className="workspace-titlebar electron-drag-region" aria-hidden="true" />{!workspace.sidebarExpanded && <button className="workspace-floating-sidebar-toggle workspace-sidebar-open-toggle" type="button" onClick={() => workspace.setSidebarExpanded(true)} aria-label="展开侧栏" title="展开侧栏"><ChevronRight size={16} className="workspace-sidebar-toggle-icon" /></button>}<WorkspaceSidebar expanded={workspace.sidebarExpanded} view={workspace.view} tasks={workspace.tasks} selectedTaskId={workspace.selectedTaskId} filters={workspace.filters} userName={userName} enterpriseName={enterpriseName} onToggle={() => workspace.setSidebarExpanded(!workspace.sidebarExpanded)} onNew={newTask} onView={handleView} onSelectTask={selectTask} onFilters={workspace.setFilters} onLogout={() => void onLogout()} /><section className="workspace-main"><div className="workspace-canvas">{workspace.error && <div className="workspace-inline-error workspace-page-error">{workspace.error}</div>}<div className="workspace-content" ref={contentRef}>{renderContent()}</div>{workspace.view === 'tasks' && !selectedTask && <div className="workspace-docked-composer"><WorkspaceComposer mode={mode} draft={workspace.conversationDraft} employees={workspace.employees} skills={workspace.skills} workflows={workspace.workflows} onDraftChange={workspace.updateConversationDraft} onConversationSubmit={workspace.createConversationTask} onWorkflowSubmit={workspace.createWorkflowTask} /></div>}</div></section></main>;
}

function ConversationLanding({ userName }: { userName: string }) { return <section className="workspace-home"><span className="eyebrow"><MessageSquareText size={14} />对话工作台</span><h1>你好，{userName}</h1><p>把目标交代给合适的硅基员工，今天的工作从这里开始。</p></section>; }

function EmployeeResourcePage({ employees, onSelect }: { employees: { id: string; displayName: string; description: string; avatar: string; modelOptions: { id: string }[] }[]; onSelect: (id: string) => void }) { return <ResourcePage icon={<Bot size={22} />} title="硅基员工" subtitle={`当前账号可安排 ${employees.length} 位员工。`} items={employees.map(employee => ({ title: employee.displayName, description: employee.description, meta: `${employee.modelOptions.length} 个可用模型`, action: '开始对话', onAction: () => onSelect(employee.id) }))} />; }

function ResourcePage({ icon, title, subtitle, items }: { icon: React.ReactNode; title: string; subtitle: string; items: { title: string; description: string; meta: string; action?: string; onAction?: () => void }[] }) { return <section className="resource-page"><header><div className="resource-heading-icon">{icon}</div><div><span className="eyebrow">个人可用资源</span><h1>{title}</h1><p>{subtitle}</p></div></header><div className="resource-grid">{items.map(item => <article key={item.title}><div className="resource-card-icon"><FolderOpen size={16} /></div><div><h2>{item.title}</h2><p>{item.description}</p><small>{item.meta}</small></div>{item.action && <button className="workspace-secondary-button" onClick={item.onAction} title={item.action}>{item.action}</button>}</article>)}</div></section>; }
