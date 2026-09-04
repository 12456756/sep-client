/**
 * 首页 = 员工概览。按设计稿三段，自上而下：
 * 1. 两格统计：公司员工总数 / 我拥有的员工。刻意做小 —— 视觉重点是员工，不是数字。
 * 2. 员工卡片墙：固定两行，每行几张按容器宽度算，两侧箭头翻页、两边渐隐露出下一页。
 * 3. 派活框：一句话派活，唯一的可选设置是工作场地。
 *
 * 页面上没有一句解释性长文案 —— 员工卡自己会说话（提醒气泡），派活框自己带例子。
 */

import { ChevronLeft, ChevronRight, UserRound, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Empty } from '../../components/enterprise/atoms';
import { ArrangeBar } from '../../components/enterprise/ArrangeBar';
import { EmployeeDeskCard, type DeskNotice } from '../../components/enterprise/EmployeeDeskCard';
import { EmployeeWorksDrawer } from '../../components/enterprise/EmployeeWorksDrawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';

export function HomePage({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { overview, employees, works, unreviewedWorkIds, navigate } = workspace;

  const roster = useMemo(() => employees.filter(item => item.assignedToMe), [employees]);
  const desks = useMemo(
    () => roster.map(employee => deskOf(employee, works, unreviewedWorkIds, startOfToday())),
    [roster, works, unreviewedWorkIds],
  );

  const [openId, setOpenId] = useState<string | null>(null);
  const openEmployee = openId ? roster.find(item => item.id === openId) : undefined;
  const openWorks = useMemo(
    () => (openEmployee
      ? works.filter(work => involves(work, openEmployee.id)).sort((left, right) => right.updatedAt - left.updatedAt)
      : []),
    [openEmployee, works],
  );

  const openWork = (workId: string) => { setOpenId(null); navigate({ name: 'work', workId }); };

  return (
    <div className="ent-page ent-home">
      <div className="ent-figures">
        <Figure label="公司员工总数" value={overview.totalEmployees} onClick={() => navigate({ name: 'employees', scope: 'all' })}>
          <Users size={19} aria-hidden />
        </Figure>
        <Figure label="我拥有的员工" value={roster.length} alt onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
          <UserRound size={19} aria-hidden />
        </Figure>
      </div>

      {roster.length ? (
        <Wall desks={desks} onOpen={setOpenId} onOpenWork={openWork} />
      ) : (
        <Empty title="企业还没有给你分配硅基员工">企业管理员分配之后，你的员工会出现在这里。</Empty>
      )}

      {roster.length ? (
        <ArrangeBar
          employees={roster.filter(item => item.availability !== 'unavailable')}
          busy={workspace.busy}
          onChooseSite={workspace.chooseFolder}
          onSend={(employeeId, text, workDir) => void workspace.startConversation(employeeId, text, { workDir })}
        />
      ) : null}

      {openEmployee ? (
        <EmployeeWorksDrawer
          employee={openEmployee}
          works={openWorks}
          onClose={() => setOpenId(null)}
          onOpenWork={openWork}
        />
      ) : null}
    </div>
  );
}

/** 一张员工卡最窄能读的宽度，和 .ent-desk 的设计尺寸（160~175）对齐。 */
const CARD_MIN = 164;
/** 卡与卡之间的横向间距，和 .ent-wall-page 的 column-gap 是同一个约定。 */
const CARD_GAP = 14;
/** 固定两行（设计稿如此），一页的容量就是「每行几张 × 2」。 */
const ROWS = 2;

/**
 * 员工墙。翻页用原生横向滚动 + scroll-snap，箭头只是 scrollBy 的快捷方式 ——
 * 触控板横扫和键盘滚动天然可用，也不用自己算 transform。
 * 步长直接量两页之间的距离，所以 CSS 改了间距这里不用跟着改。
 *
 * 每行几张不写死：量一页的实际宽度（滚动容器的内容盒，已经扣掉两侧渐隐带），
 * 按「至少 CARD_MIN 宽」往下取整。窗口一变宽就多放一张，不靠断点硬切。
 */
function Wall({ desks, onOpen, onOpenWork }: {
  desks: Desk[];
  onOpen: (employeeId: string) => void;
  onOpenWork: (workId: string) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  /** 一行放几张：量容器宽度算出来的，窗口一变宽就多放一张，不靠断点硬切。 */
  const [cols, setCols] = useState(4);
  const [edge, setEdge] = useState({ start: true, end: true });

  const pages = useMemo(() => {
    const size = Math.max(1, cols * ROWS);
    const out: Desk[][] = [];
    for (let index = 0; index < desks.length; index += size) out.push(desks.slice(index, index + size));
    return out;
  }, [desks, cols]);

  const sync = () => {
    const node = track.current;
    if (!node) return;
    setEdge({
      start: node.scrollLeft <= 4,
      end: node.scrollLeft >= node.scrollWidth - node.clientWidth - 4,
    });
  };

  // 一页的可用宽度就是滚动容器的内容盒宽度（padding 已经是两侧渐隐带）。
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      const inner = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setCols(Math.max(2, Math.min(6, Math.floor((inner + CARD_GAP) / (CARD_MIN + CARD_GAP)))));
      sync();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 列数变了页数也变，到头的判断要重算，否则右箭头可能停在禁用态。
  useEffect(sync, [pages.length]);

  const nudge = (direction: 1 | -1) => {
    const node = track.current;
    if (!node) return;
    const items = [...node.querySelectorAll<HTMLElement>('.ent-wall-page')];
    const step = items.length > 1 ? items[1]!.offsetLeft - items[0]!.offsetLeft : node.clientWidth;
    node.scrollBy({ left: direction * step, behavior: 'smooth' });
  };

  const single = pages.length <= 1;

  return (
    <div className={`ent-wall${edge.start || single ? ' at-start' : ''}${edge.end || single ? ' at-end' : ''}`}>
      <button type="button" className="ent-wall-arrow left" onClick={() => nudge(-1)} disabled={single || edge.start} aria-label="上一页员工">
        <ChevronLeft size={16} aria-hidden />
      </button>

      <div className="ent-wall-track" ref={track} onScroll={sync} style={{ ['--ent-wall-cols' as string]: cols }}>
        {pages.map((page, index) => (
          <div className="ent-wall-page" key={page[0]?.employee.id ?? index}>
            {page.map(desk => (
              <EmployeeDeskCard
                key={desk.employee.id}
                employee={desk.employee}
                load={desk.load}
                working={desk.working}
                notice={desk.notice}
                onOpen={onOpen}
                onOpenWork={onOpenWork}
              />
            ))}
          </div>
        ))}
      </div>

      <button type="button" className="ent-wall-arrow right" onClick={() => nudge(1)} disabled={single || edge.end} aria-label="下一页员工">
        <ChevronRight size={16} aria-hidden />
      </button>
    </div>
  );
}

/** 一格统计。整块可点，点进员工页对应的范围 —— 数字后面就该能跟到人。 */
function Figure({ label, value, onClick, alt = false, children }: {
  label: string;
  value: number;
  onClick: () => void;
  /** 第二格的图标片偏蓝一档（设计稿如此）。 */
  alt?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className={`ent-figure${alt ? ' alt' : ''}`} onClick={onClick}>
      <i aria-hidden>{children}</i>
      <span className="ent-figure-copy">
        <small>{label}</small>
        <strong>{value}<em>人</em></strong>
      </span>
    </button>
  );
}

interface Desk {
  employee: SiliconEmployee;
  load: { done: number; total: number };
  working: boolean;
  notice: DeskNotice | null;
}

function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * 一位员工今天的情形。
 *
 * 「在干活」两个信号取并集：平台报的状态，和本地真的有一项在跑的工作 ——
 * 只看平台会漏掉状态没跟上的人，只看工作会漏掉在替别人干活的人。
 *
 * 气泡最多一个，按「先说结果，再说卡住」的顺序挑：做完了请查阅（这是用户派完活之后
 * 一直在等的那句话）→ 等你拍板 → 中断了。后两种在铃铛和工作记录里也在，不会丢。
 */
function deskOf(
  employee: SiliconEmployee,
  works: WorkItem[],
  unreviewed: ReadonlySet<string>,
  dayStart: number,
): Desk {
  const mine = works.filter(work => involves(work, employee.id));
  const today = mine.filter(work => work.createdAt >= dayStart);
  const running = mine.some(work => work.status === 'running' && work.currentEmployeeId === employee.id);

  return {
    employee,
    load: { done: today.filter(work => work.status === 'completed').length, total: today.length },
    working: employee.availability === 'working' || running,
    notice: notice(mine, unreviewed),
  };
}

function notice(mine: WorkItem[], unreviewed: ReadonlySet<string>): DeskNotice | null {
  const pick = (kind: DeskNotice['kind'], list: WorkItem[]): DeskNotice | null => {
    const first = list[0];
    if (!first) return null;
    return { kind, workId: first.id, title: first.title, more: list.length - 1 };
  };
  return pick('done', mine.filter(work => unreviewed.has(work.id)))
    ?? pick('call', mine.filter(work => work.status === 'waiting-user'))
    ?? pick('stop', mine.filter(work => work.status === 'failed'));
}

/** 这项工作和这位员工有关：他是当前负责人、参与者，或者某一步派给了他。 */
function involves(work: WorkItem, employeeId: string): boolean {
  return work.currentEmployeeId === employeeId
    || work.participants.includes(employeeId)
    || work.steps.some(step => step.employeeId === employeeId);
}
