/**
 * 员工详情。四个区块：员工介绍 / 能做什么 / 使用范围 / 员工技能。
 * 「使用范围」就是本机操作权限，由用户自己开启，开启时提醒。
 */

import { ArrowLeft, GitBranch, MessageSquareText, Send, SlidersHorizontal, XCircle } from 'lucide-react';
import { useState } from 'react';
import { PermissionPanel } from '../../components/enterprise/PermissionPanel';
import { AvailabilityChip, Empty, SkillStateChip } from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { EMPLOYEE_AVAILABILITY, relativeTime } from '../../features/enterprise/vocabulary';

export function EmployeeDetailPage({ workspace, employeeId }: { workspace: EnterpriseWorkspace; employeeId: string }) {
  const employee = workspace.employees.find(item => item.id === employeeId);
  const [draft, setDraft] = useState('');

  if (!employee) {
    return (
      <div className="ent-page">
        <Empty title="找不到这位员工">它可能已经被企业停用，或者不再分配给你。</Empty>
      </div>
    );
  }

  const skills = workspace.skills.filter(skill => employee.skillIds.includes(skill.id));
  const send = () => {
    if (!draft.trim()) return;
    void workspace.startConversation(employee.id, draft).then(() => setDraft(''));
  };

  return (
    <div className="ent-page">
      <button type="button" className="ent-back-link" onClick={() => workspace.navigate({ name: 'employees' })}>
        <ArrowLeft size={13} aria-hidden />
        全部员工
      </button>

      <header className="ent-detail-head ent-card pad">
        <EmployeeFace seed={employee.id} size="lg" />
        <div className="ent-detail-id">
          {/* 名字在顶栏（见 ClientAppPage），这张卡只补它的身份与状态。 */}
          <p>{employee.roleName} · 员工包 {employee.version}</p>
          <div className="ent-detail-chips">
            <AvailabilityChip value={employee.availability} />
            <span className="ent-tag">上次工作 {relativeTime(employee.lastWorkedAt)}</span>
            {employee.assignedToMe ? <span className="ent-tag">已分配给你</span> : <span className="ent-tag">企业其他成员在用</span>}
          </div>
        </div>
        <div className="ent-detail-actions">
          <button type="button" className="ent-btn primary" onClick={() => document.querySelector<HTMLTextAreaElement>('.ent-detail-composer textarea')?.focus()} disabled={!employee.assignedToMe}>
            <MessageSquareText size={14} aria-hidden />
            开始对话
          </button>
          <button type="button" className="ent-btn" onClick={() => workspace.navigate({ name: 'arrange', mode: 'chat', employeeId: employee.id })} disabled={!employee.assignedToMe}>
            <GitBranch size={14} aria-hidden />
            安排工作
          </button>
          <button type="button" className="ent-btn ghost" onClick={() => workspace.navigate({ name: 'skills' })}>
            <SlidersHorizontal size={14} aria-hidden />
            调整我的版本
          </button>
        </div>
      </header>

      {!employee.assignedToMe ? (
        <div className="ent-banner attention" style={{ marginTop: 14 }}>
          这位员工还没有分配给你，只能查看介绍。需要使用请联系企业管理员。
        </div>
      ) : null}

      <div className="ent-detail-grid">
        <section className="ent-card pad">
          <h2>员工介绍</h2>
          <p className="ent-prose">{employee.intro}</p>
          {employee.assignedToMe ? (
            <div className="ent-detail-composer">
              <textarea
                className="ent-textarea"
                value={draft}
                placeholder={`直接告诉 ${employee.name} 你想完成什么`}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(); }}
              />
              <button type="button" className="ent-btn primary" onClick={send} disabled={workspace.busy || !draft.trim()}>
                <Send size={14} aria-hidden />
                交给他开始
              </button>
            </div>
          ) : null}
        </section>

        <section className="ent-card pad">
          <h2>能做什么</h2>
          <ul className="ent-list good">
            {employee.goodAt.map(item => <li key={item}>{item}</li>)}
          </ul>
          <h3>不做这些</h3>
          <ul className="ent-list bad">
            {employee.cannotDo.map(item => <li key={item}><XCircle size={12} aria-hidden />{item}</li>)}
          </ul>
        </section>

        <section className="ent-card pad span-2">
          <h2>使用范围</h2>
          <p className="ent-hint">{EMPLOYEE_AVAILABILITY[employee.availability].hint}</p>
          <PermissionPanel
            employeeName={employee.name}
            permissions={employee.permissions}
            disabled={!employee.assignedToMe}
            onToggle={(permissionId, enabled) => workspace.setPermission(employee.id, permissionId, enabled)}
            onPickFolder={async permissionId => {
              const path = await workspace.chooseFolder();
              if (path) workspace.setPermissionScope(employee.id, permissionId, path);
            }}
          />
        </section>

        <section className="ent-card pad span-2">
          <div className="ent-section-head" style={{ margin: 0 }}>
            <div>
              <h2 style={{ margin: 0 }}>员工技能</h2>
              <p>技能决定它怎么做事。企业标准只读，你可以在个人版本里调整偏好。</p>
            </div>
            <button type="button" className="link" onClick={() => workspace.navigate({ name: 'skills' })}>管理我的版本</button>
          </div>
          {skills.length ? (
            <div className="ent-skill-row">
              {skills.map(skill => (
                <button key={skill.id} type="button" className="ent-skill-mini" onClick={() => workspace.navigate({ name: 'skills', skillId: skill.id })}>
                  <strong>{skill.name}</strong>
                  <small>{skill.description}</small>
                  <span>
                    <SkillStateChip value={skill.my.state} />
                    <em>企业版本 {skill.enterpriseVersion}</em>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Empty title="这位员工暂时没有可调整的技能">企业为它配置技能后会显示在这里。</Empty>
          )}
        </section>
      </div>
    </div>
  );
}


