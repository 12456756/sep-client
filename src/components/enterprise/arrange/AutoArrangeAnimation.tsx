import { Check, Sparkles } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ArrangementDraft, ArrangementPlanningProgress } from '../../../shared/types';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import { usePrefersReducedMotion } from '../../../features/enterprise/use-reduced-motion';
import { EmployeeFace } from '../EmployeeFace';

type Phase = 'analyzing' | 'planning' | 'matching' | 'flowing' | 'done';
const STRIP = ['分析目标', '制定计划', '匹配员工', '生成流程'];
const THINKING = ['分析任务内容', '识别需要完成的工作', '匹配员工能力'];
const TITLES: Record<Phase, string> = {
  analyzing: '正在分析你的工作目标',
  planning: '正在制定执行计划',
  matching: '正在匹配最适合完成任务的员工……',
  flowing: '正在安排工作流程',
  done: '自动编排完成',
};

interface Props {
  restored?: boolean;
  draft: ArrangementDraft;
  employees: SiliconEmployee[];
  planning: boolean;
  planningEvents: ArrangementPlanningProgress[];
  children: ReactNode;
}

interface EmployeesProps {
  nodes: ArrangementDraft['nodes'];
  employees: SiliconEmployee[];
  ready: boolean;
  exiting?: boolean;
  reducedMotion?: boolean;
}

export function getTeamAnimationTiming(employeeCount: number, reducedMotion = false): {
  frameMs: number; entryMs: number; staggerMs: number; exitMs: number; leaveAtMs: number; flowAtMs: number;
} {
  const frameMs = reducedMotion ? 0 : 300;
  const entryMs = reducedMotion ? 0 : 500;
  const staggerMs = reducedMotion ? 0 : 600;
  const exitMs = reducedMotion ? 0 : 220;
  const leaveAtMs = frameMs + Math.max(0, employeeCount - 1) * staggerMs + entryMs + 1500;
  return { frameMs, entryMs, staggerMs, exitMs, leaveAtMs, flowAtMs: leaveAtMs + exitMs };
}

