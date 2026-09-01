/**
 * 首页 = 点将台。用户是这些硅基员工的领导，所以首页按一场早会来排：
 * 先一句话汇报「你手下几个人、几个在干活、几件事等你拍板」，
 * 再点名（每位员工正在做什么、手上几项工作、能不能马上派活），
 * 最后才是「等你拍板」和「正在进行」这两摊具体的事。
 *
 * 视觉上刻意只留一块深色汇报带、一个实心按钮、一处卡片容器（等你拍板那一叠），
 * 其余全部裸在页面底色上用发丝线分隔。层次靠一句话里放大三倍的数字建立，
 * 不靠再多摆几个指标格 —— 四个等重的指标格正是上一版读起来像模板的原因。
 */

import {
  ArrowRight, Bookmark, CheckCircle2, ChevronRight, CircleDot, CircleSlash, ClipboardCheck, Clock3,
  FileText, FolderTree, Hourglass, LineChart, Loader2, MessageSquare, Radar, RotateCcw, ShieldAlert,
  Sparkles, Trash2, UserPlus, Workflow, XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmployeeAvatar, Empty, WorkStatusChip } from '../../components/enterprise/atoms';
import { createStep } from '../../components/enterprise/StepEditor';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';
import { relativeTime, stepProgressText } from '../../features/enterprise/vocabulary';
import { completedStepCount } from '../../features/enterprise/work-mapping';

const TEMPLATE_ICON: Record<string, typeof FileText> = {
  'customer-weekly': FileText,
  'contract-precheck': ClipboardCheck,
  'material-tidy': FolderTree,
  'data-summary': LineChart,
  'market-scan': Radar,
};

/** 常做的工作一次只铺这么多，其余收进「更多」。 */
const RAIL_LIMIT = 5;

