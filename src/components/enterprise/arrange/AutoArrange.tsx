/**
 * 自动编排。这一页的重点不是表单，是让用户亲眼看见「AI 正在替我组建一支员工团队」。
 *
 * 一共两屏：先写工作目标，然后是编排过程。过程分四拍，顺序固定，不能跳：
 *   1. 分析工作目标   三行判断依次淡入，没有转圈的 Loading
 *   2. 匹配员工       员工池逐个被扫描，选中的亮紫并给出理由，落选的淡下去
 *   3. 汇聚           落选的收掉，选中的向中间靠拢
 *   4. 生成工作流程   目标、连线、员工卡一个一个出现
 * 走完之后停在「确认并开始工作」上 —— 用户点确认之前不会有任何人开始干活。
 *
 * 时间线用一串 setTimeout 排，每一拍一个 useEffect，切阶段或离开页面时全部取消。
 * 关掉动效时顺序不变、整条时间线压到三分之一（见 use-reduced-motion）。
 */

import { ArrowRight, Check, Settings2, Sparkles } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { planAutoArrange, type AutoPlan, type AutoStage } from '../../../features/enterprise/auto-arrange';
import type { EmployeeSkill, SiliconEmployee } from '../../../features/enterprise/types';
import { usePrefersReducedMotion } from '../../../features/enterprise/use-reduced-motion';
import { EmployeeFace } from '../EmployeeFace';
import { GoalComposer } from './GoalComposer';

type Phase = 'input' | 'analyzing' | 'matching' | 'gathering' | 'flowing' | 'done';

/** 顶部那条极轻的进度：三段，不是四段 —— 汇聚和匹配在用户眼里是同一件事。 */
const STRIP = ['分析目标', '匹配员工', '生成流程'];

const TITLES: Record<Phase, string> = {
  input: '',
  analyzing: '正在分析你的工作目标',
  matching: '正在匹配最适合完成任务的员工……',
  gathering: '正在匹配最适合完成任务的员工……',
  flowing: '正在安排工作流程',
  done: '自动编排完成',
};

const THINKING = ['分析任务内容', '识别需要完成的工作', '匹配员工能力'];

/** 当前走到第几段。done 时返回 3，三段全部标成已完成。 */
function stripAt(phase: Phase): number {
  if (phase === 'analyzing') return 0;
  if (phase === 'matching' || phase === 'gathering') return 1;
  if (phase === 'flowing') return 2;
  return 3;
}

interface Props {
  /** 现在能派活的同事。暂时不可用的员工不参与匹配。 */
  employees: SiliconEmployee[];
  skills: EmployeeSkill[];
  busy: boolean;
  onChooseFolder: () => Promise<string | null>;
  onOpenSettings: () => void;
  onStart: (plan: AutoPlan, extras: { confirmedInputs: string[]; sharedSkillIds: string[] }) => void;
}