export function AutoArrangeEmployees({ nodes, employees, ready, exiting = false, reducedMotion = false }: EmployeesProps): JSX.Element | null {
  if (!ready || !nodes.length) return null;
  const employeeById = new Map(employees.map(employee => [employee.id, employee]));
  const selectedIds = [...new Set(nodes.map(node => node.subscriptionId))];
  const timing = getTeamAnimationTiming(selectedIds.length, reducedMotion);
  return (
    <div className={`ent-aa-team${exiting ? ' exiting' : ''}`} role="group" aria-label="已选中的员工" style={{
      '--aa-frame-duration': `${timing.frameMs}ms`,
      '--aa-exit-duration': `${timing.exitMs}ms`,
    } as CSSProperties}>
      <ul className="ent-aa-team-list">
        {selectedIds.map((id, index) => {
          const employee = employeeById.get(id);
          return (
            <li key={id} className="ent-aa-team-member" style={{
              '--aa-entry-delay': `${timing.frameMs + index * timing.staggerMs}ms`,
              '--aa-entry-duration': `${timing.entryMs}ms`,
            } as CSSProperties}>
              <EmployeeFace employee={employee} name={id} size="md" round />
              <span><strong>{employee?.name ?? id}</strong>{employee?.roleName ? <small>{employee.roleName}</small> : null}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Timers control presentation only; selected employees and workflow come from the final draft. */
export function AutoArrangeAnimation({ draft, employees, planning, planningEvents, children, restored = false }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>(() => restored
    ? !planning ? 'done' : planningEvents.some(event => event.type === 'arrangement_employee_considering') ? 'matching'
      : planningEvents.some(event => event.type === 'arrangement_plan_ready') ? 'planning' : 'analyzing'
    : 'analyzing');
  const [thought, setThought] = useState(0);
  const [rows, setRows] = useState(() => restored ? 1 + draft.nodes.length * 2 : 0);
  const [teamExiting, setTeamExiting] = useState(false);
  const [teamStageHeight, setTeamStageHeight] = useState(0);
  const teamStageRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const reduced = usePrefersReducedMotion();
  const beat = reduced ? 0.3 : 1;
  const ready = !planning && draft.nodes.length > 0;
  const nodeCount = draft.nodes.length;
  const selectedCount = new Set(draft.nodes.map(node => node.subscriptionId)).size;
  const { leaveAtMs, flowAtMs } = getTeamAnimationTiming(selectedCount, reduced);
  const planEvent = [...planningEvents].reverse().find(event => event.type === 'arrangement_plan_ready');
  const hasConsideringEvent = planningEvents.some(event => event.type === 'arrangement_employee_considering');
  const terminalEvent = planningEvents.find(event => event.type === 'arrangement_planning_failed' || event.type === 'arrangement_planning_cancelled')
    ?? (draft.status === 'planning-failed' ? { type: 'arrangement_planning_failed' }
      : draft.lastPlanning?.status === 'cancelled' ? { type: 'arrangement_planning_cancelled' } : null);
  const stopped = draft.status === 'awaiting-employee' || Boolean(terminalEvent);

  useEffect(() => {
    if (phase !== 'analyzing') return;
    const timers = [
      window.setTimeout(() => setThought(1), 60 * beat),
      window.setTimeout(() => setThought(2), 440 * beat),
      window.setTimeout(() => setThought(3), 820 * beat),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [phase, beat]);

  useEffect(() => {
    if (restored) {
      setPhase(!planning ? 'done' : hasConsideringEvent ? 'matching' : planEvent ? 'planning' : 'analyzing');
      setRows(1 + nodeCount * 2);
      return;
    }
    if (phase === 'analyzing' && planEvent) setPhase('planning');
    if (phase === 'planning' && (hasConsideringEvent || ready)) setPhase('matching');
  }, [phase, planEvent, hasConsideringEvent, ready, restored, planning, nodeCount]);

  useEffect(() => {
    if (restored || phase !== 'matching' || !ready || stopped) return;
    setTeamExiting(false);
    const timers = [
      window.setTimeout(() => setTeamExiting(true), leaveAtMs),
      window.setTimeout(() => setPhase('flowing'), flowAtMs),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [phase, ready, stopped, leaveAtMs, flowAtMs, restored]);

  useEffect(() => {
    const stage = teamStageRef.current;
    if (phase !== 'matching' || !stage) return;
    // Anchor the complete group, including wrapped names, without moving individual slots.
    const measure = () => setTeamStageHeight(stage.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [phase, ready, selectedCount]);

  useEffect(() => {
    if (restored || phase !== 'flowing') return;
    const total = 1 + nodeCount * 2;
    const timers = [window.setTimeout(() => setRows(1), 40 * beat)];
    for (let index = 2; index <= total; index += 1) {
      timers.push(window.setTimeout(() => setRows(index), (index - 1) * 380 * beat));
    }
    timers.push(window.setTimeout(() => setPhase('done'), ((total - 1) * 380 + 360) * beat));
    return () => timers.forEach(window.clearTimeout);
  }, [phase, nodeCount, beat, restored]);

  useEffect(() => {
    if (phase !== 'flowing') return;
    const scroller = flowRef.current?.closest<HTMLElement>('.ent-arr-view');
    if (!scroller) return;
    userScrolledRef.current = false;
    const stopFollowing = () => { userScrolledRef.current = true; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) stopFollowing();
    };
    scroller.addEventListener('wheel', stopFollowing, { passive: true });
    scroller.addEventListener('touchstart', stopFollowing, { passive: true });
    scroller.addEventListener('pointerdown', stopFollowing, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      scroller.removeEventListener('wheel', stopFollowing);
      scroller.removeEventListener('touchstart', stopFollowing);
      scroller.removeEventListener('pointerdown', stopFollowing);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [phase]);

  useEffect(() => {
    if (stopped || (phase !== 'flowing' && phase !== 'done') || userScrolledRef.current) return;
    const flow = flowRef.current;
    const scroller = flow?.closest<HTMLElement>('.ent-arr-view');
    if (!flow || !scroller) return;
    // Scroll the workbench, never the document or a separate node-list viewport.
    const frame = window.requestAnimationFrame(() => {
      if (userScrolledRef.current) return;
      if (phase === 'done') {
        scroller.scrollTo({ top: 0, behavior: 'instant' });
        return;
      }
      const revealed = flow.children.item(rows - 1);
      if (!revealed) return;
      const overflow = revealed.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 16;
      if (overflow > 0) scroller.scrollTo({ top: scroller.scrollTop + overflow, behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase, rows, stopped]);

  const at = phase === 'analyzing' ? 0 : phase === 'planning' ? 1 : phase === 'matching' ? 2 : 3;
  if (draft.status === 'awaiting-employee') {
    return (
      <section className="ent-arr-auto ent-aa-content" aria-busy={planning}>
        <header className="ent-aa-head" aria-live="polite">
          <h1>还缺少员工，当前编排已暂停</h1>
          <p>员工申请是异步处理的，不会阻塞客户端其他功能。</p>
        </header>
        {children}
      </section>
    );
  }
  if (terminalEvent) {
    const cancelled = terminalEvent.type === 'arrangement_planning_cancelled';
    return (
      <section className="ent-arr-auto ent-aa-content" aria-busy={false}>
        <header className="ent-aa-head" aria-live="polite">
          <h1>{cancelled ? '自动编排已取消' : '自动编排未能完成'}</h1>
        </header>
        {children}
      </section>
    );
  }
  const heading = (
    <>
      <ol className="ent-aa-strip">
        {STRIP.map((label, index) => (
          <li key={label} className={phase === 'done' || index < at ? 'done' : index === at ? 'now' : 'wait'} aria-current={phase !== 'done' && index === at ? 'step' : undefined}>
            <span className="ent-aa-strip-label"><span className="ent-aa-strip-tick" aria-hidden>{phase === 'done' || index < at ? <Check size={10} /> : null}</span>{label}</span>
          </li>
        ))}
      </ol>
      <header className="ent-aa-head" aria-live="polite">
        <h1>{phase === 'done' ? <span className="ent-aa-ok" aria-hidden><Check size={12} /></span> : null}{phase === 'matching' && ready ? '正在组建工作团队' : TITLES[phase]}</h1>
        {phase === 'done' ? <p>已为你的任务安排 {selectedCount} 名员工，并拆分为 {nodeCount} 个工作阶段。</p> : null}
      </header>
    </>
  );
  return (
    <section className={`ent-arr-auto${phase === 'analyzing' ? ' ent-aa-analyzing' : phase === 'matching' ? ' ent-aa-matching' : phase === 'flowing' || phase === 'done' ? ' ent-aa-result' : ''}`} aria-busy={phase !== 'done'} style={phase === 'matching' ? {
      '--aa-stage-height': `${teamStageHeight}px`,
    } as CSSProperties : undefined}>
      {phase === 'matching' ? (
        <div className="ent-aa-team-stage" ref={teamStageRef}>
          {heading}
          <AutoArrangeEmployees nodes={draft.nodes} employees={employees} ready={ready} exiting={teamExiting} reducedMotion={reduced} />
        </div>
      ) : heading}
      {phase === 'analyzing' ? (
        <ul className="ent-aa-think">{THINKING.map((line, index) => (
          <li key={line} className={index < thought ? 'in' : undefined}><Sparkles size={13} aria-hidden />{line}</li>
        ))}</ul>
      ) : null}
      {phase === 'planning' ? (
        <article className="ent-aa-plan" aria-live="polite">
          <strong>已制定执行计划</strong>
          {planEvent?.data.planSummary ? <p>{planEvent.data.planSummary}</p> : null}
          {planEvent?.data.planSteps?.length ? (
            <ol>{planEvent.data.planSteps.map((step, index) => <li key={step.id}><span>{String(index + 1).padStart(2, '0')}</span>{step.title}</li>)}</ol>
          ) : null}
        </article>
      ) : null}
      {phase === 'flowing' || phase === 'done' ? (
        <div className="ent-aa-flow" ref={flowRef}>
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
                    <span className="ent-flowcard-who"><EmployeeFace employee={employee} size="sm" round /><strong>{employee?.name ?? node.subscriptionId}</strong><small>{employee?.roleName}</small></span>
                    <strong className="ent-flowcard-stage">{node.title}</strong><p>{node.instruction}</p>
                    {node.expectedOutput ? <p className="ent-flowcard-output"><span>预期输出</span>{node.expectedOutput}</p> : null}
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
