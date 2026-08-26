import { CheckCircle2, Clock3, FileText, FolderOpen, Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Task } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
}

export function ConversationArtifactsPanel({ task, expanded, onToggle }: Props) {
  const running = task.status === 'queued' || task.status === 'running';
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.conversation-artifacts-launcher')) return;
      if (!panelRef.current?.contains(event.target as Node)) onToggle();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded, onToggle]);

  return <aside className={`conversation-artifacts ${expanded ? '' : 'collapsed'}`} aria-label="成果与进展" ref={panelRef}>
    <div className="artifacts-heading"><div><span className="eyebrow"><Sparkles size={13} />工作交付</span><h2>成果与进展</h2></div><span className={`artifact-status ${running ? 'running' : task.status === 'failed' ? 'failed' : 'done'}`}>{running ? '正在工作' : task.status === 'failed' ? '需要重试' : '已交付'}</span></div>
    <section className="artifact-section"><h3><FileText size={15} />交付结果</h3>{task.artifacts.length === 0 ? <p className="artifact-empty">员工完成工作后，文件和报告会出现在这里。</p> : task.artifacts.map(artifact => <div className="artifact-row" key={artifact.id}><FileText size={16} /><span><strong>{artifact.name}</strong><small>{artifact.summary}</small></span></div>)}</section>
    <section className="artifact-section"><h3><FolderOpen size={15} />工作目录</h3><p className="artifact-path">{task.workspace.path || '尚未选择工作目录'}</p></section>
    <section className="artifact-section"><h3><Clock3 size={15} />工作记录</h3>{task.logs.length === 0 ? <p className="artifact-empty">还没有运行记录。</p> : task.logs.slice(-5).map((log, index) => <div className="artifact-log" key={`${log}-${index}`}><span className="artifact-log-dot" />{log}</div>)}</section>
    {!running && task.status === 'completed' && <div className="artifact-delivered"><CheckCircle2 size={16} />员工已完成本次交付</div>}
  </aside>;
}
