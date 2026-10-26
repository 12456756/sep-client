import { CheckCircle2, LoaderCircle, RotateCcw, XCircle } from 'lucide-react';
import type { WorkItem, WorkStepState } from '../../../features/enterprise/types';

interface Props {
  work: Pick<WorkItem, 'id' | 'steps' | 'arrangementExecution'>;
  busy: boolean;
  onRetry: (workId: string, nodeId: string) => Promise<void>;
  showRetry?: boolean;
}

const labels: Record<WorkStepState, string> = {
  done: '已完成', running: '进行中', 'waiting-user': '等待确认', failed: '失败',
  blocked: '等待前置节点', interrupted: '已中断', stopped: '已停止', skipped: '已跳过', pending: '未开始',
};

export function ArrangementSteps({ work, busy, onRetry, showRetry = true }: Props) {
  const execution = work.arrangementExecution;
  const retryable = execution && ['running', 'waiting-user', 'failed'].includes(execution.status);
  return (
    <ol className="ent-arrangement-step-list" aria-label="节点完成情况">
      {work.steps.map(step => (
        <li key={step.id} className={'ent-arrangement-step ' + step.state}>
          <span className="ent-arrangement-step-icon" aria-hidden>
            {step.state === 'done' ? <CheckCircle2 size={15} /> : step.state === 'failed' ? <XCircle size={15} /> : step.state === 'running' ? <LoaderCircle size={15} className="ent-spin" /> : <span />}
          </span>
          <span className="ent-arrangement-step-copy"><strong>{step.title}</strong><small>{step.employeeName} · {labels[step.state]}</small></span>
          {showRetry && retryable && execution.nodes.some(node => node.nodeId === step.id && node.status === 'failed') ? (
            <button type="button" className="ent-btn sm ghost ent-arrangement-step-retry" aria-label={'重试此节点：' + step.title} onClick={() => void onRetry(work.id, step.id)} disabled={busy}>
              <RotateCcw size={13} aria-hidden />
              重试此节点
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
