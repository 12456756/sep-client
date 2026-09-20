/**
 * 首页 = 员工概览。按设计稿三段，自上而下：
 * 1. 两格统计：公司员工总数 / 我拥有的员工。刻意做小 —— 视觉重点是员工，不是数字。
 * 2. 员工卡片墙：最多两行，每行几张按容器宽度算；人多到一屏放不下就变成一个环，
 *    两侧箭头往左往右都能一直转，一次滑一列，两边各露出被裁掉的一列。
 * 3. 派活框：一句话派活，唯一的可选设置是工作场地。
 *
 * 页面上没有一句解释性长文案 —— 员工卡自己会说话（状态和几颗小图标），派活框自己带例子。
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from 'react';
import { Empty } from '../../components/enterprise/atoms';
import { ArrangeBar } from '../../components/enterprise/ArrangeBar';
import { EmployeeDeskCard, type DeskFlag } from '../../components/enterprise/EmployeeDeskCard';
import { EmployeeWorksDrawer } from '../../components/enterprise/EmployeeWorksDrawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { usePrefersReducedMotion } from '../../features/enterprise/use-reduced-motion';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';

export function HomePage({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { overview, employees, works, unreviewedWorkIds, navigate } = workspace;

  const roster = useMemo(() => employees.filter(item => item.assignedToMe), [employees]);
  const desks = useMemo(
    () => roster.map(employee => deskOf(employee, works, unreviewedWorkIds, startOfToday())),
    [roster, works, unreviewedWorkIds],
  );
  /** 现在就能派活的人数。墙上放不下时写在墙的右下角，让用户知道转一圈总共有多少人。 */
  const usable = useMemo(() => roster.filter(item => item.availability !== 'unavailable').length, [roster]);

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
      <div className="ent-figures">
        <Figure label="公司员工总数" value={overview.totalEmployees} onClick={() => navigate({ name: 'employees', scope: 'all' })}>
          <GroupGlyph />
        </Figure>
        <Figure label="我拥有的员工" value={roster.length} alt onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
          <PersonGlyph />
        </Figure>
      </div>

      {roster.length ? (
        <Wall desks={desks} usable={usable} onOpen={setOpenId} />
      ) : (
        <Empty title="企业还没有给你分配硅基员工">企业管理员分配之后，你的员工会出现在这里。</Empty>
      )}

      </div>

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

/*
 * 统计格的两个小图标手写成实心图形，没有用 lucide ——
 * 设计稿这两枚是填充的剪影，描边图标放在 36 见方的浅色片里明显轻一档，压不住旁边那个大数字。
 */

/** 两个人：公司员工总数。后面那位小一点、浅一点，靠深浅分出前后。 */
function GroupGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <g opacity=".45">
        <circle cx="16.5" cy="8.4" r="3.1" />
        <path d="M16.5 12.7c2.9 0 5.2 1.7 5.5 3.9.1.6-.4 1.1-1 1.1h-9c-.6 0-1.1-.5-1-1.1.3-2.2 2.6-3.9 5.5-3.9z" />
      </g>
      <circle cx="9.4" cy="7.6" r="3.8" />
      <path d="M9.4 12.6c3.7 0 6.7 2.1 7.1 4.8.1.8-.5 1.5-1.3 1.5H3.6c-.8 0-1.4-.7-1.3-1.5.4-2.7 3.4-4.8 7.1-4.8z" />
    </svg>
  );
}

/** 一个人：我拥有的员工。 */
function PersonGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <circle cx="12" cy="7.8" r="4" />
      <path d="M12 13.2c3.9 0 7.1 2.2 7.5 5.1.1.8-.5 1.5-1.3 1.5H5.8c-.8 0-1.4-.7-1.3-1.5.4-2.9 3.6-5.1 7.5-5.1z" />
    </svg>
  );
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
