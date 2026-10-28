/** Employee summary card shared by the employee page and home surfaces. */

import React from 'react';
import { MessageSquareText } from 'lucide-react';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { employeeChatDisabledReason } from '../../features/enterprise/employee-view-model';
import { relativeTime } from '../../features/enterprise/vocabulary';
import type { SkillLibraryItem } from '../../shared/skill-library';
import { AvailabilityChip } from './atoms';
import { EmployeeFace } from './EmployeeFace';

interface Props {
  employee: SiliconEmployee;
  onOpen: (employeeId: string) => void;
  onChat?: (employeeId: string) => void;
  compact?: boolean;
  skills?: readonly SkillLibraryItem[];
  chatDisabledReason?: string | null;
}

function skillNames(skills: readonly SkillLibraryItem[] | undefined): string[] {
  return [...new Set((skills ?? []).map(skill => skill.capability.name).filter(Boolean))];
}

export function EmployeeCard({ employee, onOpen, onChat, compact = false, skills, chatDisabledReason }: Props): React.JSX.Element {
  const names = skillNames(skills);
  const reason = employeeChatDisabledReason(employee) ?? chatDisabledReason ?? (!onChat ? '当前无法开始对话' : null);
  const disabled = Boolean(reason);
  const disabledReasonId = `employee-chat-disabled-${employee.id}`;
  const detailsId = `employee-detail-${employee.id}`;
  const open = <button id={detailsId} type="button" className="ent-emp-open" aria-haspopup="dialog" aria-label={`查看${employee.name}详情`} onClick={() => onOpen(employee.id)} />;
  const chat = <button type="button" className={`ent-btn primary sm ent-emp-chat${compact ? ' ent-emp-row-chat' : ''}`} onClick={event => { event.stopPropagation(); onChat?.(employee.id); }} disabled={disabled} title={reason ?? undefined} aria-describedby={reason ? disabledReasonId : undefined}>
    <MessageSquareText size={13} aria-hidden />开始对话
  </button>;
  const summary = employee.intro.trim();
  const skillSummary = names.length ? <div className="ent-emp-card-skills" aria-label="员工技能">{names.slice(0, 2).map(name => <span key={name} className="ent-tag">{name}</span>)}{names.length > 2 ? <span className="ent-tag">+{names.length - 2}</span> : null}</div> : null;
  const recent = employee.lastWorkedAt ? <span className="ent-emp-card-recent">最近使用：{relativeTime(employee.lastWorkedAt)}</span> : null;

  if (compact) {
    return <div className={`ent-emp-row${employee.assignedToMe ? '' : ' off'}`}>
      {open}
      <EmployeeFace employee={employee} size="sm" round />
      <div className="ent-emp-row-name"><strong>{employee.name}</strong>{summary ? <small>{summary}</small> : null}{names.length ? <small>{names.slice(0, 2).join('、')}{names.length > 2 ? ` +${names.length - 2}` : ''}</small> : null}{reason ? <small id={disabledReasonId} className="ent-emp-disabled-reason">{reason}</small> : null}</div>
      <AvailabilityChip value={employee.availability} />
      {recent}
      {chat}
    </div>;
  }

  return <article className={`ent-card ent-emp-card${employee.assignedToMe ? '' : ' off'}`}>
    {open}
    <header><EmployeeFace employee={employee} size="md" /><div className="ent-emp-card-id"><strong title={employee.name}>{employee.name}</strong></div><AvailabilityChip value={employee.availability} /></header>
    {summary ? <p className="ent-emp-card-intro">{summary}</p> : null}
    {skillSummary}
    {recent}
    {reason ? <p id={disabledReasonId} className="ent-emp-disabled-reason">{reason}</p> : null}
    <footer>{chat}</footer>
  </article>;
}
