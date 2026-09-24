/**
 * 个人工作台：首页先回答「现在需要我做什么」，再展示进行中的工作和已订阅员工。
 * 安排工作是明确的次级入口，员工墙保留原有滚动能力，不制造虚构业务数据。
 */

import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, CircleDot, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { Empty, WorkStatusChip } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { EmployeeDeskCard, type DeskFlag } from '../../components/enterprise/EmployeeDeskCard';
import { EmployeeWorksDrawer } from '../../components/enterprise/EmployeeWorksDrawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { usePrefersReducedMotion } from '../../features/enterprise/use-reduced-motion';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';
import { relativeTime } from '../../features/enterprise/vocabulary';

export function HomePage({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { overview, employees, works, unreviewedWorkIds, navigate } = workspace;

  const roster = useMemo(() => employees.filter(item => item.assignedToMe), [employees]);
  const desks = useMemo(
    () => roster.map(employee => deskOf(employee, works, unreviewedWorkIds, startOfToday())),
    [roster, works, unreviewedWorkIds],
  );
  const needsMe = useMemo(
    () => works
      .filter(work => work.status === 'waiting-user' || Boolean(work.nextUserAction) || unreviewedWorkIds.has(work.id))
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [works, unreviewedWorkIds],
  );
  const activeWorks = useMemo(
    () => works
      .filter(work => work.status === 'running' || work.status === 'arranging')
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [works],
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
      <div className="ent-home-content">
        <header className="ent-home-heading">
          <div>
            <span className="ent-home-eyebrow">个人工作台</span>
            <h1>今天，从这里开始</h1>
            <p>先处理需要你的事项，再查看正在推进的工作。</p>
          </div>
          <button type="button" className="ent-btn primary lg" onClick={() => navigate({ name: 'arrange' })}>
            <Plus size={16} aria-hidden />
            安排工作
          </button>
        </header>

        <div className="ent-home-summary" aria-label="工作概览">
          <button type="button" onClick={() => navigate({ name: 'records', bucket: 'mine' })}>
            <strong>{needsMe.length}</strong><span>待我处理</span>
          </button>
          <button type="button" onClick={() => navigate({ name: 'records', bucket: 'active' })}>
            <strong>{activeWorks.length}</strong><span>进行中</span>
          </button>
          <button type="button" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
            <strong>{roster.length}</strong><span>已订阅员工</span>
          </button>
          <span className="ent-home-summary-note">企业共 {overview.totalEmployees} 位硅基员工</span>
        </div>

        <HomeWorkSection
          title="待我处理"
          description="需要你确认、查看结果或决定下一步的工作"
          count={needsMe.length}
          works={needsMe}
          employees={roster}
          emptyTitle="目前没有需要你处理的工作"
          emptyDescription="新的确认事项和交付结果会优先出现在这里。"
          onOpen={workId => navigate({ name: 'work', workId })}
          tone="attention"
        />

        <HomeWorkSection
          title="进行中"
          description="正在由硅基员工推进的工作"
          count={activeWorks.length}
          works={activeWorks}
          employees={roster}
          emptyTitle="目前没有进行中的工作"
          emptyDescription="安排一项工作后，它会在这里持续显示进展。"
          onOpen={workId => navigate({ name: 'work', workId })}
          tone="active"
        />

        <section className="ent-home-employees">
          <div className="ent-section-head">
            <div>
              <h2>已订阅的硅基员工 <em>{roster.length}</em></h2>
              <p>点击员工查看他正在处理和已经完成的工作</p>
            </div>
            <button type="button" className="link" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
              查看全部 <ArrowRight size={14} aria-hidden />
            </button>
          </div>
          {roster.length ? (
            <Wall desks={desks} usable={roster.filter(item => item.availability !== 'unavailable').length} onOpen={setOpenId} />
          ) : (
            <Empty title="企业还没有给你分配硅基员工">企业管理员分配之后，你的员工会出现在这里。</Empty>
          )}
        </section>
      </div>

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

function HomeWorkSection({
  title,
  description,
  count,
  works,
  employees,
  emptyTitle,
  emptyDescription,
  onOpen,
  tone,
}: {
  title: string;
  description: string;
  count: number;
  works: WorkItem[];
  employees: SiliconEmployee[];
  emptyTitle: string;
  emptyDescription: string;
  onOpen: (workId: string) => void;
  tone: 'attention' | 'active';
}) {
  return (
    <section className={`ent-home-work-section ${tone}`}>
      <div className="ent-section-head">
        <div>
          <h2>{title} <em>{count}</em></h2>
          <p>{description}</p>
        </div>
        {count ? <span className="ent-home-section-status"><CircleDot size={13} aria-hidden />实时更新</span> : null}
      </div>
      {works.length ? (
        <div className="ent-home-work-grid">
          {works.slice(0, 4).map(work => (
            <HomeWorkCard key={work.id} work={work} employee={employees.find(item => item.id === work.currentEmployeeId)} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div className="ent-home-inline-empty">
          <CheckCircle2 size={17} aria-hidden />
          <span><strong>{emptyTitle}</strong><small>{emptyDescription}</small></span>
        </div>
      )}
    </section>
  );
}

function HomeWorkCard({ work, employee, onOpen }: { work: WorkItem; employee?: SiliconEmployee; onOpen: (workId: string) => void }) {
  return (
    <button type="button" className="ent-home-work-card" onClick={() => onOpen(work.id)}>
      <div className="ent-home-work-card-head">
        <WorkStatusChip value={work.status} />
        <span>{relativeTime(work.updatedAt)}</span>
      </div>
      <strong className="ent-home-work-title">{work.title}</strong>
      <p>{work.nextUserAction ?? work.goal}</p>
      <div className="ent-home-work-person">
        <EmployeeFace employee={employee} name={work.currentEmployeeName} size="sm" round />
        <span>{work.currentEmployeeName}</span>
        <ArrowRight size={14} aria-hidden />
      </div>
    </button>
  );
}

/**
 * 一张员工卡最窄能读的宽度。
 *
 * 设计稿的卡是 160~175，但那上面的名字是「小夏」「阿杰」这样两三个字；真实的员工叫
 * 「运营文案助手」「财务对账助手」，六个字 14px 就要 84 —— 卡再窄名字就只能打点。
 * 所以下限取 176：扣掉 12 的内边距、58 的头像片和 10 的间距，正好留得下六个字。
 */
const CARD_MIN = 176;
/** 一张卡最宽到这里就不再长了：再宽就不是一张卡片，而是一块板子。 */
const CARD_MAX = 190;
/** 卡与卡之间的横向间距。一屏装得下时就是这个数，成环时会为了铺满而算宽一点。 */
const CARD_GAP = 14;
/** 间距最多摊到这里。再宽就不像一排卡片了，多出来的宽度改为还给卡片本身。 */
const GAP_MAX = 34;
/** 为了铺满而放宽的卡片上限。只在窗口宽度没法用 CARD_MAX 整齐排满时才用到。 */
const CARD_WIDE = 214;
/** 最多两行（设计稿如此）。成环时一列就是「上下两位员工」，墙是由这样的列组成的。 */
const ROWS = 2;
/** 滑一列的时长。和抽屉、页面进场同一档，都在 250~300ms。 */
const SLIDE_MS = 260;
/**
 * 轨道两侧各多挂几列。
 *
 * 渐隐带里露一列，滑动时又要有一列从带子外面进来，所以每侧至少备两列 ——
 * 只备一列的话滑到一半右边会空出一块底色。
 */
const SPARE = 2;

/**
 * 一屏放几列、一张卡多宽、间距多大。
 *
 * 先按「至少 CARD_MIN 宽」定列数，再让卡片铺满这一屏：多出来的宽度先摊进间距，
 * 摊到 GAP_MAX 还有剩就把剩下的还给卡片（放宽到 CARD_WIDE）。
 * 这样第一张卡的左边缘和统计格对齐、最后一张卡的右边缘和内容区右边缘对齐，间距也均匀 ——
 * 换成 1fr 均分再居中会让每张卡往格子中间缩几像素，两头就都对不上。
 */
function fit(inner: number): { cols: number; card: number; gap: number } {
  const cols = Math.max(2, Math.min(6, Math.floor((inner + CARD_GAP) / (CARD_MIN + CARD_GAP))));
  const spread = (width: number) => (cols > 1 ? (inner - cols * width) / (cols - 1) : CARD_GAP);
  const card = Math.min(CARD_MAX, (inner - (cols - 1) * CARD_GAP) / cols);
  const gap = spread(card);
  if (gap <= GAP_MAX) return { cols, card, gap };
  return { cols, card: Math.min(CARD_WIDE, (inner - (cols - 1) * GAP_MAX) / cols), gap: GAP_MAX };
}

/**
 * 员工墙。
 *
 * 人数一屏装得下就是一片普通的卡片，从左上往右填、先填满第一排，没有箭头也没有渐隐带 ——
 * 只有三五位员工时还让人左右转是没有意义的。
 *
 * 装不下就成环：一列装 ROWS 位员工，整墙是一圈列，左右两个箭头都不会走到尽头，
 * 一直按下去会绕回开头。点一次箭头整条轨道横滑一列（不是原地换一批卡），
 * 滑完把当前列挪一格、位移归零 —— 因为轨道两侧各多挂了 SPARE 列，
 * 归零那一帧的画面和滑动终点是同一张，不会闪。
 *
 * 两侧各留一条 --ent-wall-fade 宽的窄带，里面正好露出相邻那一列的一条边。
 * 这条窄带落在 .ent-home 的左右内边距上（.ent-wall 用负 margin 顶出去），
 * 所以整张的卡片和上面的统计格左边缘对齐，被裁的卡露在内容区外侧 —— 设计稿就是这样。
 */
function Wall({ desks, usable, onOpen }: {
  desks: Desk[];
  usable: number;
  onOpen: (employeeId: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(() => fit(CARD_MAX * 4));
  /** 当前停在第几列。只有成环时才有意义。 */
  const [at, setAt] = useState(0);
  /** 正在往哪边滑：0 是停着。滑完由下面那个 effect 提交。 */
  const [slide, setSlide] = useState<0 | 1 | -1>(0);
  const reduced = usePrefersReducedMotion();

  // 一屏的可用宽度 = 整墙减掉两侧的渐隐窄带。窄带宽度写在 CSS 变量里，这里读回来算。
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => {
      const fade = parseFloat(getComputedStyle(node).getPropertyValue('--ent-wall-fade')) || 0;
      setBox(fit(node.clientWidth - fade * 2));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { cols, card, gap } = box;
  const { columns, looping } = useMemo(() => buildRing(desks, cols), [desks, cols]);

  const total = columns.length;
  // 窗口变窄之后列数变少，at 可能落在不存在的列上，绕回范围内。
  const wrap = (index: number) => (total ? ((index % total) + total) % total : 0);
  const here = wrap(at);

  // 滑动结束：把停留的列挪一格，位移归零。用定时器而不是 transitionend ——
  // 减少动效时根本没有过渡事件，标签页在后台时也可能收不到。
  useEffect(() => {
    if (!slide) return;
    const commit = () => { setAt(value => value + slide); setSlide(0); };
    if (reduced) { commit(); return; }
    const timer = window.setTimeout(commit, SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [slide, reduced]);

  /** 一次只滑一列：还在滑的时候连点会让位移和数据错位。 */
  const turn = (direction: 1 | -1) => { if (looping && !slide) setSlide(direction); };

  // 横向滚（触控板两指横扫、Shift+滚轮）也能拨动。竖向滚动照常传给页面，不抢。
  const drift = useRef(0);
  const onWheel = (event: WheelEvent) => {
    if (!looping || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    drift.current += event.deltaX;
    if (Math.abs(drift.current) < card / 2) return;
    turn(drift.current > 0 ? 1 : -1);
    drift.current = 0;
  };

  const style = {
    ['--ent-wall-cols' as string]: cols,
    ['--ent-desk-w' as string]: `${looping ? card : CARD_MAX}px`,
    ['--ent-wall-gap' as string]: `${looping ? gap : CARD_GAP}px`,
  };

  return (
    <div className={`ent-wall${looping ? ' turning' : ''}`} style={style}>
      {looping ? <span className="ent-wall-count">可用员工 {usable} 人</span> : null}

      {looping ? (
        <button type="button" className="ent-wall-arrow left" onClick={() => turn(-1)} aria-label="向右滑一列，看前面的员工">
          <ChevronLeft size={16} aria-hidden />
        </button>
      ) : null}

      <div className="ent-wall-frame" ref={frame} onWheel={onWheel}>
        {looping ? (
          <div
            className={`ent-wall-track${slide ? ' sliding' : ''}`}
            style={{ transform: slide ? `translateX(calc(${-slide} * (var(--ent-desk-w) + var(--ent-wall-gap))))` : undefined }}
          >
            {Array.from({ length: cols + SPARE * 2 }, (_, index) => {
              const slot = columns[wrap(here - SPARE + index)] ?? [];
              // 只有正中那 cols 列是真的露在内容区里的，其余在窄带里或干脆在画面外。
              const shown = index >= SPARE && index < SPARE + cols;
              return <Column key={`slot-${index}`} desks={slot} onOpen={onOpen} muted={!shown} />;
            })}
          </div>
        ) : (
          <div className="ent-wall-flat">
            {desks.map(desk => (
              <EmployeeDeskCard
                key={desk.employee.id}
                employee={desk.employee}
                load={desk.load}
                working={desk.working}
                flags={desk.flags}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>

      {looping ? (
        <button type="button" className="ent-wall-arrow right" onClick={() => turn(1)} aria-label="向左滑一列，看后面的员工">
          <ChevronRight size={16} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/**
 * inert 让窄带里和画面外那几列彻底退出交互：既不能点，也不会被 Tab 停到 ——
 * 只把它们 aria-hidden 掉，键盘用户还是会 Tab 进一张只露出三十几像素的卡里。
 * Electron 33 = Chrome 130，原生支持；React 18 的类型里还没有这个属性，所以要绕一下。
 */
const INERT = { inert: '' } as unknown as Record<string, string>;

/** 一列（上下两位员工）。窄带里和画面外的列只是画面的一部分，不参与点击和读屏。 */
function Column({ desks, onOpen, muted = false }: {
  desks: Desk[];
  onOpen: (employeeId: string) => void;
  muted?: boolean;
}) {
  return (
    <div className="ent-wall-col" {...(muted ? INERT : {})}>
      {desks.map(desk => (
        <EmployeeDeskCard
          key={desk.employee.id}
          employee={desk.employee}
          load={desk.load}
          working={desk.working}
          flags={desk.flags}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

/**
 * 把员工切成一圈列。
 *
 * 一屏装得下就不成环，直接把整份名单交给 .ent-wall-flat 从左上往右排 ——
 * 先填满第一排，第二排有几个就是几个，两排不用一样多。
 *
 * 装不下才成环。此时最后一列不够 ROWS 位就从头接上，让每一列都是满的 ——
 * 滑动时中间空一格比重复一张脸难看得多，而那张重复的脸只会出现在被裁掉的窄带里。
 */
function buildRing(desks: Desk[], cols: number): { columns: Desk[][]; looping: boolean } {
  if (desks.length <= Math.max(1, cols) * ROWS) return { columns: [], looping: false };

  const columns: Desk[][] = [];
  const total = Math.ceil(desks.length / ROWS);
  for (let index = 0; index < total; index += 1) {
    columns.push(Array.from({ length: ROWS }, (_, row) => desks[(index * ROWS + row) % desks.length]!));
  }
  return { columns, looping: true };
}


interface Desk {
  employee: SiliconEmployee;
  load: { done: number; total: number };
  working: boolean;
  /** 做完了等你查阅 / 等你拍板 / 中断了 —— 都只在状态旁边点一颗图标。 */
  flags: DeskFlag[];
}

function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * 一位员工今天的情形。
 *
 * 「工作中」的口径：他名下有一项工作正在跑。两个信号取并集 —— 平台报的状态，
 * 和本地真的有一项与他有关的工作在跑。只看平台会漏掉状态没跟上的人，
 * 只看当前负责人会漏掉在同一项流程里协作的人。和 useEnterpriseWorkspace 的
 * busyIds 是同一套口径，两处改要一起改。
 *
 * 「等你拍板」和「中断了」不算在里面：那两种工作已经不在推进了，他现在确实能接新活。
 *
 * 图标按「先说结果，再说卡住」排：做完了等你查阅 → 等你拍板 → 中断了。
 * 三件事同时有就点三颗，各自都有 title；具体是哪一项点开卡片看抽屉。
 */
function deskOf(
  employee: SiliconEmployee,
  works: WorkItem[],
  unreviewed: ReadonlySet<string>,
  dayStart: number,
): Desk {
  const mine = works.filter(work => involves(work, employee.id));
  const today = mine.filter(work => work.createdAt >= dayStart);
  const flags: DeskFlag[] = [];
  if (mine.some(work => unreviewed.has(work.id))) flags.push('done');
  if (mine.some(work => work.status === 'waiting-user')) flags.push('call');
  if (mine.some(work => work.status === 'failed')) flags.push('stop');

  return {
    employee,
    load: { done: today.filter(work => work.status === 'completed').length, total: today.length },
    working: employee.availability === 'working' || mine.some(work => work.status === 'running'),
    flags,
  };
}

/** 这项工作和这位员工有关：他是当前负责人、参与者，或者某一步派给了他。 */
function involves(work: WorkItem, employeeId: string): boolean {
  return work.currentEmployeeId === employeeId
    || work.participants.includes(employeeId)
    || work.steps.some(step => step.employeeId === employeeId);
}
