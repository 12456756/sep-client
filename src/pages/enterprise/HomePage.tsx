/**
 * 个人工作台：一个视口内呈现待处理、进行中和已订阅员工的可执行摘要。
 * 首页用横向员工墙承载完整订阅列表，员工数量较多时通过轨道滑动查看，不让整页被数据撑长。
 */

import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Sparkles, UserRound, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { defaultRunSettings, type RunSettings } from '../../features/enterprise/run-settings';
import { EmployeeDeskCard, type DeskFlag } from '../../components/enterprise/EmployeeDeskCard';
import { ChatArrange } from '../../components/enterprise/arrange/ChatArrange';
import { EmployeeWorksDrawer } from '../../components/enterprise/EmployeeWorksDrawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';


export function HomePage({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { employees, works, unreviewedWorkIds, navigate } = workspace;

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
  const availableModels = useMemo(() => Array.from(new Set(roster.flatMap(item => item.allowedModels))), [roster]);

  const employeeTrackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScrollLeft: 0, moved: false });
  const suppressClickRef = useRef(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [draggingEmployees, setDraggingEmployees] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [chatEmployeeId, setChatEmployeeId] = useState('');
  const [chatSettings, setChatSettings] = useState<RunSettings>(defaultRunSettings);

  const updateEmployeeScrollState = useCallback(() => {
    const track = employeeTrackRef.current;
    if (!track) return;
    const maxScrollLeft = Math.max(0, track.scrollWidth - track.clientWidth);
    setCanScrollLeft(track.scrollLeft > 2);
    setCanScrollRight(track.scrollLeft < maxScrollLeft - 2);
  }, []);

  useEffect(() => {
    const track = employeeTrackRef.current;
    if (!track) return;
    updateEmployeeScrollState();
    track.addEventListener('scroll', updateEmployeeScrollState, { passive: true });
    window.addEventListener('resize', updateEmployeeScrollState);
    return () => {
      track.removeEventListener('scroll', updateEmployeeScrollState);
      window.removeEventListener('resize', updateEmployeeScrollState);
    };
  }, [desks.length, updateEmployeeScrollState]);

  const scrollEmployees = (direction: -1 | 1) => {
    const track = employeeTrackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * Math.max(track.clientWidth * 0.84, 260), behavior: 'smooth' });
  };

  const handleEmployeePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const track = employeeTrackRef.current;
    if (!track) return;
    dragRef.current = { active: true, startX: event.clientX, startScrollLeft: track.scrollLeft, moved: false };
    track.setPointerCapture(event.pointerId);
  };

  const handleEmployeePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const track = employeeTrackRef.current;
    if (!drag.active || !track) return;
    const delta = event.clientX - drag.startX;
    if (Math.abs(delta) > 6) {
      drag.moved = true;
      setDraggingEmployees(true);
    }
    if (drag.moved) track.scrollLeft = drag.startScrollLeft - delta;
  };

  const finishEmployeePointer = (event: PointerEvent<HTMLDivElement>) => {
    const track = employeeTrackRef.current;
    if (track?.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    if (dragRef.current.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    dragRef.current.active = false;
    dragRef.current.moved = false;
    setDraggingEmployees(false);
  };

  const handleEmployeeClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };
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
          <div className="ent-home-welcome">
            <span className="ent-home-eyebrow">个人工作台</span>
            <h1>欢迎回来，{workspace.userName} <span aria-hidden>👋</span></h1>
            <p>你的硅基员工正在高效工作中</p>
          </div>
        </header>

        <section className="ent-home-summary" aria-label="员工概览">
          <button type="button" onClick={() => navigate({ name: 'employees', scope: 'all' })}>
            <span className="ent-home-summary-icon employees" aria-hidden><UsersRound size={18} /></span>
            <span className="ent-home-summary-copy"><strong>{workspace.overview.totalEmployees}</strong><span>公司员工总数</span></span>
            <ArrowRight size={14} aria-hidden />
          </button>
          <button type="button" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
            <span className="ent-home-summary-icon mine" aria-hidden><UserRound size={18} /></span>
            <span className="ent-home-summary-copy"><strong>{roster.length}</strong><span>我拥有的员工</span></span>
            <ArrowRight size={14} aria-hidden />
          </button>
        </section>

        <div className="ent-home-main">
          {needsMe.length ? (
            <section className="ent-home-attention" aria-label={`需要关注，共 ${needsMe.length} 项`}>
              <div className="ent-home-attention-copy">
                <span className="ent-home-panel-kicker">需要关注</span>
                <strong>待我处理 {needsMe.length} 项</strong>
              </div>
              <button type="button" className="link" onClick={() => navigate({ name: 'records', bucket: 'mine' })}>
                查看工作记录 <ArrowRight size={14} aria-hidden />
              </button>
            </section>
          ) : null}

          <section className="ent-home-employees" aria-labelledby="ent-home-employees-title">
            <div className="ent-home-employees-heading">
              <div className="ent-home-employees-title">
                <Sparkles size={16} aria-hidden />
                <h2 id="ent-home-employees-title">我的硅基员工</h2>
                <span>{roster.length}</span>
              </div>
              <button type="button" className="link" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
                查看全部 <ArrowRight size={14} aria-hidden />
              </button>
            </div>
            {desks.length ? (
              <div className={`ent-home-employee-carousel${draggingEmployees ? ' is-dragging' : ''}`}>
                <button
                  type="button"
                  className="ent-home-carousel-arrow left"
                  onClick={() => scrollEmployees(-1)}
                  disabled={!canScrollLeft}
                  aria-label="查看上一组员工"
                >
                  <ChevronLeft size={17} aria-hidden />
                </button>
                <div className="ent-home-employee-viewport">
                  <div
                    className="ent-home-employee-row"
                    ref={employeeTrackRef}
                    onPointerDown={handleEmployeePointerDown}
                    onPointerMove={handleEmployeePointerMove}
                    onPointerUp={finishEmployeePointer}
                    onPointerCancel={finishEmployeePointer}
                    onClickCapture={handleEmployeeClickCapture}
                  >
                    {desks.map(desk => (
                      <div className="ent-home-employee-slide" key={desk.employee.id}>
                        <EmployeeDeskCard
                          employee={desk.employee}
                          load={desk.load}
                          working={desk.working}
                          flags={desk.flags}
                          onOpen={setOpenId}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="ent-home-carousel-arrow right"
                  onClick={() => scrollEmployees(1)}
                  disabled={!canScrollRight}
                  aria-label="查看下一组员工"
                >
                  <ChevronRight size={17} aria-hidden />
                </button>
              </div>
            ) : (
              <div className="ent-home-roster-empty">
                <CheckCircle2 size={16} aria-hidden />
                <span>企业还没有给你分配硅基员工</span>
              </div>
            )}
          </section>
        </div>
      </div>

      <section className="ent-home-composer" aria-label="开始会话">
        <ChatArrange
          employees={roster}
          busy={workspace.busy}
          employeeId={chatEmployeeId}
          onEmployeeChange={setChatEmployeeId}
          onStart={(employeeId, text) => {
            void workspace.startConversation(employeeId, text, {
              workDir: chatSettings.workDir,
              modelId: chatSettings.modelId,
              permissions: chatSettings.permissions,
            });
          }}
          settings={chatSettings}
          models={availableModels}
          onSettingsChange={patch => setChatSettings(current => ({ ...current, ...patch }))}
          onChooseFolder={workspace.chooseFolder}
        />
      </section>

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
