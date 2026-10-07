/**
 * 首页重新设计 - 紧凑且信息丰富的硅基员工工作台
 */

import { ArrowRight, Users, Zap, Moon, Clock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmployeeWorksDrawer } from '../../components/enterprise/EmployeeWorksDrawer';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';
import type { DeskFlag } from '../../components/enterprise/EmployeeDeskCard';
import '../../styles/home-v2.css';

interface Desk {
  employee: SiliconEmployee;
  load: { done: number; total: number };
  working: boolean;
  flags: DeskFlag[];
}

export function HomePageRedesign({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { employees, works, unreviewedWorkIds, navigate } = workspace;

  const roster = useMemo(() => employees.filter(item => item.assignedToMe), [employees]);
  const desks = useMemo(
    () => roster.map(employee => deskOf(employee, works, new Set(unreviewedWorkIds), startOfToday())),
    [roster, works, unreviewedWorkIds],
  );

  // 按工作状态分组，调整显示数量
  const groupedDesks = useMemo(() => {
    const working = desks.filter(d => d.working).slice(0, 6); // 最多6个（2行×3列）
    const needsAttention = desks.filter(d => !d.working && d.flags.length > 0).slice(0, 4); // 最多4个
    const idle = desks.filter(d => !d.working && d.flags.length === 0).slice(0, 10); // 最多10个（2行×5列）
    return { working, idle, needsAttention };
  }, [desks]);

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
    <div className="ent-page ent-home-v2">
      {/* 顶部横幅 - 欢迎语和关键指标 */}
      <header className="home-banner">
        <div className="banner-left">
          <h1>👋 {workspace.userName}，下午好</h1>
          <p>你的硅基团队正在待命</p>
        </div>
        <div className="banner-stats">
          <div className="stat total">
            <div className="icon">
              <Users size={20} />
            </div>
            <div className="data">
              <span className="value">{roster.length}</span>
              <span className="label">总数</span>
            </div>
          </div>
          <div className="stat working">
            <div className="icon">
              <Zap size={20} />
            </div>
            <div className="data">
              <span className="value">{groupedDesks.working.length}</span>
              <span className="label">工作中</span>
            </div>
          </div>
          <div className="stat idle">
            <div className="icon">
              <Moon size={20} />
            </div>
            <div className="data">
              <span className="value">{groupedDesks.idle.length}</span>
              <span className="label">空闲</span>
            </div>
          </div>
        </div>
      </header>

      {/* 员工展示区域 */}
      <div className="home-workspace">
        {/* 工作中的员工 */}
        {groupedDesks.working.length > 0 && (
          <section className="employee-section">
            <div className="section-header">
              <h2>
                <span className="icon">⚡</span>
                工作中
                <span className="count">{groupedDesks.working.length}</span>
              </h2>
            </div>
            <div className="employee-grid working">
              {groupedDesks.working.map(desk => {
                const progress = desk.load.total > 0 ? Math.floor((desk.load.done / desk.load.total) * 100) : 0;
                const avatarUrl = desk.employee.avatarAsset?.portraitUrl || desk.employee.avatar || '';

                return (
                  <div
                    key={desk.employee.id}
                    className="employee-card working"
                    onClick={() => setOpenId(desk.employee.id)}
                  >
                    <div className="card-header">
                      <div className="avatar-container">
                        <img src={avatarUrl} alt={desk.employee.name} />
                        <span className="pulse-dot" />
                      </div>
                      <div className="employee-info">
                        <strong className="name">{desk.employee.name}</strong>
                        <span className="role">{desk.employee.roleName}</span>
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="status-row">
                        <span className="status-badge running">🔄 执行中</span>
                        <span className="progress-value">{progress}%</span>
                      </div>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${progress}%` }} />
                      </div>
                      <div className="meta-row">
                        <span className="meta">
                          {desk.load.done} / {desk.load.total} 步骤
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 需要关注的员工 */}
        {groupedDesks.needsAttention.length > 0 && (
          <section className="employee-section">
            <div className="section-header">
              <h2>
                <span className="icon">⚠️</span>
                需要关注
                <span className="count">{groupedDesks.needsAttention.length}</span>
              </h2>
            </div>
            <div className="employee-grid attention">
              {groupedDesks.needsAttention.map(desk => {
                const avatarUrl = desk.employee.avatarAsset?.portraitUrl || desk.employee.avatar || '';
                const flagText = desk.flags.map(flag => {
                  if (flag === 'done') return '需要查阅';
                  if (flag === 'call') return '等待拍板';
                  if (flag === 'stop') return '工作中断';
                  return flag;
                }).join(' · ');

                return (
                  <div
                    key={desk.employee.id}
                    className="employee-card attention"
                    onClick={() => setOpenId(desk.employee.id)}
                  >
                    <div className="card-header">
                      <div className="avatar-container">
                        <img src={avatarUrl} alt={desk.employee.name} />
                      </div>
                      <div className="employee-info">
                        <strong className="name">{desk.employee.name}</strong>
                        <span className="role">{desk.employee.roleName}</span>
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="status-row">
                        <span className="status-badge warning">⚠️ {flagText}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 空闲中的员工 */}
        {groupedDesks.idle.length > 0 && (
          <section className="employee-section">
            <div className="section-header">
              <h2>
                <span className="icon">💤</span>
                空闲中
                <span className="count">{groupedDesks.idle.length}</span>
              </h2>
              <button className="link-btn" onClick={() => navigate({ name: 'employees', scope: 'mine' })}>
                查看全部 <ArrowRight size={14} />
              </button>
            </div>
            <div className="employee-grid idle">
              {groupedDesks.idle.map(desk => {
                const avatarUrl = desk.employee.avatarAsset?.portraitUrl || desk.employee.avatar || '';
                const lastWorked = desk.employee.lastWorkedAt
                  ? formatLastWorked(desk.employee.lastWorkedAt)
                  : '从未工作';

                return (
                  <div
                    key={desk.employee.id}
                    className="employee-card idle"
                    onClick={() => setOpenId(desk.employee.id)}
                  >
                    <div className="avatar-container">
                      <img src={avatarUrl} alt={desk.employee.name} />
                    </div>
                    <div className="employee-info">
                      <strong className="name">{desk.employee.name}</strong>
                      <span className="role">{desk.employee.roleName}</span>
                      <span className="status-badge">💤 休息中</span>
                      <span className="last-worked">
                        <Clock size={11} />
                        {lastWorked}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 空状态 */}
        {desks.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">👥</div>
            <h3>还没有硅基员工</h3>
            <p>联系管理员为你分配团队成员</p>
          </div>
        )}
      </div>

      {/* 员工详情抽屉 */}
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function formatLastWorked(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return '今天工作过';
  if (days === 1) return '昨天工作过';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}月前`;
}

function involves(work: WorkItem, employeeId: string): boolean {
  return work.participants.includes(employeeId);
}

function deskOf(
  employee: SiliconEmployee,
  works: WorkItem[],
  unreviewedWorkIds: Set<string>,
  today: number,
): Desk {
  const myWorks = works.filter(work => involves(work, employee.id));
  const working = myWorks.some(work => work.status === 'running');
  const done = myWorks.filter(work => work.status === 'completed' && work.updatedAt >= today).length;
  const total = myWorks.filter(work => work.createdAt >= today).length;

  const flags: DeskFlag[] = [];
  if (myWorks.some(work => unreviewedWorkIds.has(work.id))) flags.push('done');
  if (myWorks.some(work => work.status === 'waiting-user')) flags.push('call');
  if (myWorks.some(work => work.status === 'failed' || work.status === 'paused')) flags.push('stop');

  return {
    employee,
    load: { done, total },
    working,
    flags,
  };
}
