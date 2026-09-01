/**
 * 员工卡片。同时用在首页与「硅基员工」页。
 * 未分配给我的员工只显示「申请使用」，不提供开始对话或安排工作。
 */

import { MessageSquareText, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { relativeTime } from '../../features/enterprise/vocabulary';
import { AvailabilityChip, EmployeeAvatar } from './atoms';

interface Props {
  employee: SiliconEmployee;
  onOpen: (employeeId: string) => void;
  onChat?: (employeeId: string) => void;
  onArrange?: (employeeId: string) => void;
  /** 紧凑列表模式：一行一位员工，用于员工较多时快速浏览。 */
  compact?: boolean;
}

export function EmployeeCard({ employee, onOpen, onChat, onArrange, compact = false }: Props) {
  const enabled = employee.permissions.filter(item => item.enabled).length;

  if (compact) {
    return (
      <div className="ent-emp-row">
        <EmployeeAvatar mark={employee.mark} size="sm" dim={!employee.assignedToMe} />
        <button type="button" className="ent-emp-row-name" onClick={() => onOpen(employee.id)}>
          <strong>{employee.name}</strong>
          <small>{employee.roleName}{employee.department ? ` · ${employee.department}` : ''}</small>
        </button>
        <AvailabilityChip value={employee.availability} />
        <span className="ent-emp-row-time">{relativeTime(employee.lastWorkedAt)}</span>
        {employee.assignedToMe && onChat ? (
          <button type="button" className="ent-btn sm" onClick={() => onChat(employee.id)}>开始对话</button>
        ) : (
          <button type="button" className="ent-btn sm" disabled>申请使用</button>
        )}
      </div>
    );
  }

  return (
    <article className={`ent-card ent-emp-card${employee.assignedToMe ? '' : ' off'}`}>
      <header>
        <EmployeeAvatar mark={employee.mark} dim={!employee.assignedToMe} />
        <div className="ent-emp-card-id">
          <strong title={employee.name}>{employee.name}</strong>
          <small>{employee.roleName}{employee.department ? ` · ${employee.department}` : ''}</small>
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
        {employee.assignedToMe ? (
          <>
            <button type="button" className="ent-btn primary sm" onClick={() => onChat?.(employee.id)} disabled={!onChat || employee.availability === 'unavailable'}>
              <MessageSquareText size={13} aria-hidden />
              开始对话
            </button>
            <button type="button" className="ent-btn sm" onClick={() => onArrange?.(employee.id)} disabled={!onArrange || employee.availability === 'unavailable'}>
              <Workflow size={13} aria-hidden />
              安排工作
            </button>
            <button type="button" className="ent-btn ghost sm" onClick={() => onOpen(employee.id)}>查看技能</button>
          </>
        ) : (
          <>
            <button type="button" className="ent-btn sm" disabled title="这位员工尚未分配给你，请联系企业管理员">申请使用</button>
            <button type="button" className="ent-btn ghost sm" onClick={() => onOpen(employee.id)}>查看介绍</button>
          </>
        )}
      </footer>
    </article>
  );
}
