import * as React from 'react';
import { ChevronRight, MessageSquareText, RefreshCw } from 'lucide-react';
import { AvailabilityChip, Empty, WorkStatusChip } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { employeeChatDisabledReason, employeeSkills, mergeEmployeeDirectory, recentEmployeeWorks } from '../../features/enterprise/employee-view-model';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeLoadState } from '../../features/enterprise/use-workspace-employees';
import { relativeTime } from '../../features/enterprise/vocabulary';

interface Props {
  workspace: EnterpriseWorkspace;
  employeeId: string;
  employeeLoad?: EmployeeLoadState;
  employeeStatusLoad?: EmployeeLoadState;
}

export function EmployeeDetailPage({ workspace, employeeId, employeeLoad, employeeStatusLoad }: Props): React.JSX.Element {
  const employees = mergeEmployeeDirectory(workspace.employees, workspace.organizationEmployees);
  const employee = employees.find(item => item.id === employeeId);
  const organizationPending = workspace.organizationStatus === 'loading';
  const employeePending = Boolean(employeeLoad?.loading);
  const employeeError = employeeLoad?.error;

  if (!employee && (organizationPending || employeePending)) {
    return <div className="ent-employee-detail"><div className="ent-employee-detail-loading" role="status">正在加载员工信息…</div></div>;
  }

  const directoryError = employeeError || workspace.organizationError;
  if (!employee && directoryError) {
    return <div className="ent-employee-detail">
      <div className="ent-employee-detail-state" role="alert"><span>{directoryError}</span><button type="button" className="ent-btn" onClick={() => { employeeLoad?.retry(); workspace.retryOrganization(); }}><RefreshCw size={14} aria-hidden />重试</button></div>
    </div>;
  }

  if (!employee) {
    return (
      <div className="ent-employee-detail">
        <Empty title="找不到这位员工">员工可能已停用或不再对当前账号开放。</Empty>
      </div>
    );
  }

  const disabledReason = employeeChatDisabledReason(employee)
    ?? (employeeLoad?.loading || employeeLoad?.error ? '员工分配信息正在确认或暂不可用' : null)
    ?? (employeeStatusLoad?.loading || employeeStatusLoad?.error ? '员工状态正在确认或暂不可用' : null);
  const skills = employeeSkills(workspace.skills, employee.id);
  const works = recentEmployeeWorks(workspace.works, employee.id);
  const organizationOnly = !workspace.employees.some(item => item.id === employee.id);
  const skillsUnavailable = organizationOnly && !workspace.skillsLoading && !workspace.skillsError && !workspace.skillsWarning && skills.length === 0;
  const skillsConfirmedEmpty = !workspace.skillsLoading && !workspace.skillsError && !workspace.skillsWarning && skills.length === 0 && !skillsUnavailable;
  const workLoading = workspace.workListLoad.loading;
  const workError = workspace.workListLoad.error;

  return (
    <div className="ent-employee-detail">
      {workspace.organizationError ? <div className="ent-employee-detail-state" role="alert"><span>{workspace.organizationError}，已保留当前员工信息。</span><button type="button" className="ent-btn sm" onClick={workspace.retryOrganization}>重试企业目录</button></div> : null}
      {employeeLoad?.error ? <div className="ent-employee-detail-state" role="alert"><span>{employeeLoad.error}</span><button type="button" className="ent-btn sm" onClick={employeeLoad.retry}>重试分配信息</button></div> : null}
      {employeeStatusLoad?.error ? <div className="ent-employee-detail-state" role="alert"><span>员工状态暂未更新，确认完成前无法开始新对话。</span><button type="button" className="ent-btn sm" onClick={employeeStatusLoad.retry}>重试员工状态</button></div> : null}
      <header className="ent-employee-profile">
        <EmployeeFace employee={employee} size="lg" variant="portrait" />
        <div className="ent-employee-profile-copy">
          <h1>{employee.name}</h1>
          <div className="ent-employee-profile-status">
            <AvailabilityChip value={employee.availability} />
            {!employee.assignedToMe ? <span>尚未分配给你</span> : null}
            {employeeStatusLoad?.loading ? <span role="status">状态更新中</span> : null}
            {employeeStatusLoad?.error ? <span className="ent-employee-inline-error" role="status">状态暂未更新</span> : null}
          </div>
          {employee.intro.trim() ? <p>{employee.intro}</p> : null}
          {!employee.assignedToMe ? <p className="ent-employee-availability-note">需要使用请联系企业管理员。</p> : null}
        </div>
        <div className="ent-employee-profile-action">
          <button
            type="button"
            className="ent-btn primary"
            onClick={() => workspace.navigate({ name: 'arrange', mode: 'chat', employeeId: employee.id })}
            disabled={Boolean(disabledReason)}
            title={disabledReason ?? undefined}
          >
            <MessageSquareText size={15} aria-hidden />开始对话
          </button>
          {disabledReason ? <span>{disabledReason}</span> : null}
        </div>
      </header>

      <section className="ent-employee-detail-section" aria-labelledby="employee-skills-heading">
        <div className="ent-employee-detail-section-heading">
          <h2 id="employee-skills-heading">已有技能</h2>
          {skills.length ? <button type="button" className="ent-employee-inline-link" onClick={() => workspace.navigate({ name: 'skills', employeeFilterId: employee.id })}>查看全部技能</button> : null}
          {workspace.skillsLoading ? <span role="status">正在加载技能…</span> : null}
        </div>
        {workspace.skillsError ? (
          <div className="ent-employee-detail-state" role="alert">
            <span>{workspace.skillsError}。{skills.length ? '已保留当前可用技能。' : '当前无法确认技能配置。'}</span>
            <button type="button" className="ent-btn sm" disabled={workspace.skillsLoading || (workspace.skillsRetrySeconds !== null && workspace.skillsRetrySeconds > 0)} onClick={() => void workspace.refreshSkills()}>
              <RefreshCw size={13} aria-hidden />{workspace.skillsRetrySeconds && workspace.skillsRetrySeconds > 0 ? `${workspace.skillsRetrySeconds} 秒后重试` : '重试'}
            </button>
          </div>
        ) : null}
        {workspace.skillsWarning ? <p className="ent-employee-detail-muted" role="status">{workspace.skillsWarning}，当前无法确认完整技能配置。</p> : null}
        {skillsUnavailable ? <p className="ent-employee-detail-muted">当前账号暂无可查看的技能信息。</p> : null}
        {skillsConfirmedEmpty ? <p className="ent-employee-detail-muted">这位员工暂未配置可查看的技能。</p> : null}
        {skills.length ? (
          <ul className="ent-employee-skill-list">
            {skills.map(skill => (
              <li key={skill.capability.id}>
                <div className="ent-employee-skill-copy">
                  <strong>{skill.capability.name}</strong>
                  {skill.capability.description.trim() ? <p>{skill.capability.description}</p> : null}
                </div>
                <button type="button" id={`employee-skill-${skill.capability.id}`} className="ent-employee-inline-link" onClick={() => workspace.navigate({ name: 'skills', skillId: skill.capability.id, sourceEmployeeId: employee.id, returnTo: { name: 'employee', employeeId: employee.id } })}>
                  查看技能<ChevronRight size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {workLoading || workError || works.length ? (
        <section className="ent-employee-detail-section" aria-labelledby="employee-work-heading">
          <div className="ent-employee-detail-section-heading"><h2 id="employee-work-heading">最近工作</h2></div>
          {workLoading ? <p className="ent-employee-detail-muted" role="status">正在加载最近工作…</p> : null}
          {workError ? <div className="ent-employee-detail-state" role="alert"><span>{workError}{works.length ? '，已保留最近的工作记录。' : ''}</span><button type="button" className="ent-btn sm" onClick={workspace.workListLoad.retry}><RefreshCw size={13} aria-hidden />重试</button></div> : null}
          <ul className="ent-employee-work-list">
            {works.map(work => (
              <li key={work.id}>
                <button type="button" className="ent-employee-work-link" onClick={() => workspace.navigate({ name: 'work', workId: work.id })}>
                  <strong>{work.title || work.goal}</strong>
                  <WorkStatusChip value={work.status} />
                  <time dateTime={new Date(work.updatedAt).toISOString()}>{relativeTime(work.updatedAt)}</time>
                  <ChevronRight size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
