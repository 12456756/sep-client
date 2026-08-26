import { ArrowRight, CheckCircle2, CircleAlert, Clock3, ListChecks, Plus, RotateCcw, Sparkles } from 'lucide-react';
import type { AvailableWorkflow, Task } from '../../features/workspace/useWorkspaceDemo';

interface Props {
  tasks: Task[];
  workflows: AvailableWorkflow[];
  onCreate: (workflowId?: string) => void;
  onSelectTask: (id: string) => void;
  onRetry: (id: string) => void;
}

const needsAttention = (task: Task) => task.status === 'waiting-approval' || task.status === 'failed';
const isActive = (task: Task) => task.status === 'queued' || task.status === 'running' || task.status === 'stopped';

export function TaskCenterHomePage({ tasks, workflows, onCreate, onSelectTask, onRetry }: Props) {
  const workflowTasks = tasks.filter(task => task.type === 'workflow');
  const attention = workflowTasks.filter(needsAttention);
  const active = workflowTasks.filter(isActive);
  const delivered = workflowTasks.filter(task => task.status === 'completed').slice(0, 6);

  return <section className="task-center-home">
    <header className="task-center-home-header">
      <div><span className="eyebrow"><ListChecks size={14} />任务中心</span><h1>安排与跟进工作</h1><p>管理正在执行的工作，查看员工交接和最终交付。</p></div>
      <button className="workspace-primary-button task-center-primary" type="button" onClick={() => onCreate()}><Plus size={16} />安排新工作</button>
    </header>

    <section className="task-center-section" aria-labelledby="task-attention-title">
      <div className="task-center-section-heading"><div><h2 id="task-attention-title">需要你处理</h2><span>{attention.length} 项</span></div><small>审批、失败和需要补充的信息会优先出现</small></div>
      {attention.length === 0 ? <div className="task-center-empty-row"><CheckCircle2 size={16} /><span>目前没有需要处理的工作</span></div> : <div className="task-center-attention-list">{attention.map(task => <article key={task.id} className={`task-center-attention-item ${task.status}`}><span className="task-center-state-icon"><CircleAlert size={16} /></span><div><strong>{task.title}</strong><small>{task.status === 'waiting-approval' ? '等待你的确认' : '当前步骤需要处理'} · {task.employeeName}</small></div>{task.status === 'failed' && <button className="workspace-secondary-button" type="button" onClick={() => onRetry(task.id)}><RotateCcw size={14} />重试</button>}<button className="workspace-secondary-button" type="button" onClick={() => onSelectTask(task.id)}>查看<ArrowRight size={14} /></button></article>)}</div>}
    </section>

    <section className="task-center-section" aria-labelledby="task-active-title">
      <div className="task-center-section-heading"><div><h2 id="task-active-title">正在进行</h2><span>{active.length} 项</span></div><small>按最近更新时间排序</small></div>
      {active.length === 0 ? <div className="task-center-empty-row"><Clock3 size={16} /><span>还没有正在执行的工作</span><button type="button" onClick={() => onCreate()}>安排第一项工作</button></div> : <div className="task-center-active-list">{active.map(task => <article key={task.id} className="task-center-active-item"><button type="button" onClick={() => onSelectTask(task.id)} aria-label={`查看${task.title}`}><div className="task-center-active-title"><span className={`workspace-task-status-dot ${task.status}`} /><strong>{task.title}</strong><span>{task.progress}%</span></div><div className="task-center-progress" aria-label={`完成${task.progress}%`}><i style={{ width: `${task.progress}%` }} /></div><div className="task-center-active-meta"><span>{task.employeeName} 正在处理</span><span>{task.planSteps?.length ?? 1} 个步骤</span><ArrowRight size={14} /></div></button></article>)}</div>}
    </section>

    <section className="task-center-section" aria-labelledby="task-delivered-title">
      <div className="task-center-section-heading"><div><h2 id="task-delivered-title">最近交付</h2><span>{delivered.length} 项</span></div><small>打开任务可查看文件和工作记录</small></div>
      {delivered.length === 0 ? <div className="task-center-empty-row"><Sparkles size={16} /><span>完成的工作会保留在这里</span></div> : <div className="task-center-delivered-list">{delivered.map(task => <button type="button" key={task.id} onClick={() => onSelectTask(task.id)}><span className="task-center-delivered-icon"><CheckCircle2 size={16} /></span><strong>{task.title}</strong><small>{new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small><span>{task.artifacts.length} 个交付物</span></button>)}</div>}
    </section>

    <section className="task-center-section task-center-templates" aria-labelledby="task-template-title">
      <div className="task-center-section-heading"><div><h2 id="task-template-title">常用工作方案</h2></div><small>从目标开始仍是默认流程</small></div>
      <div className="task-center-template-list">{workflows.map(workflow => <button type="button" key={workflow.id} onClick={() => onCreate(workflow.id)}><ListChecks size={15} /><span><strong>{workflow.name}</strong><small>{workflow.description}</small></span><ArrowRight size={14} /></button>)}<button type="button" className="task-center-template-blank" onClick={() => onCreate()}><Plus size={15} /><span><strong>从目标开始</strong><small>描述工作，生成可编辑计划</small></span><ArrowRight size={14} /></button></div>
    </section>
  </section>;
}
