import { Bot, Check, ChevronRight, FolderKanban, ListChecks, MessageSquareText, Plus, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Task, TaskFilters, WorkspaceView } from '../../features/workspace/useWorkspaceDemo';
import { AccountMenu } from './AccountMenu';

interface Props {
  expanded: boolean;
  view: WorkspaceView;
  tasks: Task[];
  selectedTaskId: string | null;
  filters: TaskFilters;
  userName: string;
  userEmail?: string;
  enterpriseName?: string;
  onToggle: () => void;
  onNew: () => void;
  onView: (view: WorkspaceView) => void;
  onSelectTask: (id: string) => void;
  onFilters: (filters: TaskFilters) => void;
  onLogout: () => void;
}

const statusLabel: Record<Task['status'], string> = { queued: '待安排', running: '正在工作', 'waiting-approval': '等待确认', completed: '已交付', failed: '需要重试', cancelled: '已取消', stopped: '已暂停' };

export function WorkspaceSidebar({ expanded, view, tasks, selectedTaskId, filters, userName, userEmail, enterpriseName, onToggle, onNew, onView, onSelectTask, onFilters, onLogout }: Props) {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [filterOpen]);
  const visibleTasks = tasks.filter(task => (!filters.query || `${task.title} ${task.employeeName}`.toLowerCase().includes(filters.query.toLowerCase())) && (filters.type === 'all' || task.type === filters.type));
  return <aside className={`workspace-sidebar ${expanded ? 'expanded' : 'collapsed'}`} aria-label="工作台导航">
    <div className="workspace-sidebar-header">
      <div className="workspace-brand"><span className="workspace-brand-mark"><Sparkles size={17} /></span><span className="workspace-sidebar-copy"><strong>硅基员工</strong><small>SEP 平台</small></span></div>
      <div className="workspace-sidebar-topbar">
        <button className="workspace-icon-button workspace-sidebar-toggle" onClick={onToggle} aria-label={expanded ? '收起侧栏' : '展开侧栏'} title={expanded ? '收起侧栏' : '展开侧栏'}><ChevronRight size={17} className={`workspace-sidebar-toggle-icon ${expanded ? 'expanded' : ''}`} /></button>
        {expanded && <div className="workspace-filter-wrap" ref={filterRef}><button className={`workspace-icon-button ${filterOpen ? 'active' : ''}`} onClick={() => setFilterOpen(value => !value)} aria-expanded={filterOpen} aria-label="筛选任务" title="筛选任务"><SlidersHorizontal size={16} /></button>{filterOpen && <div className="workspace-filter-menu" role="menu" aria-label="任务类型筛选"><div className="workspace-filter-menu-title">显示任务</div>{(['all', 'conversation', 'workflow'] as const).map(type => <button key={type} className={filters.type === type ? 'active' : ''} onClick={() => { onFilters({ ...filters, type }); setFilterOpen(false); }} role="menuitem" title={type === 'all' ? '显示全部任务' : type === 'conversation' ? '只显示对话任务' : '只显示任务中心'}><span>{type === 'all' ? '全部任务' : type === 'conversation' ? '对话任务' : '任务中心'}</span><Check size={14} /></button>)}</div>}</div>}
      </div>
    </div>
    <button className="workspace-new-button" onClick={onNew} title="新建任务"><Plus size={17} /><span className="workspace-sidebar-copy">新建任务</span></button>
    {expanded && <label className="workspace-task-search"><Search size={15} /><input value={filters.query} onChange={event => onFilters({ ...filters, query: event.target.value })} placeholder="搜索我的任务" aria-label="搜索我的任务" /></label>}
    {expanded && <div className="workspace-task-list"><div className="workspace-section-label">最近工作 <small>{visibleTasks.length}</small></div>{visibleTasks.length === 0 ? <p className="workspace-empty-note">还没有安排工作</p> : visibleTasks.slice(0, 20).map(task => <button key={task.id} className={selectedTaskId === task.id ? 'active' : ''} onClick={() => onSelectTask(task.id)} title={task.title} aria-current={selectedTaskId === task.id ? 'page' : undefined}><span className={`workspace-task-status-dot ${task.status}`} aria-label={statusLabel[task.status]} title={statusLabel[task.status]} /><span className="workspace-sidebar-copy"><strong>{task.title}</strong><small>{task.employeeName} · {statusLabel[task.status]}</small></span></button>)}</div>}
    <nav className="workspace-resource-nav" aria-label="工作台模块">
      <button className={view === 'tasks' || view === 'new-task' ? 'active' : ''} onClick={() => onView('tasks')} title="对话" aria-current={view === 'tasks' || view === 'new-task' ? 'page' : undefined}><MessageSquareText size={17} /><span className="workspace-sidebar-copy">对话</span></button>
      <button className={view === 'workflows' ? 'active' : ''} onClick={() => onView('workflows')} title="任务中心" aria-current={view === 'workflows' ? 'page' : undefined}><ListChecks size={17} /><span className="workspace-sidebar-copy">任务中心</span></button>
      <button className={view === 'employees' ? 'active' : ''} onClick={() => onView('employees')} title="硅基员工" aria-current={view === 'employees' ? 'page' : undefined}><Bot size={17} /><span className="workspace-sidebar-copy">硅基员工</span></button>
      <button className={view === 'skills' ? 'active' : ''} onClick={() => onView('skills')} title="技能与资源" aria-current={view === 'skills' ? 'page' : undefined}><FolderKanban size={17} /><span className="workspace-sidebar-copy">技能与资源</span></button>
    </nav>
    {expanded && <div className="workspace-sidebar-footer"><AccountMenu userName={userName} email={userEmail} enterpriseName={enterpriseName} onLogout={onLogout} /></div>}
  </aside>;
}
