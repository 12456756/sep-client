/**
 * 个人工作台：一个视口内呈现待处理、进行中和已订阅员工的可执行摘要。
 * 首页只展示有限预览，完整列表通过“查看全部”进入，避免数据量把首页撑成滚动页。
 */

import { ArrowRight, CheckCircle2, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmployeeDeskCard, type DeskFlag } from '../../components/enterprise/EmployeeDeskCard';
import { EmployeeWorksDrawer } from '../../components/enterprise/EmployeeWorksDrawer';
import { createHomePreview } from '../../features/enterprise/home-preview';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';

const EMPLOYEE_PREVIEW_LIMIT = 8;

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
  const activeWorks = useMemo(
    () => works
      .filter(work => work.status === 'running' || work.status === 'arranging')
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [works],
  );
  const employeePreview = createHomePreview(desks, EMPLOYEE_PREVIEW_LIMIT);

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
          <button type="button" className="ent-btn primary lg" onClick={() => navigate({ name: 'arrange' })}>
            <Plus size={16} aria-hidden />
            安排工作
          </button>
        </header>

        <section className="ent-home-summary" aria-label="工作概览">
          <button type="button" onClick={() => navigate({ name: 'records', bucket: 'mine' })}>
            <strong>{needsMe.length}</strong><span>待我处理</span><ArrowRight size={14} aria-hidden />
          </button>
          <button type="button" onClick={() => navigate({ name: 'records', bucket: 'active' })}>
            <strong>{activeWorks.length}</strong><span>进行中</span><ArrowRight size={14} aria-hidden />
          </button>
          <button type="button" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
            <strong>{roster.length}</strong><span>已订阅员工</span><ArrowRight size={14} aria-hidden />
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
                <h2 id="ent-home-employees-title">我的硅基员工</h2>
                <span>{roster.length}</span>
                {employeePreview.remaining > 0 ? <small>另有 {employeePreview.remaining} 位</small> : null}
              </div>
              <button type="button" className="link" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
                查看全部 <ArrowRight size={14} aria-hidden />
              </button>
            </div>
            {employeePreview.items.length ? (
              <div className="ent-home-employee-row">
                {employeePreview.items.map(desk => (
                  <EmployeeDeskCard
                    key={desk.employee.id}
                    employee={desk.employee}
                    load={desk.load}
                    working={desk.working}
                    flags={desk.flags}
                    onOpen={setOpenId}
                  />
                ))}
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
