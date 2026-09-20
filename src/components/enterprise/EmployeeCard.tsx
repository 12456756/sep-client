/**
 * 员工卡片。同时用在首页与「硅基员工」页。
 * 仅保留开始对话和查看技能；未分配或不可用的员工禁用开始对话。
 */

import { MessageSquareText, ShieldCheck, Sparkles } from 'lucide-react';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { relativeTime } from '../../features/enterprise/vocabulary';
import { AvailabilityChip } from './atoms';
import { EmployeeFace } from './EmployeeFace';

interface Props {
  employee: SiliconEmployee;
  onOpen: (employeeId: string) => void;
  onChat?: (employeeId: string) => void;
  /** 紧凑列表模式：一行一位员工，用于员工较多时快速浏览。 */
  compact?: boolean;
}

export function EmployeeCard({ employee, onOpen, onChat, compact = false }: Props) {
  const enabled = employee.permissions.filter(item => item.enabled).length;

  if (compact) {
    return (
      <div className="ent-emp-row">
        <EmployeeFace seed={employee.id} size="sm" round />
        <button type="button" className="ent-emp-row-name" onClick={() => onOpen(employee.id)}>
          <strong>{employee.name}</strong>
        </button>
        <AvailabilityChip value={employee.availability} />
        <span className="ent-emp-row-time">{relativeTime(employee.lastWorkedAt)}</span>
        <button type="button" className="ent-btn sm" onClick={() => onChat?.(employee.id)} disabled={!employee.assignedToMe || !onChat || employee.availability === 'unavailable'}>开始对话</button>
        <button type="button" className="ent-btn ghost sm" onClick={() => onOpen(employee.id)}>查看技能</button>
      </div>
    );
  }

  return (
    <article className={`ent-card ent-emp-card${employee.assignedToMe ? '' : ' off'}`}>
      <header>
        <EmployeeFace seed={employee.id} size="md" />
        <div className="ent-emp-card-id">
          <strong title={employee.name}>{employee.name}</strong>
        </div>
        <AvailabilityChip value={employee.availability} />
      </header>
      <p className="ent-emp-card-intro">{employee.intro}</p>
      <div className="ent-emp-card-skills">
        <Sparkles size={12} aria-hidden />
        {employee.goodAt.slice(0, 2).map(item => <span key={item} className="ent-tag">{item}</span>)}
        {employee.goodAt.length > 2 ? <span className="ent-tag">+{employee.goodAt.length - 2}</span> : null}
      </div>
      <div className="ent-emp-card-meta">
        <span title="你已开启的本机操作权限数量">
          <ShieldCheck size={12} aria-hidden />
          已授权 {enabled} / {employee.permissions.length} 项操作
        </span>
        <span>上次工作 {relativeTime(employee.lastWorkedAt)}</span>
      </div>
      <footer>
        <button type="button" className="ent-btn primary sm" onClick={() => onChat?.(employee.id)} disabled={!employee.assignedToMe || !onChat || employee.availability === 'unavailable'}>
          <MessageSquareText size={13} aria-hidden />
          开始对话
        </button>
        <button type="button" className="ent-btn ghost sm" onClick={() => onOpen(employee.id)}>查看技能</button>
      </footer>
    </article>
  );
}
