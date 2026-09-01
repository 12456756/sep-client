/**
 * 展示层小零件。状态一律「颜色 + 图标 + 文字」同时表达，不依赖单一颜色。
 */

import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EmployeeAvailability, MySkillState, WorkStatus, WorkStepState } from '../../features/enterprise/types';
import { EMPLOYEE_AVAILABILITY, MY_SKILL_STATE, WORK_STATUS, WORK_STEP_STATE } from '../../features/enterprise/vocabulary';

type Tone = 'ready' | 'busy' | 'attention' | 'danger' | 'muted';

const TONE_ICON: Record<Tone, typeof CheckCircle2> = {
  ready: CheckCircle2,
  busy: Loader2,
  attention: AlertTriangle,
  danger: XCircle,
  muted: CircleDashed,
};

export function StatusChip({ tone, label, hint }: { tone: Tone; label: string; hint?: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`ent-chip ${tone}`} title={hint} aria-label={hint ? `${label}：${hint}` : label}>
      <Icon size={12} className={tone === 'busy' ? 'spin' : undefined} aria-hidden />
      {label}
    </span>
  );
}

export const AvailabilityChip = ({ value }: { value: EmployeeAvailability }) => <StatusChip {...EMPLOYEE_AVAILABILITY[value]} />;
export const WorkStatusChip = ({ value }: { value: WorkStatus }) => <StatusChip {...WORK_STATUS[value]} />;
export const StepStateChip = ({ value }: { value: WorkStepState }) => <StatusChip {...WORK_STEP_STATE[value]} />;
export const SkillStateChip = ({ value }: { value: MySkillState }) => <StatusChip {...MY_SKILL_STATE[value]} />;

/** 员工头像。没有图片时用姓名首字，未分配给我的员工用灰底表示不可操作。 */
export function EmployeeAvatar({ mark, size = 'md', dim = false }: { mark: string; size?: 'sm' | 'md' | 'lg'; dim?: boolean }) {
  return <span className={`ent-avatar ${size}${dim ? ' off' : ''}`} aria-hidden>{mark || '员'}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="ent-empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
