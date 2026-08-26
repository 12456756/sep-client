import { AlertCircle, ArrowLeft, ArrowRight, Ban, Check, CheckCircle2, Circle, Clock3, FileCode2, FileText, FolderOpen, LoaderCircle, PauseCircle, RotateCcw, Sparkles } from 'lucide-react';
import type { AvailableEmployee, Task, TaskPlanStepDraft, TaskStatus } from '../../features/workspace/useWorkspaceDemo';

const statusMeta: Record<TaskStatus, { label: string; className: string }> = {
  queued: { label: '等待开始', className: 'queued' },
  running: { label: '正在工作', className: 'running' },
  'waiting-approval': { label: '等待你的确认', className: 'approval' },
  completed: { label: '已完成', className: 'completed' },
  failed: { label: '需要处理', className: 'failed' },
  cancelled: { label: '已取消', className: 'cancelled' },
  stopped: { label: '已暂停', className: 'stopped' },
};

type StepState = 'queued' | 'running' | 'approval' | 'completed' | 'failed' | 'cancelled' | 'stopped';

interface Props {
  task: Task;
  employees: AvailableEmployee[];
  onBack: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

function stepState(task: Task, index: number, count: number): StepState {
  if (task.status === 'completed') return 'completed';
  const completedCount = Math.min(count - 1, Math.floor((task.progress / 100) * count));
  if (index < completedCount) return 'completed';
  if (index > completedCount) return 'queued';
  if (task.status === 'waiting-approval') return 'approval';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'stopped') return 'stopped';
  return task.status === 'running' ? 'running' : 'queued';
}

function fallbackSteps(task: Task): TaskPlanStepDraft[] {
  return [{ id: `${task.id}-step`, employeeInstanceId: task.employeeId, title: task.title, instruction: task.goal || task.title, expectedOutput: '完成任务目标并提供最终交付物' }];
}

const stateLabel: Record<StepState, string> = { queued: '等待中', running: '正在工作', approval: '等待确认', completed: '已完成', failed: '需要处理', cancelled: '已取消', stopped: '已暂停' };

export function WorkflowView({ task, employees, onBack, onCancel, onRetry }: Props) {
  const meta = statusMeta[task.status];
  const running = task.status === 'queued' || task.status === 'running';
  const steps = task.planSteps?.length ? task.planSteps : fallbackSteps(task);
  const completedSteps = task.status === 'completed' ? steps.length : Math.min(steps.length - 1, Math.floor((task.progress / 100) * steps.length));
  const employeeById = new Map(employees.map(employee => [employee.id, employee]));

  return <section className="task-run-page">
    <header className="task-run-header"><div className="task-run-heading"><button type="button" onClick={onBack} aria-label="返回任务中心" title="返回任务中心"><ArrowLeft size={17} /></button><div><span>任务中心</span><h1>{task.title}</h1><p>已完成 {completedSteps}/{steps.length} · {meta.label} · {task.progress}%</p></div></div><span className={`workflow-status ${meta.className}`}>{meta.label}</span></header>

    <div className="task-run-layout">
      <aside className="task-run-plan-summary"><div className="task-run-panel-heading"><span>工作计划</span><small>{steps.length} 个步骤</small></div><dl><div><dt>目标</dt><dd>{task.goal}</dd></div><div><dt>工作目录</dt><dd className="path-copy"><FolderOpen size={13} />{task.workspace.displayName || task.workspace.path || '未指定'}</dd></div></dl><ol>{steps.map((step, index) => { const state = stepState(task, index, steps.length); return <li key={step.id} className={state}><span>{state === 'completed' ? <Check size={12} /> : index + 1}</span><div><strong>{step.title}</strong><small>{stateLabel[state]}</small></div></li>; })}</ol></aside>

      <main className="task-run-timeline"><div className="task-run-panel-heading"><span>执行时间线</span><small>员工按计划顺序交接</small></div><div className="task-run-step-list">{steps.map((step, index) => { const state = stepState(task, index, steps.length); const employee = employeeById.get(step.employeeInstanceId); const isCurrent = state === 'running' || state === 'approval' || state === 'failed' || state === 'stopped'; return <div className={`task-run-step ${state}`} key={step.id}><div className="task-run-step-rail"><span>{state === 'completed' ? <Check size={14} /> : state === 'running' ? <LoaderCircle size={14} className="spin" /> : state === 'failed' ? <AlertCircle size={14} /> : <Circle size={12} />}</span>{index < steps.length - 1 && <i />}</div><article><header><div><span className="workspace-avatar workspace-avatar-text">{employee?.avatar || task.employeeName.slice(0, 1)}</span><div><strong>{index + 1}. {step.title}</strong><small>{employee?.displayName || task.employeeName} · {stateLabel[state]}</small></div></div>{isCurrent && <span className={`task-run-step-state ${state}`}>{stateLabel[state]}</span>}</header><p>{step.instruction}</p><div className="task-run-step-output"><span>预期输出</span><strong>{step.expectedOutput || '完成本步骤要求'}</strong></div>{state === 'completed' && <div className="task-run-step-result"><CheckCircle2 size={15} /><span>{index === steps.length - 1 ? '最终结果已经整理完成' : `成果已交接给${employeeById.get(steps[index + 1]?.employeeInstanceId)?.displayName || '下一位员工'}`}</span></div>}{state === 'running' && <div className="task-run-step-activity"><span>{task.activity || '正在执行当前步骤'}</span><i /></div>}{state === 'failed' && <div className="task-run-step-error"><AlertCircle size={15} /><div><strong>当前步骤没有完成</strong><span>查看工作记录后可以只重试这一步。</span></div><button className="workspace-secondary-button" type="button" onClick={onRetry}><RotateCcw size={14} />重试此步骤</button></div>}{state === 'approval' && <div className="task-run-step-approval"><PauseCircle size={15} /><div><strong>员工正在等待你的确认</strong><span>审批操作会显示在对应步骤中。</span></div></div>}</article>{index < steps.length - 1 && state === 'completed' && <div className="task-run-handoff"><ArrowRight size={13} /><span>员工交接</span></div>}</div>; })}</div></main>

      <aside className="task-run-delivery"><div className="task-run-panel-heading"><span>交付结果</span><small>{task.artifacts.length} 项</small></div><section><h2>当前产物</h2>{task.artifacts.length === 0 ? <p className="workspace-empty-note">员工完成工作后，文件和报告会出现在这里。</p> : task.artifacts.map(artifact => <article key={artifact.id}>{artifact.kind === 'code' ? <FileCode2 size={17} /> : <FileText size={17} />}<div><strong>{artifact.name}</strong><small>{artifact.summary}</small></div></article>)}</section><section><h2>预期交付</h2>{steps.slice(-2).map(step => <div className="task-run-expected" key={step.id}><Sparkles size={14} /><span>{step.expectedOutput || step.title}</span></div>)}</section><section><h2>工作记录</h2><div className="task-run-log"><Clock3 size={14} /><span>{task.logs.length ? `${task.logs.length} 条记录` : '暂无运行记录'}</span></div></section><footer>{running && <button className="workspace-secondary-button" type="button" onClick={onCancel}><Ban size={15} />停止任务</button>}{(task.status === 'failed' || task.status === 'cancelled') && <button className="workspace-secondary-button" type="button" onClick={onRetry}><RotateCcw size={15} />重试当前步骤</button>}{task.status === 'completed' && <span><CheckCircle2 size={16} />工作已完成</span>}</footer></aside>
    </div>
  </section>;
}
