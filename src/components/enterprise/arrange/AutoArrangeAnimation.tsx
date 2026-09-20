import { Check, Sparkles } from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { ArrangementDraft } from '../../../shared/types';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import { usePrefersReducedMotion } from '../../../features/enterprise/use-reduced-motion';
import { EmployeeFace } from '../EmployeeFace';

type Phase = 'analyzing' | 'matching' | 'gathering' | 'flowing' | 'done';
const STRIP = ['分析目标', '匹配员工', '生成流程'];
const THINKING = ['分析任务内容', '识别需要完成的工作', '匹配员工能力'];
const TITLES: Record<Phase, string> = {
  analyzing: '正在分析你的工作目标',
  matching: '正在匹配最适合完成任务的员工……',
  gathering: '正在匹配最适合完成任务的员工……',
  flowing: '正在安排工作流程',
  done: '自动编排完成',
};

interface Props {
  draft: ArrangementDraft;
  employees: SiliconEmployee[];
  planning: boolean;
  children: ReactNode;
}

/** 恢复原版四拍动效。计时器只控制展示，入选结果与流程始终来自后端草稿。 */
export function AutoArrangeAnimation({ draft, employees, planning, children }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('analyzing');
  const [thought, setThought] = useState(0);
  const [scan, setScan] = useState(-1);
  const [resolved, setResolved] = useState(0);
  const [gathered, setGathered] = useState(false);
  const [rows, setRows] = useState(0);
  // Freeze the visual pool for this attempt; directory refreshes must not reorder an active scan.
  const [pool] = useState(() => employees.map(employee => ({ ...employee })));
  const reduced = usePrefersReducedMotion();
  const beat = reduced ? 0.3 : 1;
  const ready = !planning && draft.nodes.length > 0;
  const nodeCount = draft.nodes.length;

  useEffect(() => {
    if (phase !== 'analyzing') return;
    const timers = [
      window.setTimeout(() => setThought(1), 60 * beat),
      window.setTimeout(() => setThought(2), 440 * beat),
      window.setTimeout(() => setThought(3), 820 * beat),
      window.setTimeout(() => setPhase('matching'), 1520 * beat),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [phase, beat]);

  useEffect(() => {
    if (phase !== 'matching') return;
    // While the model is working, scan without inventing selections or match percentages.
    if (!ready) {
      setScan(pool.length ? 0 : -1);
      const timer = window.setInterval(() => setScan(current => pool.length ? (current + 1) % pool.length : -1), 560 * beat);
      return () => window.clearInterval(timer);
    }
    const timers: number[] = [];
    pool.forEach((_, index) => {
      timers.push(window.setTimeout(() => setScan(index), index * 560 * beat));
      timers.push(window.setTimeout(() => setResolved(index + 1), (index * 560 + 400) * beat));
    });
    timers.push(window.setTimeout(() => { setScan(-1); setPhase('gathering'); }, (pool.length * 560 + 220) * beat));
    return () => timers.forEach(window.clearTimeout);
  }, [phase, ready, pool, beat]);

  useEffect(() => {
    if (phase !== 'gathering') return;
    setGathered(true);
    const timer = window.setTimeout(() => setPhase('flowing'), 720 * beat);
    return () => window.clearTimeout(timer);
  }, [phase, beat]);

  useEffect(() => {
    if (phase !== 'flowing') return;
    const total = 1 + nodeCount * 2;
    const timers = [window.setTimeout(() => setRows(1), 40 * beat)];
    for (let index = 2; index <= total; index += 1) {
      timers.push(window.setTimeout(() => setRows(index), (index - 1) * 380 * beat));
    }
    timers.push(window.setTimeout(() => setPhase('done'), ((total - 1) * 380 + 360) * beat));
    return () => timers.forEach(window.clearTimeout);
  }, [phase, nodeCount, beat]);

  const at = phase === 'analyzing' ? 0 : phase === 'matching' || phase === 'gathering' ? 1 : phase === 'flowing' ? 2 : 3;
  const selectedCount = new Set(draft.nodes.map(node => node.subscriptionId)).size;
  return (
    <section className="ent-arr-auto" aria-busy={phase !== 'done'}>
      <ol className="ent-aa-strip">
        {STRIP.map((label, index) => (
          <li key={label} className={index < at ? 'done' : index === at ? 'now' : 'wait'}>
            <span className="ent-aa-strip-tick" aria-hidden>{index < at ? <Check size={10} /> : null}</span>{label}
          </li>
        ))}
      </ol>
      <header className="ent-aa-head" aria-live="polite">
        <h1>{phase === 'done' ? <span className="ent-aa-ok" aria-hidden><Check size={12} /></span> : null}{TITLES[phase]}</h1>
        {phase === 'done' ? <p>已为你的任务安排 {selectedCount} 名员工，并拆分为 {nodeCount} 个工作阶段。</p> : null}
      </header>
      {phase === 'analyzing' ? (
        <ul className="ent-aa-think">{THINKING.map((line, index) => (
          <li key={line} className={index < thought ? 'in' : undefined}><Sparkles size={13} aria-hidden />{line}</li>
        ))}</ul>
      ) : null}
      {phase === 'matching' || phase === 'gathering' ? (
        <div className={`ent-aa-pool${gathered ? ' gathered' : ''}`}>
          {pool.map((employee, index) => {
            const node = draft.nodes.find(item => item.subscriptionId === employee.id);
            const tone = ready && index < resolved ? (node ? 'picked' : 'passed') : index === scan ? 'scanning' : 'idle';
            return (
              <article key={employee.id} className={`ent-aa-card ${tone}${gathered && !node ? ' gone' : ''}`}>
                <EmployeeFace seed={employee.id} size="md" round />
                <strong>{employee.name}</strong><small>{employee.roleName}</small>
                <span className="ent-aa-card-state">
                  {tone === 'scanning' ? <em>匹配中…</em> : null}
                  {tone === 'picked' ? <><b><Check size={11} aria-hidden />已匹配</b><i title={node?.title}>{node?.title}</i></> : null}
                </span>
              </article>
            );
          })}
        </div>
      ) : null}
      {phase === 'flowing' || phase === 'done' ? (
        <div className="ent-aa-flow">
          <article className={`ent-aa-goalnode${rows >= 1 ? ' in' : ''}`}><span>工作目标</span><p>{draft.goal}</p></article>
          {draft.nodes.map((node, index) => {
            const employee = employees.find(item => item.id === node.subscriptionId);
            return (
              <Fragment key={node.id}>
                <svg className={`ent-aa-link${rows >= 2 + index * 2 ? ' in' : ''}`} width="14" height="34" viewBox="0 0 14 34" aria-hidden focusable="false">
                  <path className="ent-aa-link-line" d="M7 1V25" /><path className="ent-aa-link-tip" d="M3.6 24.4 7 28.6l3.4-4.2" />
                </svg>
                <article className={`ent-flowcard${rows >= 3 + index * 2 ? ' in' : ''}`}>
                  <span className="ent-flowcard-no" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
                  <div className="ent-flowcard-body">
                    <span className="ent-flowcard-who"><EmployeeFace seed={node.subscriptionId} size="sm" round /><strong>{employee?.name ?? node.subscriptionId}</strong><small>{employee?.roleName}</small></span>
                    <strong className="ent-flowcard-stage">{node.title}</strong><p>{node.instruction}</p>
                  </div>
                </article>
              </Fragment>
            );
          })}
        </div>
      ) : null}
      {phase === 'done' ? children : null}
    </section>
  );
}