export function HomePage({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { overview, employees, works, templates, savedFlows, navigate, seedArrange } = workspace;

  const roster = useMemo(() => employees.filter(item => item.assignedToMe), [employees]);
  const duties = useMemo(() => dutyMap(roster, works), [roster, works]);
  const calls = useMemo(() => works.filter(work => work.status === 'waiting-user' || work.status === 'failed'), [works]);
  const live = useMemo(() => works.filter(work => work.status === 'running' || work.status === 'arranging'), [works]);
  const busyCount = roster.filter(item => item.availability === 'working').length;
  const unassigned = Math.max(0, overview.totalEmployees - roster.length);

  const [pileOpen, setPileOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [askDelete, setAskDelete] = useState<string | null>(null);

  /** 安排工作。带员工进来时直接进自己安排步骤那一页，第一步的人已经选好。 */
  const openArrange = useCallback((employeeId?: string) => {
    seedArrange(employeeId ? { goal: '', steps: [createStep(employeeId, 0)] } : null);
    navigate({ name: 'arrange', custom: Boolean(employeeId) });
  }, [navigate, seedArrange]);

  // 汇报带上画了两个键帽，就得真的能按。只在首页生效，别的页面没有这个提示。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      openArrange();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openArrange]);

  const strip = [
    { id: 'total', label: '企业硅基员工', value: overview.totalEmployees, tone: '', go: () => navigate({ name: 'employees', scope: 'all' }) },
    { id: 'mine', label: '已分配给我', value: overview.availableToMe, tone: '', go: () => navigate({ name: 'employees', scope: 'mine' }) },
    { id: 'active', label: '正在进行', value: overview.activeWorkCount, tone: '', go: () => navigate({ name: 'records', bucket: 'active' }) },
    { id: 'needs', label: '等你处理', value: overview.needsMeCount, tone: overview.needsMeCount ? 'call' : '', go: () => navigate({ name: 'records', bucket: 'mine' }) },
  ];

  const rail = [
    ...savedFlows.map(flow => ({ kind: 'saved' as const, id: flow.id, name: flow.name, goal: flow.goal, steps: flow.steps.length })),
    ...templates.map(item => ({ kind: 'template' as const, id: item.id, name: item.name, goal: item.goal, steps: item.steps.length })),
  ];
  const railShown = railOpen ? rail : rail.slice(0, RAIL_LIMIT);

  return (
    <div className="ent-page ent-home">
      {/* ① 汇报：一句话 + 一条数据带 + 全页唯一的实心按钮。 */}
      <section className="ent-brief" aria-label="今日汇报">
        <div className="ent-brief-say">
          <p className="ent-brief-line">
            <span>{greeting()}{workspace.userName ? `，${workspace.userName}` : ''}。</span>
            {roster.length ? (
              <>
                <span>你手下</span><Figure value={roster.length} /><span>位硅基员工，</span>
                {busyCount
                  ? <><Figure value={busyCount} tone="live" /><span>位正在替你干活</span></>
                  : <span>现在都空着，随时可以点名</span>}
                {calls.length
                  ? <><span>，</span><Figure value={calls.length} tone="call" /><span>项工作等你拍板。</span></>
                  : <span>，没有需要你拍板的事。</span>}
              </>
            ) : (
              <span>企业还没有给你分配硅基员工。管理员分配之后，你就能在这里点名派活。</span>
            )}
          </p>
          <div className="ent-brief-strip">
            {strip.map(item => (
              <button key={item.id} type="button" className={`ent-brief-cell${item.tone ? ` ${item.tone}` : ''}`} onClick={item.go}>
                <span>{item.label}</span>
                <em>{item.value}</em>
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="ent-btn primary lg ent-brief-cta" onClick={() => openArrange()}>
          <Workflow size={15} aria-hidden />
          安排工作
          <kbd className="ent-kbd" aria-hidden>Ctrl</kbd>
          <kbd className="ent-kbd" aria-hidden>K</kbd>
        </button>
      </section>
      {/* ② 点名：一行一位员工，正在做什么写在名字下面，右边露出「派活给他」。 */}
      <section className="ent-band" aria-label="点将台">
        <div className="ent-band-head">
          <h2>点将台</h2>
          <p>分配给你的硅基员工，点名即可派活。</p>
        </div>
        {roster.length ? (
          <ul className="ent-roster">
            {roster.map(employee => (
              <RosterRow
                key={employee.id}
                employee={employee}
                duty={duties.get(employee.id)}
                onOpen={() => navigate({ name: 'employee', employeeId: employee.id })}
                onArrange={() => openArrange(employee.id)}
              />
            ))}
          </ul>
        ) : (
          <Empty title="还没有可以点名的员工">企业给你分配硅基员工之后，这里会列出每一位以及他们正在做的工作。</Empty>
        )}
        {unassigned ? (
          <button type="button" className="ent-band-more" onClick={() => navigate({ name: 'employees', scope: 'all' })}>
            企业还有 {unassigned} 位硅基员工没有分配给你
            <ArrowRight size={13} aria-hidden />
          </button>
        ) : null}
      </section>
      {/* ③ 等你拍板：一叠卡片。没有要拍板的事时整块不出现，不留空框。 */}
      {calls.length ? (
        <section className="ent-band" aria-label="等你拍板">
          <div className="ent-band-head">
            <h2>等你拍板</h2>
            <p>{calls.length} 项工作停在你这里，处理完才会往下走。</p>
            {calls.length > 1 ? (
              <button type="button" className="link" onClick={() => setPileOpen(open => !open)} aria-expanded={pileOpen}>
                {pileOpen ? '收起' : `展开另外 ${calls.length - 1} 项`}
                <ChevronRight size={13} aria-hidden />
              </button>
            ) : null}
          </div>
          <div className={`ent-pile${pileOpen ? ' open' : ''}${calls.length > 1 ? ' stacked' : ''}`}>
            <CallCard work={calls[0]!} workspace={workspace} />
            <div className="ent-pile-rest" aria-hidden={!pileOpen}>
              <div>
                {calls.slice(1).map(work => <CallCard key={work.id} work={work} workspace={workspace} />)}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* ④ 正在进行：员工手上还没停的工作，进度用刻度而不是一根百分比条。 */}
      <section className="ent-band" aria-label="正在进行">
        <div className="ent-band-head">
          <h2>正在进行</h2>
          <p>硅基员工正在替你做的事。</p>
          <button type="button" className="link" onClick={() => navigate({ name: 'records' })}>
            全部工作记录
            <ArrowRight size={13} aria-hidden />
          </button>
        </div>
        {live.length ? (
          <ul className="ent-live">
            {live.map(work => (
              <li key={work.id}>
                <button type="button" className="ent-live-row" onClick={() => navigate({ name: 'work', workId: work.id })}>
                  <span className="ent-live-id">
                    <strong>{work.title}</strong>
                    <small>{work.currentEmployeeName} 正在负责 · {relativeTime(work.updatedAt)}</small>
                  </span>
                  <StepTrack work={work} />
                  <WorkStatusChip value={work.status} />
                  <ChevronRight size={15} aria-hidden className="ent-live-go" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={calls.length ? '没有正在进行的工作' : '现在没人在忙'}>
            {roster.length ? '按「安排工作」或者在点将台上点一位员工派活。' : '等企业给你分配硅基员工之后就可以派活了。'}
          </Empty>
        )}
      </section>

      {/* ⑤ 常做的工作：收成一条 chip 轨，不再是七张争抢注意力的卡片。 */}
      {rail.length ? (
        <section className="ent-band" aria-label="常做的工作">
          <div className="ent-band-head">
            <h2>常做的工作</h2>
            <p>企业预设的流程和你自己存下来的安排，选一个直接开工。</p>
            <button type="button" className="link" onClick={() => openArrange()}>
              <Workflow size={13} aria-hidden />
              自己安排步骤
            </button>
          </div>
          <ul className="ent-rail">
            {railShown.map(entry => {
              const Icon = entry.kind === 'saved' ? Bookmark : TEMPLATE_ICON[entry.id] ?? Sparkles;
              return (
                <li key={`${entry.kind}-${entry.id}`} className={`ent-rail-chip${entry.kind === 'saved' ? ' saved' : ''}`}>
                  <button
                    type="button"
                    className="ent-rail-main"
                    title={entry.goal}
                    onClick={() => entry.kind === 'saved' ? workspace.runSavedFlow(entry.id) : navigate({ name: 'arrange', templateId: entry.id })}
                  >
                    <Icon size={14} aria-hidden />
                    <span>
                      <strong>{entry.name}</strong>
                      <small>{entry.kind === 'saved' ? '我保存的' : '企业预设'} · {entry.steps} 步</small>
                    </span>
                  </button>
                  {entry.kind === 'saved' ? (
                    askDelete === entry.id ? (
                      <span className="ent-rail-ask">
                        <button type="button" onClick={() => { workspace.deleteSavedFlow(entry.id); setAskDelete(null); }}>删除</button>
                        <button type="button" onClick={() => setAskDelete(null)}>保留</button>
                      </span>
                    ) : (
                      <button type="button" className="ent-rail-del" onClick={() => setAskDelete(entry.id)} aria-label={`删除「${entry.name}」`}>
                        <Trash2 size={13} aria-hidden />
                      </button>
                    )
                  ) : null}
                </li>
              );
            })}
            {rail.length > RAIL_LIMIT ? (
              <li>
                <button type="button" className="ent-rail-more" onClick={() => setRailOpen(open => !open)} aria-expanded={railOpen}>
                  {railOpen ? '收起' : `更多 ${rail.length - RAIL_LIMIT} 个`}
                  <ChevronRight size={13} aria-hidden />
                </button>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * 点将台的一行。外层不能是 button —— 里面还要放「派活给他」这个按钮，
 * 嵌套 button 是非法结构，所以主体按钮和动作按钮是兄弟节点（沿用已保存流程卡片的写法）。
 */
function RosterRow({ employee, duty, onOpen, onArrange }: {
  employee: SiliconEmployee;
  duty: Duty | undefined;
  onOpen: () => void;
  onArrange: () => void;
}) {
  const tone = duty?.tone ?? 'muted';
  const Icon = duty?.Icon ?? CircleDot;
  const canWork = employee.availability === 'ready' || employee.availability === 'working';
  return (
    <li className={`ent-roster-row ${tone}`}>
      <button type="button" className="ent-roster-main" onClick={onOpen}>
        <span className="ent-roster-face">
          <EmployeeAvatar mark={employee.mark} dim={!canWork} />
          <span className="ent-roster-ring" aria-hidden />
        </span>
        <span className="ent-roster-id">
          <strong>{employee.name}</strong>
          <small>{employee.roleName}{employee.department ? ` · ${employee.department}` : ''}</small>
        </span>
        <span className={`ent-roster-doing ${tone}${duty?.live ? ' live' : ''}`}>
          {/* .spin 是 index.css 里的全局旋转类，状态标签已经在用，这里复用不再新写一份。 */}
          <Icon size={13} className={duty?.live ? 'spin' : undefined} aria-hidden />
          <span>{duty?.text ?? '暂无记录'}</span>
        </span>
      </button>
      <span className={`ent-roster-load${duty?.count ? '' : ' zero'}`} title={duty?.count ? `手上有 ${duty.count} 项工作` : '手上没有工作'}>
        <em>{duty?.count ?? 0}</em>
        <small>项在手</small>
      </span>
      {canWork ? (
        <button type="button" className="ent-roster-send" onClick={onArrange}>
          <UserPlus size={14} aria-hidden />
          <span>派活给他</span>
        </button>
      ) : (
        <span className="ent-roster-send off" aria-hidden><UserPlus size={14} /></span>
      )}
    </li>
  );
}

/** 等你拍板的一张卡：为什么停下来、下一步按哪个，都在同一张卡里说完。 */
function CallCard({ work, workspace }: { work: WorkItem; workspace: EnterpriseWorkspace }) {
  const waiting = work.status === 'waiting-user';
  const done = completedStepCount(work.steps);
  return (
    <article className={`ent-call ${waiting ? 'attention' : 'danger'}`}>
      <div className="ent-call-say">
        {waiting ? <Hourglass size={15} aria-hidden /> : <XCircle size={15} aria-hidden />}
        <span>
          <strong>{work.title}</strong>
          <small>{work.nextUserAction ?? (work.stopReason ? `中断原因：${work.stopReason}` : '看一下结果再决定怎么继续')}</small>
        </span>
      </div>
      <div className="ent-call-foot">
        <WorkStatusChip value={work.status} />
        {work.steps.length ? <span className="ent-tag">{stepProgressText(done, work.steps.length)}</span> : null}
        <span className="ent-tag">{work.currentEmployeeName}</span>
        <span className="ent-ask-spacer" />
        <button type="button" className="ent-btn ghost sm" onClick={() => workspace.navigate({ name: 'work', workId: work.id })}>
          打开看看
        </button>
        {waiting ? (
          <button type="button" className="ent-btn sm" onClick={() => void workspace.confirmStep(work.id)} disabled={workspace.busy}>
            <CheckCircle2 size={13} aria-hidden />
            确认，继续
          </button>
        ) : (
          <button type="button" className="ent-btn sm" onClick={() => void workspace.retryWork(work.id)} disabled={workspace.busy}>
            <RotateCcw size={13} aria-hidden />
            重新试一次
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * 步骤刻度。平台目前不按步骤上报进度（见 work-mapping 里 deriveStepStates 的注释），
 * 所以正在做的那一格只用一道来回扫的光表示「在动」，不编一个假的百分比数字。
 */
function StepTrack({ work }: { work: WorkItem }) {
  if (work.steps.length) {
    const done = completedStepCount(work.steps);
    return (
      <span className="ent-track" role="img" aria-label={stepProgressText(done, work.steps.length)}>
        <span className="ent-track-ticks">
          {work.steps.map(step => <i key={step.id} className={step.state} />)}
        </span>
        <small>{done} / {work.steps.length} 步</small>
      </span>
    );
  }
  // 流程式工作也可能读不出步骤（老数据的步骤计划走的是另一个标记，见 work-mapping
  // 里的 LEGACY_PLAN_MARKER），这时候只有平台报的整体进度可用，不能反过来说成对话式工作。
  if (work.kind === 'flow') {
    return (
      <span className="ent-track none">
        <Workflow size={13} aria-hidden />
        {work.progress > 0 ? `整体完成 ${Math.round(work.progress)}%` : '流程还没开始'}
      </span>
    );
  }
  return (
    <span className="ent-track none">
      <MessageSquare size={13} aria-hidden />
      对话式工作
    </span>
  );
}

/** 汇报句里那个放大的数字。数字变化时从上一次的值滚上去，第一次进页面从 0 滚。 */
function Figure({ value, tone }: { value: number; tone?: string }) {
  const shown = useCountUp(value);
  return <em className={`ent-figure${tone ? ` ${tone}` : ''}`}>{shown}</em>;
}

/**
 * 计数动画。基准是「上一次真正显示出来的数字」而不是目标值，
 * 所以后续更新不会又从 0 开始，StrictMode 里重跑一遍 effect 也不会停在 0。
 * 系统关掉动效时直接给结果。
 */
function useCountUp(value: number, ms = 640): number {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  useEffect(() => {
    const start = shownRef.current;
    if (start === value) return;
    const show = (next: number) => { shownRef.current = next; setShown(next); };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      show(value);
      return;
    }
    let raf = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - began) / ms);
      show(Math.round(start + (value - start) * (1 - (1 - ratio) ** 3)));
      if (ratio < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return '早上好';
  if (hour >= 11 && hour < 13) return '中午好';
  if (hour >= 13 && hour < 18) return '下午好';
  return '晚上好';
}

/** 一位员工此刻的状态：手上几项、在做什么、用什么语气说。 */
interface Duty {
  count: number;
  tone: 'busy' | 'attention' | 'danger' | 'ready' | 'muted';
  Icon: typeof Loader2;
  text: string;
  /** 文字要不要做流光。只有真的在干活时才动，否则整页会一直闪。 */
  live: boolean;
}

/**
 * 「手上有几项工作」在 SiliconEmployee 上没有字段，只能从工作反推：
 * 当前负责人、参与过的人、以及被指派了步骤的人，都算这位员工手上的活。
 */
function dutyMap(roster: SiliconEmployee[], works: WorkItem[]): Map<string, Duty> {
  const map = new Map<string, Duty>();
  for (const employee of roster) {
    const open = works.filter(work => work.status !== 'completed' && work.status !== 'paused' && involves(work, employee.id));
    const mine = open.filter(work => work.currentEmployeeId === employee.id);
    const current = mine.find(work => work.status === 'running')
      ?? mine.find(work => work.status === 'waiting-user')
      ?? mine.find(work => work.status === 'failed')
      ?? mine[0];
    map.set(employee.id, { count: open.length, ...doing(employee, current) });
  }
  return map;
}

function involves(work: WorkItem, employeeId: string): boolean {
  return work.currentEmployeeId === employeeId
    || work.participants.includes(employeeId)
    || work.steps.some(step => step.employeeId === employeeId);
}

/**
 * 员工名字下面那一行。有在做的工作就说工作，没有就说可用状态和上次干活的时间 ——
 * 「可工作 / 需要授权 / 暂时不可用」本来就带颜色和图标，folding 进这一行可以少一个状态标签。
 */
function doing(employee: SiliconEmployee, work: WorkItem | undefined): Omit<Duty, 'count'> {
  if (work) {
    const step = work.steps.find(item => item.state === 'running' || item.state === 'waiting-user');
    const at = step ? `第 ${work.steps.indexOf(step) + 1} / ${work.steps.length} 步 · ${step.title}` : '';
    switch (work.status) {
      case 'running':
        return { tone: 'busy', Icon: Loader2, text: `正在做《${work.title}》${at ? ` · ${at}` : ''}`, live: true };
      case 'waiting-user':
        return { tone: 'attention', Icon: Hourglass, text: `《${work.title}》等你拍板${at ? `：${step!.title}` : ''}`, live: false };
      case 'failed':
        return { tone: 'danger', Icon: XCircle, text: `《${work.title}》中途停下来了，等你决定重试还是换人`, live: false };
      default:
        return { tone: 'muted', Icon: Clock3, text: `《${work.title}》已经安排好，还没开工`, live: false };
    }
  }
  switch (employee.availability) {
    case 'working':
      return { tone: 'busy', Icon: Loader2, text: '正在处理别人交给他的工作，可以排队', live: true };
    case 'needs-auth':
      return { tone: 'attention', Icon: ShieldAlert, text: '需要授权 · 开启本机操作权限后才能开工', live: false };
    case 'unavailable':
      return { tone: 'muted', Icon: CircleSlash, text: '暂时不可用 · 企业暂停了这位员工，或授权已到期', live: false };
    default:
      return {
        tone: 'ready',
        Icon: CircleDot,
        text: employee.lastWorkedAt ? `空闲 · 上次替你干活是 ${relativeTime(employee.lastWorkedAt)}` : '空闲 · 还没替你干过活，随时可以点名',
        live: false,
      };
  }
}




