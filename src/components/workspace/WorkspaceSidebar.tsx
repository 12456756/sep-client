import { Bot, CheckSquare, ChevronLeft, ChevronRight, Filter, FolderKanban, LogOut, Plus, Search, Sparkles, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Task, TaskFilters, TaskStatus, WorkspaceView } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  expanded: boolean;
  view: WorkspaceView;
  tasks: Task[];
  selectedTaskId: string | null;
  filters: TaskFilters;
  onToggle: () => void;
  onNew: () => void;
  onView: (view: WorkspaceView) => void;
  onSelectTask: (id: string) => void;
  onFilters: (filters: TaskFilters) => void;
  onLogout: () => void;
}

const statusLabel: Record<Task['status'], string> = { queued: '排队中', running: '运行中', 'waiting-approval': '待审批', completed: '已完成', failed: '失败', cancelled: '已取消', stopped: '已停止' };
const statusOptions: TaskStatus[] = ['queued', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'stopped'];

export function WorkspaceSidebar({ expanded, view, tasks, selectedTaskId, filters, onToggle, onNew, onView, onSelectTask, onFilters, onLogout }: Props) {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const visibleTasks = tasks.filter((task) => {
    if (filters.type !== 'all' && task.type !== filters.type) return false;
    if (filters.status.length > 0 && !filters.status.includes(task.status)) return false;
    return !filters.query || `${task.title} ${task.employeeName}`.toLowerCase().includes(filters.query.toLowerCase());
  });

  useEffect(() => {
    if (!filterOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) setFilterOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [filterOpen]);

  const toggleStatus = (status: TaskStatus) => {
    const nextStatus = filters.status.includes(status)
      ? filters.status.filter((item) => item !== status)
      : [...filters.status, status];
    onFilters({ ...filters, status: nextStatus });
  };

  return (
    <aside className={`workspace-sidebar electron-no-drag ${expanded ? 'expanded' : 'collapsed'}`} aria-label="工作台导航">
      <div className="workspace-sidebar-topbar">
        <button className="workspace-icon-button" onClick={onToggle} aria-label={expanded ? '收起侧边栏' : '展开侧边栏'} title={expanded ? '收起侧边栏' : '展开侧边栏'}>{expanded ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}</button>
        <div className="workspace-filter-wrap" ref={filterRef}>
          <button className={`workspace-icon-button ${filterOpen || filters.status.length ? 'active' : ''}`} onClick={() => { if (!expanded) onToggle(); setFilterOpen((open) => !open); }} aria-label="筛选任务" aria-expanded={filterOpen} title="按任务状态筛选"><Filter size={16} /></button>
          {filterOpen && (
            <div className="workspace-filter-menu" role="menu" aria-label="任务状态筛选">
              <div className="workspace-filter-menu-header"><strong>任务状态</strong><button type="button" onClick={() => onFilters({ ...filters, status: [] })} disabled={!filters.status.length}>清空</button></div>
              {statusOptions.map((status) => (
                <label key={status} className="workspace-filter-option">
                  <input type="checkbox" checked={filters.status.includes(status)} onChange={() => toggleStatus(status)} />
                  <span className={`workspace-task-status-dot ${status}`} />
                  <span>{statusLabel[status]}</span>
                  <small>{tasks.filter((task) => task.status === status).length}</small>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="workspace-brand"><span className="workspace-brand-mark"><img src="../assets/logo.png" alt="logo" style={{width:43,height:30}}/></span><span className="workspace-sidebar-copy"><strong>硅基人才</strong><small>个人工作台</small></span></div>
      <button className="workspace-new-button" onClick={onNew} title="新建任务"><Plus size={17} /><span className="workspace-sidebar-copy">新建任务</span></button>
      <label className="workspace-task-search workspace-sidebar-copy"><Search size={15} /><input value={filters.query} onChange={(event) => onFilters({ ...filters, query: event.target.value })} placeholder="搜索我的任务" aria-label="搜索我的任务" /></label>
      <div className="workspace-task-list">
        <div className="workspace-section-label workspace-sidebar-copy">我的任务 <small>{visibleTasks.length}</small></div>
        {visibleTasks.length === 0 ? <p className="workspace-empty-note workspace-sidebar-copy">没有匹配的任务</p> : visibleTasks.slice(0, 20).map((task) => <button key={task.id} className={selectedTaskId === task.id ? 'active' : ''} onClick={() => onSelectTask(task.id)} title={task.title}><span className={`workspace-task-status-dot ${task.status}`} /><span className="workspace-sidebar-copy"><strong>{task.title}</strong><small>{task.employeeName} · {statusLabel[task.status]}</small></span></button>)}
      </div>
      <nav className="workspace-resource-nav" aria-label="资源导航">
        <button className={view === 'employees' ? 'active' : ''} onClick={() => onView('employees')} title="硅基员工"><Bot size={17} /><span className="workspace-sidebar-copy">硅基员工</span></button>
        <button className={view === 'skills' ? 'active' : ''} onClick={() => onView('skills')} title="技能"><Wrench size={17} /><span className="workspace-sidebar-copy">技能</span></button>
        <button className={view === 'workflows' ? 'active' : ''} onClick={() => onView('workflows')} title="工作流"><FolderKanban size={17} /><span className="workspace-sidebar-copy">工作流</span></button>
        <button className={view === 'status' ? 'active' : ''} onClick={() => onView('status')} title="任务状态"><CheckSquare size={17} /><span className="workspace-sidebar-copy">任务状态</span></button>
      </nav>
      <div className="workspace-sidebar-footer"><button onClick={onLogout} title="退出登录"><LogOut size={17} /><span className="workspace-sidebar-copy">退出登录</span></button></div>
    </aside>
  );
}