export function AutoArrange({ employees, skills, busy, onChooseFolder, onOpenSettings, onStart }: Props) {
  const [goal, setGoal] = useState('');
  const [materials, setMaterials] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<AutoPlan | null>(null);
  const [phase, setPhase] = useState<Phase>('input');
  /** 第一拍：已经出现了几行判断。 */
  const [thought, setThought] = useState(0);
  /** 第二拍：正在扫哪一张卡；已经出结果的有几张。 */
  const [scan, setScan] = useState(-1);
  const [resolved, setResolved] = useState(0);
  /** 第三拍：落选的是否已经开始收掉。 */
  const [gathered, setGathered] = useState(false);
  /** 第四拍：流程里已经出现了几个元素（1 是工作目标，之后每一步占连线 + 卡片两个）。 */
  const [rows, setRows] = useState(0);
  const reduced = usePrefersReducedMotion();
  const beat = reduced ? 0.3 : 1;

  useEffect(() => {
    if (phase !== 'analyzing') return;
    const timers: number[] = [];
    const at = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms * beat));
    at(60, () => setThought(1));
    at(440, () => setThought(2));
    at(820, () => setThought(3));
    at(1520, () => setPhase('matching'));
    return () => timers.forEach(window.clearTimeout);
  }, [phase, beat]);

  useEffect(() => {
    if (phase !== 'matching' || !plan) return;
    const timers: number[] = [];
    const at = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms * beat));
    // 一张一张来：先亮起「匹配中」，400ms 后出结果。用户能感觉到 AI 在逐个判断。
    plan.pool.forEach((_, index) => {
      at(index * 560, () => setScan(index));
      at(index * 560 + 400, () => setResolved(index + 1));
    });
    at(plan.pool.length * 560 + 220, () => { setScan(-1); setPhase('gathering'); });
    return () => timers.forEach(window.clearTimeout);
  }, [phase, plan, beat]);

  useEffect(() => {
    if (phase !== 'gathering') return;
    setGathered(true);
    const timer = window.setTimeout(() => setPhase('flowing'), 720 * beat);
    return () => window.clearTimeout(timer);
  }, [phase, beat]);

  useEffect(() => {
    if (phase !== 'flowing' || !plan) return;
    const total = 1 + plan.stages.length * 2;
    setRows(1);
    const timers: number[] = [];
    for (let index = 2; index <= total; index += 1) {
      timers.push(window.setTimeout(() => setRows(index), (index - 1) * 380 * beat));
    }
    timers.push(window.setTimeout(() => setPhase('done'), ((total - 1) * 380 + 360) * beat));
    return () => timers.forEach(window.clearTimeout);
  }, [phase, plan, beat]);

  const begin = () => {
    const next = planAutoArrange(goal, employees);
    if (!next) return;
    setPlan(next);
    setThought(0);
    setScan(-1);
    setResolved(0);
    setGathered(false);
    setRows(0);
    setPhase('analyzing');
  };

  const restart = () => {
    setPhase('input');
    setPlan(null);
  };

  if (phase === 'input' || !plan) {
    return (
      <section className="ent-arr-auto">
        <header className="ent-arr-head">
          <h1>自动编排</h1>
          <p>告诉系统你想完成什么，AI 会自动选择员工并安排工作。</p>
        </header>
        <GoalComposer
          value={goal}
          onChange={setGoal}
          placeholder="例如：帮我分析618活动的数据，并生成一份完整的复盘报告。"
          materials={materials}
          onMaterials={setMaterials}
          skills={skills}
          skillIds={skillIds}
          onSkillIds={setSkillIds}
          onChooseFolder={onChooseFolder}
          submitLabel="开始编排"
          submitDisabled={!goal.trim() || !employees.length}
          onSubmit={begin}
        />
        <p className="ent-arr-note">
          现在可以派活的同事 {employees.length} 位。编排完成后你可以确认或者重新编排，确认之前不会有人开始干活。
        </p>
      </section>
    );
  }

  const at = stripAt(phase);
  const count = plan.stages.length;

  return (
    <section className="ent-arr-auto">
      <ol className="ent-aa-strip">
        {STRIP.map((label, index) => (
          <li key={label} className={index < at ? 'done' : index === at ? 'now' : 'wait'}>
            <span className="ent-aa-strip-tick" aria-hidden>{index < at ? <Check size={10} /> : null}</span>
            {label}
          </li>
        ))}
      </ol>

      <header className="ent-aa-head">
        <h1>
          {phase === 'done' ? <span className="ent-aa-ok" aria-hidden><Check size={12} /></span> : null}
          {TITLES[phase]}
        </h1>
        {phase === 'done' ? <p>已为你的任务安排 {count} 名员工，并拆分为 {count} 个工作阶段。</p> : null}
      </header>

      {phase === 'analyzing' ? (
        <ul className="ent-aa-think">
          {THINKING.map((line, index) => (
            <li key={line} className={index < thought ? 'in' : undefined}>
              <Sparkles size={13} aria-hidden />
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      {phase === 'matching' || phase === 'gathering' ? (
        <div className={`ent-aa-pool${gathered ? ' gathered' : ''}`}>
          {plan.pool.map((entry, index) => {
            const out = index < resolved;
            const tone = out ? (entry.picked ? 'picked' : 'passed') : index === scan ? 'scanning' : 'idle';
            return (
              <article
                key={entry.employee.id}
                className={`ent-aa-card ${tone}${gathered && !entry.picked ? ' gone' : ''}`}
              >
                <EmployeeFace seed={entry.employee.id} size="md" round />
                <strong>{entry.employee.name}</strong>
                <small>{entry.employee.roleName}</small>
                <span className="ent-aa-card-state">
                  {tone === 'scanning' ? <em>匹配中…</em> : null}
                  {tone === 'picked' ? (
                    <>
                      <b><Check size={11} aria-hidden />{entry.match}%</b>
                      <i>{entry.stage}</i>
                    </>
                  ) : null}
                </span>
              </article>
            );
          })}
        </div>
      ) : null}

      {phase === 'flowing' || phase === 'done' ? (
        <div className="ent-aa-flow">
          <article className={`ent-aa-goalnode${rows >= 1 ? ' in' : ''}`}>
            <span>工作目标</span>
            <p>{plan.title}</p>
          </article>
          {plan.stages.map((stage, index) => (
            <Fragment key={stage.step.id}>
              <Link shown={rows >= 2 + index * 2} />
              <FlowCard shown={rows >= 3 + index * 2} no={index + 1} stage={stage} />
            </Fragment>
          ))}
        </div>
      ) : null}

      {phase === 'done' ? (
        <footer className="ent-arr-foot">
          <button type="button" className="ent-arr-second" onClick={restart}>重新编排</button>
          <span className="ent-arr-gap" />
          <button type="button" className="ent-arr-ghost" onClick={onOpenSettings}>
            <Settings2 size={14} aria-hidden />
            执行设置
          </button>
          <button
            type="button"
            className="ent-arr-primary"
            disabled={busy}
            onClick={() => onStart(plan, { confirmedInputs: materials, sharedSkillIds: skillIds })}
          >
            {busy ? '正在安排…' : '确认并开始工作'}
            <ArrowRight size={15} aria-hidden />
          </button>
        </footer>
      ) : null}
    </section>
  );
}

/** 两张卡之间那根线。线本身用 stroke-dasharray 逐渐画出来，箭头稍后淡入。 */
function Link({ shown }: { shown: boolean }) {
  return (
    <svg className={`ent-aa-link${shown ? ' in' : ''}`} width="14" height="34" viewBox="0 0 14 34" aria-hidden focusable="false">
      <path className="ent-aa-link-line" d="M7 1V25" />
      <path className="ent-aa-link-tip" d="M3.6 24.4 7 28.6l3.4-4.2" />
    </svg>
  );
}

/** 最终流程里的一张卡：第几步、谁做、做什么、怎么做。 */
function FlowCard({ shown, no, stage }: { shown: boolean; no: number; stage: AutoStage }) {
  return (
    <article className={`ent-flowcard${shown ? ' in' : ''}`}>
      <span className="ent-flowcard-no" aria-hidden>{String(no).padStart(2, '0')}</span>
      <div className="ent-flowcard-body">
        <span className="ent-flowcard-who">
          <EmployeeFace seed={stage.employee.id} size="sm" round />
          <strong>{stage.employee.name}</strong>
          <small>{stage.employee.roleName}</small>
        </span>
        <strong className="ent-flowcard-stage">{stage.stage}</strong>
        <p>{stage.step.title}</p>
      </div>
    </article>
  );
}
