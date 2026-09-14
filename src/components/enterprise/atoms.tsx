/**
 * 展示层小零件。
 *
 * 状态标签按设计稿是一颗很小的药丸，只有浅底色和文字 —— 20 高的药丸里再塞图标
 * 会把字挤没，而「空闲 / 工作中 / 已完成」这几个字本身就不依赖颜色表达状态，
 * 所以颜色只是加强，不是唯一信息载体。hint 走 title，读屏也念得到。
 */

import type { ReactNode } from 'react';
import type { EmployeeAvailability, MySkillState, WorkStatus, WorkStepState } from '../../features/enterprise/types';
import { EMPLOYEE_AVAILABILITY, MY_SKILL_STATE, WORK_STATUS, WORK_STEP_STATE } from '../../features/enterprise/vocabulary';

/**
 * 语义色档位。设计稿里「工作中」和「正在进行」用的是同一支主色浅底，
 * 所以员工在干活和工作在跑共用 busy 这一档，不另分一支颜色。
 */
type Tone = 'ready' | 'busy' | 'attention' | 'danger' | 'muted';

export function StatusChip({ tone, label, hint }: { tone: Tone; label: string; hint?: string }) {
  return (
    <span className={`ent-chip ${tone}`} title={hint} aria-label={hint ? `${label}：${hint}` : label}>
      {label}
    </span>
  );
}

export const AvailabilityChip = ({ value }: { value: EmployeeAvailability }) => <StatusChip {...EMPLOYEE_AVAILABILITY[value]} />;
export const WorkStatusChip = ({ value }: { value: WorkStatus }) => <StatusChip {...WORK_STATUS[value]} />;
export const StepStateChip = ({ value }: { value: WorkStepState }) => <StatusChip {...WORK_STEP_STATE[value]} />;
export const SkillStateChip = ({ value }: { value: MySkillState }) => <StatusChip {...MY_SKILL_STATE[value]} />;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="ent-empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}


