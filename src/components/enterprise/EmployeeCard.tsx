/** Employee summary card shared by the employee page and home surfaces. */

import React from 'react';
import { MessageSquareText } from 'lucide-react';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { employeeChatDisabledReason } from '../../features/enterprise/employee-view-model';
import { relativeTime } from '../../features/enterprise/vocabulary';
import type { SkillLibraryItem } from '../../shared/skill-library';
import { AvailabilityChip } from './atoms';
import { EmployeeFace } from './EmployeeFace';
import { EmployeePortrait } from './EmployeePortrait';

interface Props {
  employee: SiliconEmployee;
  onOpen: (employeeId: string) => void;
  onChat?: (employeeId: string) => void;
  compact?: boolean;
  skills?: readonly SkillLibraryItem[];
  chatDisabledReason?: string | null;
}

function skillNames(skills: readonly SkillLibraryItem[] | undefined): string[] {
  return [...new Set((skills ?? []).map(skill => skill.capability.name.trim()).filter(Boolean))];
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
  const introduction = summary.replace(/[。.!！?？；;，,、\s]+$/u, '');
  const speech = introduction.startsWith('我') ? introduction : introduction ? `${/^(可以|能够|能|擅长|负责|专注)/u.test(introduction) ? '我' : '我可以'}${introduction}` : '';
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

  return <article className={`ent-emp-card ent-emp-person${employee.assignedToMe ? '' : ' off'}`}>
    {open}
    <div className="ent-emp-person-stage">
      {speech || names.length ? <div className="ent-emp-speech" aria-label="员工自我介绍"><p>
        {speech}{names.length ? <>{speech ? '，擅长' : '我擅长'}{names.map((name, index) => <React.Fragment key={name}>{index ? index === names.length - 1 ? '和' : '、' : ''}<strong>{name}</strong></React.Fragment>)}</> : null}。
      </p></div> : null}
      <span className="ent-emp-person-halo" aria-hidden />
      <EmployeePortrait employee={employee} />
      <span className="ent-emp-person-ground" aria-hidden />
    </div>
    <header><div className="ent-emp-card-id"><strong title={employee.name}>{employee.name}</strong></div></header>
    {recent ? <div className="ent-emp-person-recent">{recent}</div> : null}
    {reason ? <p id={disabledReasonId} className="ent-emp-disabled-reason">{reason}</p> : null}
    <footer>{chat}</footer>
  </article>;
}
