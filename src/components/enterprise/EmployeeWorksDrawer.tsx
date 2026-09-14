/**
 * 点开一位员工后的侧边抽屉：他手上的工作，一条一卡，点一条进工作详情。
 *
 * 三个页签只做筛选（正在进行 / 已完成 / 全部），刻意不放任何操作按钮 ——
 * 不派活、不确认、不重试。用户在这里只需要扫一眼标题和进度就能决定去哪。
 *
 * 做成从右侧推进来的抽屉而不是居中弹窗：抽屉留着底下的员工墙，
 * 用户不会丢掉「我刚点的是谁」这个上下文。
 */

import { ChevronRight, FileCheck2, Hourglass, ListTree, Loader2, PauseCircle, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';
import { dayTimeText, durationText, EMPLOYEE_AVAILABILITY, relativeTime } from '../../features/enterprise/vocabulary';
import { EmployeeFace } from './EmployeeFace';

type Tab = 'live' | 'done' | 'all';

interface Props {
  employee: SiliconEmployee;
  /** 已经按「这位员工参与过」筛好的工作，按更新时间从新到旧。 */
  works: WorkItem[];
  onClose: () => void;
  onOpenWork: (workId: string) => void;
}

/** 没结束的算「正在进行」—— 等你拍板和中断了也在这一栏，因为它们都还没交付。 */
const isLive = (work: WorkItem) => work.status !== 'completed' && work.status !== 'paused';

export function EmployeeWorksDrawer({ employee, works, onClose, onOpenWork }: Props) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>('live');

  const live = works.filter(isLive);
  const done = works.filter(work => !isLive(work));

  // 打开时焦点落在第一张工作卡上，Esc 关闭，Tab 在抽屉内循环。
  useEffect(() => {
    const initialFocus = panel.current?.querySelector<HTMLElement>('.ent-worktile')
      ?? panel.current?.querySelector<HTMLElement>('button');
    initialFocus?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const state = EMPLOYEE_AVAILABILITY[employee.availability];
  const tone = employee.availability === 'working' ? 'work' : employee.availability === 'ready' ? '' : 'off';

  return (
    <>
      <div className="ent-drawer-back" role="presentation" onMouseDown={onClose} />
      <aside className="ent-drawer" role="dialog" aria-modal="true" aria-labelledby="ent-drawer-name" ref={panel}>
        <header className="ent-drawer-head">
          <EmployeeFace seed={employee.id} size="xl" />
          <div className="ent-drawer-id">
            <h2 id="ent-drawer-name">{employee.name}</h2>
            <small>{employee.roleName}</small>
            <span className={`ent-drawer-live ${tone}`}>
              <i aria-hidden />
              {employee.availability === 'working' ? '正在工作' : state.label}
            </span>
          </div>
          <button type="button" className="ent-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="ent-drawer-tabs" role="tablist" aria-label="工作范围">
          <Tabs tab={tab} onTab={setTab} live={live.length} done={done.length} all={works.length} />
        </div>

        <div className="ent-drawer-body">
          {/* 只筛一类时不再写小标题：页签上已经写了「正在进行」，标题重复一遍是废话。 */}
          {tab !== 'done' ? <Group label="正在进行" works={live} headed={tab === 'all'} onOpenWork={onOpenWork} /> : null}
          {tab !== 'live' ? <Group label="已完成" works={done} headed={tab === 'all'} onOpenWork={onOpenWork} /> : null}
          {(tab === 'live' ? live : tab === 'done' ? done : works).length
            ? null
            : <p className="ent-hint">{employee.name}名下还没有这一类工作。</p>}
        </div>
      </aside>
    </>
  );
}

function Tabs({ tab, onTab, live, done, all }: { tab: Tab; onTab: (next: Tab) => void; live: number; done: number; all: number }) {
  const items: { id: Tab; label: string; count: number }[] = [
    { id: 'live', label: '正在进行', count: live },
    { id: 'done', label: '已完成', count: done },
    { id: 'all', label: '全部', count: all },
  ];
  return (
    <>
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={tab === item.id ? 'active' : undefined}
          onClick={() => onTab(item.id)}
        >
          {item.label} ({item.count})
        </button>
      ))}
    </>
  );
}

function Group({ label, works, headed, onOpenWork }: { label: string; works: WorkItem[]; headed: boolean; onOpenWork: (id: string) => void }) {
  if (!works.length) return null;
  return (
    <section className="ent-drawer-group">
      {headed ? <h3>{label} <em>({works.length})</em></h3> : null}
      <ul className="ent-drawer-list">
        {works.map(work => <li key={work.id}><Tile work={work} onOpenWork={onOpenWork} /></li>)}
      </ul>
    </section>
  );
}

/** 一张工作卡。进行中的给进度，已完成的给完成时间与产出数量 —— 两者都不写状态标签，图标已经说了。 */
function Tile({ work, onOpenWork }: { work: WorkItem; onOpenWork: (id: string) => void }) {
  const look = LOOK[work.status];
  const Icon = look.icon;
  const percent = Math.round(work.progress);
  return (
    <button type="button" className={`ent-worktile ${look.kind}`} onClick={() => onOpenWork(work.id)}>
      <i aria-hidden><Icon size={17} /></i>
      <span className="ent-worktile-main">
        <strong>{work.title}</strong>
        {work.status === 'running' || work.status === 'waiting-user' ? (
          <>
            <small>{look.note} · 已进行 {durationText(Date.now() - work.createdAt)}</small>
            <span className="ent-bar">
              <span><i className={percent >= 100 ? 'full' : undefined} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} /></span>
              <b>{percent}%</b>
            </span>
            <small>最后更新：{relativeTime(work.updatedAt)}</small>
          </>
        ) : (
          <>
            <small>{work.status === 'completed' ? `${dayTimeText(work.updatedAt)} 完成` : look.note}</small>
            <small>{work.deliverables.length ? `已生成 ${work.deliverables.length} 个文件` : '没有产出文件'}</small>
          </>
        )}
      </span>
      <ChevronRight size={14} aria-hidden />
    </button>
  );
}

/**
 * 每种状态的图标、图标片配色和那一句附注。全部集中在这里，不散在 JSX 里。
 * running 的 kind 是 live：那颗圈要转起来（见 .ent-worktile.live），
 * 其余状态的图标是静止的形状 —— 停着的事不该看起来在动。
 */
const LOOK: Record<WorkItem['status'], { icon: typeof ListTree; kind: string; note: string }> = {
  running: { icon: Loader2, kind: 'live', note: '正在进行' },
  arranging: { icon: ListTree, kind: '', note: '已安排好，还没开工' },
  'waiting-user': { icon: Hourglass, kind: 'call', note: '等你拍板' },
  completed: { icon: FileCheck2, kind: 'done', note: '已完成' },
  failed: { icon: XCircle, kind: 'stop', note: '中断了，等你处理' },
  paused: { icon: PauseCircle, kind: '', note: '已终止' },
};


