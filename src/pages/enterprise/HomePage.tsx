/**
 * 首页 = 双 tab：员工概览 + 组织架构。
 *
 * Phase 2 重构：
 * - 员工概览：只展示已订阅员工，单行水平自动滚动轮播
 * - 组织架构：复用 OrganizationPage 组件
 * - 移除底部派活框
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from '../../components/enterprise/atoms';
import { EmployeeDeskCard, type DeskFlag } from '../../components/enterprise/EmployeeDeskCard';
import { EmployeeWorksDrawer } from '../../components/enterprise/EmployeeWorksDrawer';
import { StatCard } from '../../components/enterprise/StatCard';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';
import { OrganizationPage } from './OrganizationPage';

type Tab = 'overview' | 'organization';

export function HomePage({ workspace }: { workspace: EnterpriseWorkspace }) {
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  return (
    <div className="ent-page ent-home">
      <div className="ent-home-tabs" role="tablist" aria-label="工作台视图切换">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'overview'}
          className={`ent-home-tab${activeTab === 'overview' ? ' active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          员工概览
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'organization'}
          className={`ent-home-tab${activeTab === 'organization' ? ' active' : ''}`}
          onClick={() => setActiveTab('organization')}
        >
          组织架构
        </button>
      </div>

      {activeTab === 'overview' ? (
        <EmployeeOverviewTab workspace={workspace} />
      ) : (
        <OrganizationPage
          workspace={{ employees: workspace.organizationEmployees, navigate: workspace.navigate }}
          members={workspace.organizationMembers}
          organizationStatus={workspace.organizationStatus}
          organizationError={workspace.organizationError}
          onRetry={workspace.retryOrganization}
        />
      )}
    </div>
  );
}

function EmployeeOverviewTab({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { overview, employees, works, unreviewedWorkIds, navigate } = workspace;

  // 只展示已分配给我的员工（已订阅）
  const subscribed = useMemo(() => employees.filter(item => item.assignedToMe), [employees]);
  const desks = useMemo(
    () => subscribed.map(employee => deskOf(employee, works, unreviewedWorkIds, startOfToday())),
    [subscribed, works, unreviewedWorkIds],
  );

  const [openId, setOpenId] = useState<string | null>(null);
  const openEmployee = openId ? subscribed.find(item => item.id === openId) : undefined;
  const openWorks = useMemo(
    () => (openEmployee
      ? works.filter(work => involves(work, openEmployee.id)).sort((left, right) => right.updatedAt - left.updatedAt)
      : []),
    [openEmployee, works],
  );

  const openWork = (workId: string) => { setOpenId(null); navigate({ name: 'work', workId }); };

  return (
    <div className="ent-home-content">
      <header className="ent-home-hero">
        <span className="ent-home-eyebrow">员工中心</span>
        <h1 className="ent-home-title">
          你的<em>硅基团队</em>
        </h1>
        <p className="ent-home-subtitle">
          {subscribed.length > 0
            ? `${subscribed.length} 位员工已订阅，随时待命`
            : '订阅员工后，他们会出现在这里'}
        </p>
      </header>

      <div className="stat-cards-row">
        <StatCard
          title="公司员工总数"
          value={overview.totalEmployees}
          icon="👥"
          color="primary"
          onClick={() => navigate({ name: 'employees', scope: 'all' })}
        />
        <StatCard
          title="已订阅员工"
          value={subscribed.length}
          icon="👤"
          color="accent"
          onClick={() => navigate({ name: 'employees', scope: 'mine' })}
        />
      </div>

      {subscribed.length ? (
        <AutoScrollCarousel desks={desks} onOpen={setOpenId} />
      ) : (
        <Empty title="还没有订阅硅基员工">前往「硅基员工」页面订阅你需要的员工。</Empty>
      )}

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
 * 自动滚动轮播 - 单行水平滚动，支持自动循环、悬停暂停、手动滚动
 */
function AutoScrollCarousel({ desks, onOpen }: {
  desks: Desk[];
  onOpen: (employeeId: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isManualScroll, setIsManualScroll] = useState(false);
  const scrollSpeed = 35; // px/秒
  const pauseAfterManual = 5000; // 手动滚动后暂停 5 秒

  // 自动滚动动画
  useEffect(() => {
    const node = container.current;
    if (!node || isPaused || isManualScroll) return;

    let animationId: number;
    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      const delta = currentTime - lastTime;
      lastTime = currentTime;

      // 滚动到末尾时无缝循环回开头
      if (node.scrollLeft >= node.scrollWidth - node.clientWidth) {
        node.scrollLeft = 0;
      } else {
        node.scrollLeft += (scrollSpeed * delta) / 1000;
      }

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, [isPaused, isManualScroll, scrollSpeed]);

  // 手动滚动后暂停 5 秒
  useEffect(() => {
    if (!isManualScroll) return;
    const timer = setTimeout(() => setIsManualScroll(false), pauseAfterManual);
    return () => clearTimeout(timer);
  }, [isManualScroll, pauseAfterManual]);

  const handleScroll = () => {
    setIsManualScroll(true);
  };

  return (
    <div
      className="ent-auto-carousel"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div
        ref={container}
        className="ent-auto-carousel-track"
        onScroll={handleScroll}
      >
        {/* 渲染两遍实现无缝循环 */}
        {[...desks, ...desks].map((desk, index) => (
          <div key={`${desk.employee.id}-${index}`} className="ent-auto-carousel-card">
            <EmployeeDeskCard
              employee={desk.employee}
              load={desk.load}
              working={desk.working}
              flags={desk.flags}
              onOpen={onOpen}
            />
          </div>
        ))}
      </div>
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
