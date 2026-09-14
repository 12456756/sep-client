/**
 * 术语与状态表达的唯一来源。
 *
 * 界面上不出现 Agent、节点、DAG、Session、编排 这类技术词。
 * 任何新页面需要文案时都从这里取，避免同一状态在不同页面写法不一致。
 */

import type { EmployeeAvailability, MySkillState, WorkStatus, WorkStepState } from './types';

/** 技术表达 → 前端表达。仅供开发查阅与代码评审，不在界面渲染。 */
export const TERM_MAP: Record<string, string> = {
  '自动编排': '安排工作',
  Agent: '硅基员工',
  智能体: '硅基员工',
  任务: '工作',
  节点: '工作步骤',
  执行记录: '工作记录',
  技能包: '员工技能',
  编辑技能: '调整员工能力',
};

// ────────────────────────────── 员工状态 ──────────────────────────────

interface StatusPresentation {
  label: string;
  /** 语义色档位，对应 enterprise.css 里的 .ent-chip.*。 */
  tone: 'ready' | 'busy' | 'attention' | 'danger' | 'muted';
  /** 一句话解释，用于 title 与无障碍说明。 */
  hint: string;
}

export const EMPLOYEE_AVAILABILITY: Record<EmployeeAvailability, StatusPresentation> = {
  ready: { label: '空闲', tone: 'ready', hint: '现在就能接受新的工作安排' },
  // 「工作中」和工作的「正在进行」共用主色浅底（设计稿如此），不另分一支颜色。
  working: { label: '工作中', tone: 'busy', hint: '正在处理其他工作，可以排队' },
  'needs-auth': { label: '需要授权', tone: 'attention', hint: '需要你开启本机操作权限后才能开始' },
  unavailable: { label: '暂时不可用', tone: 'muted', hint: '企业暂停了这位员工，或授权已到期' },
};

// ────────────────────────────── 工作状态 ──────────────────────────────

export const WORK_STATUS: Record<WorkStatus, StatusPresentation> = {
  arranging: { label: '安排中', tone: 'muted', hint: '还没开始，可继续修改安排' },
  running: { label: '正在进行', tone: 'busy', hint: '员工正在处理' },
  'waiting-user': { label: '等待你确认', tone: 'attention', hint: '需要你确认后才能继续' },
  completed: { label: '已完成', tone: 'ready', hint: '结果已交付，可查看或复制为新工作' },
  failed: { label: '需要重试', tone: 'danger', hint: '执行中断，可重试或换其他员工' },
  // 「已终止」而不是「已暂停」：终止之后不会自己接着跑，要用「重新执行」从头开一遍。
  // 说「暂停」会让人等它自己醒过来。这一行的用词和终止按钮、工作过程里那条记录一致。
  paused: { label: '已终止', tone: 'muted', hint: '你终止了这项工作，已完成部分被保留' },
};

export const WORK_STEP_STATE: Record<WorkStepState, StatusPresentation> = {
  pending: { label: '等待开始', tone: 'muted', hint: '前面的步骤完成后自动开始' },
  running: { label: '正在处理', tone: 'busy', hint: '员工正在完成这一步' },
  'waiting-user': { label: '等待你确认', tone: 'attention', hint: '这一步的结果需要你确认' },
  done: { label: '已完成', tone: 'ready', hint: '这一步已产出结果' },
  failed: { label: '未完成', tone: 'danger', hint: '这一步中断了' },
  skipped: { label: '已跳过', tone: 'muted', hint: '这一步被跳过' },
};

// ──────────────────────────── 个人技能版本 ────────────────────────────

export const MY_SKILL_STATE: Record<MySkillState, StatusPresentation> = {
  none: { label: '企业标准', tone: 'muted', hint: '你还没有创建个人版本' },
  draft: { label: '我的修改', tone: 'busy', hint: '个人版本已保存，尚未提交企业' },
  submitted: { label: '已提交', tone: 'attention', hint: '已提交给企业，等待安排审核' },
  reviewing: { label: '待企业审核', tone: 'attention', hint: '企业正在审核你的修改' },
  approved: { label: '企业已采纳', tone: 'ready', hint: '你的修改已纳入企业版本' },
  rejected: { label: '已驳回', tone: 'danger', hint: '企业未采纳，可查看意见后再改' },
};

// ─────────────────────────────── 工具函数 ───────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对时间。界面上尽量用「12 分钟前」而不是绝对时间戳。 */
export function relativeTime(at: number | null, now = Date.now()): string {
  if (!at) return '尚无记录';
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return '刚刚';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} 天前`;
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 「今天 14:32」「昨天 18:21」「8月27日 14:20」。抽屉和工作详情页都按这个写时间。 */
export function dayTimeText(at: number, now = Date.now()): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const start = (value: number) => { const day = new Date(value); day.setHours(0, 0, 0, 0); return day.getTime(); };
  const days = Math.round((start(now) - start(at)) / DAY);
  if (days <= 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  return `${new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** 「1 小时 32 分钟」。用于「已进行」「耗时」，不足一分钟按「不到 1 分钟」。 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MINUTE));
  if (total < 1) return '不到 1 分钟';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes} 分钟`;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/** 完整时间点，用于工作详情页的「开始时间 / 完成时间」。 */
export function stampText(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 「已完成 3 / 5 个步骤」。步骤数为 0 时不显示分母。 */
export function stepProgressText(done: number, total: number): string {
  if (!total) return '尚未拆分步骤';
  return `已完成 ${done} / ${total} 个步骤`;
}


