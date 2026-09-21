/**
 * 截图脚手架专用：一份贴近真实使用情形的内存数据。
 *
 * 这不是产品代码，只在 src/harness 下被 mock-electron-api 引用，用来在没有平台登录
 * 凭据的情况下把每一个页面渲染成「有内容」的样子，方便截图与产品走查。
 * 真实运行时的数据来自主进程 IPC，形状见 shared/types.ts 与 platform-supplement-contracts.ts。
 */

import type {
  ClientTask,
  ClientTaskMessage,
  EmployeeStatus,
  RuntimeInfo,
  Subscription,
} from '../shared/types';
import type { EnterpriseOrganization, SkillVersion } from '../shared/platform-supplement-contracts';
import type { SkillLibraryItem } from '../shared/skill-library';
import { encodeWorkPrompt } from '../features/enterprise/work-mapping';

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ────────────────────────────── 登录身份 ──────────────────────────────

export const SESSION = {
  userId: 'u-1001',
  userName: '姚远',
  enterpriseId: 'ent-longdao',
  enterpriseName: '龙道科技',
};

// ────────────────────────────── 我的硅基员工 ──────────────────────────────

const MODELS = ['sep-employee', 'sep-fast'];

function subscription(
  subscriptionId: string,
  name: string,
  position: string,
  department: string,
  status: Subscription['status'],
  description: string,
): Subscription {
  return {
    id: subscriptionId,
    subscriptionId,
    employeeId: `emp-${subscriptionId}`,
    name,
    description,
    position,
    functionalCategory: position,
    status,
    templateVersion: 'v2.4',
    template: { id: `tpl-${subscriptionId}`, name: position, avatar: null },
    department: { name: department },
    allowedModels: [...MODELS],
    upgradeAvailable: false,
  };
}

export const SUBSCRIPTIONS: Subscription[] = [
  subscription('sub-analyst', '数据分析师 · 小析', '数据分析', '数据部', 'ACTIVE', '把零散的表格和记录整理成能看懂的结论，擅长发现数字上的异常。'),
  subscription('sub-writer', '内容运营 · 小文', '内容运营', '市场部', 'ACTIVE', '把资料写成可以直接使用的文字，擅长按不同场合调整语气和长度。'),
  subscription('sub-review', '审核校对 · 小校', '审核校对', '质量部', 'ACTIVE', '在交付前把文件检查一遍，擅长发现数字、口径和格式上的问题。'),
  subscription('sub-support', '客户支持 · 小客', '客户支持', '客户成功部', 'ACTIVE', '整理客户往来信息，擅长从多轮沟通里提炼出待办和风险。'),
  subscription('sub-tidy', '资料整理 · 小整', '资料整理', '行政部', 'ACTIVE', '把散落在各处的文件收拢归类，擅长建立清晰的目录结构。'),
  subscription('sub-coord', '流程协调 · 小调', '流程协调', '运营部', 'PAUSED', '协调多人协作的流程节点，企业已暂停这位员工的使用。'),
];

export const EMPLOYEE_STATUSES: EmployeeStatus[] = [
  { employeeId: 'emp-sub-writer', status: 'WORKING' },
  { employeeId: 'emp-sub-analyst', status: 'IDLE' },
  { employeeId: 'emp-sub-review', status: 'IDLE' },
  { employeeId: 'emp-sub-support', status: 'IDLE' },
  { employeeId: 'emp-sub-tidy', status: 'IDLE' },
  { employeeId: 'emp-sub-coord', status: 'IDLE' },
];

export const RUNTIME_INFO: RuntimeInfo = {
  version: '0.1.0',
  channel: 'beta',
  environment: 'integration',
  apiBaseUrl: 'https://sep-dev.longdao.cn/api',
  gatewayUrl: 'https://sep-dev.longdao.cn/api/gateway/v1',
  buildTime: 'development',
};

// ────────────────────────────── 组织架构 ──────────────────────────────

export const ORGANIZATION: EnterpriseOrganization = {
  enterprise: { id: 'ent-longdao', name: '龙道科技', logo: null },
  permissions: {
    grantVisibility: 'ENTERPRISE',
    departmentGrantInheritance: 'DIRECT_DEPARTMENT_ONLY',
    personalReportingSupported: false,
  },
  statistics: {
    employeeCount: 10,
    subscriptionCount: 10,
    activeEmployeeCount: 9,
    currentUserAvailableEmployeeCount: 6,
  },
  employees: [
    { employeeId: 'emp-sub-analyst', subscriptionId: 'sub-analyst', name: '数据分析师 · 小析', avatar: null, position: '数据分析', description: '把零散的表格和记录整理成能看懂的结论。', status: 'ACTIVE', employeeStatus: 'IDLE', endDate: null, active: true, currentUserCanUse: true },
    { employeeId: 'emp-sub-writer', subscriptionId: 'sub-writer', name: '内容运营 · 小文', avatar: null, position: '内容运营', description: '把资料写成可以直接使用的文字。', status: 'ACTIVE', employeeStatus: 'WORKING', endDate: null, active: true, currentUserCanUse: true },
    { employeeId: 'emp-sub-review', subscriptionId: 'sub-review', name: '审核校对 · 小校', avatar: null, position: '审核校对', description: '在交付前把文件检查一遍。', status: 'ACTIVE', employeeStatus: 'IDLE', endDate: null, active: true, currentUserCanUse: true },
    { employeeId: 'emp-sub-support', subscriptionId: 'sub-support', name: '客户支持 · 小客', avatar: null, position: '客户支持', description: '整理客户往来信息，提炼待办和风险。', status: 'ACTIVE', employeeStatus: 'IDLE', endDate: null, active: true, currentUserCanUse: true },
    { employeeId: 'emp-sub-tidy', subscriptionId: 'sub-tidy', name: '资料整理 · 小整', avatar: null, position: '资料整理', description: '把散落的文件收拢归类。', status: 'ACTIVE', employeeStatus: 'IDLE', endDate: null, active: true, currentUserCanUse: true },
    { employeeId: 'emp-sub-coord', subscriptionId: 'sub-coord', name: '流程协调 · 小调', avatar: null, position: '流程协调', description: '协调多人协作的流程节点。', status: 'PAUSED', employeeStatus: 'IDLE', endDate: null, active: false, currentUserCanUse: true },
    { employeeId: 'emp-fin-1', subscriptionId: 'sub-fin-1', name: '财务对账 · 小账', avatar: null, position: '财务对账', description: '核对账目与发票，标出异常。', status: 'ACTIVE', employeeStatus: 'IDLE', endDate: null, active: true, currentUserCanUse: false },
    { employeeId: 'emp-fin-2', subscriptionId: 'sub-fin-2', name: '财务对账 · 小核', avatar: null, position: '财务对账', description: '复核账目数据与凭证一致性。', status: 'ACTIVE', employeeStatus: 'IDLE', endDate: null, active: true, currentUserCanUse: false },
    { employeeId: 'emp-legal-1', subscriptionId: 'sub-legal-1', name: '法务初审 · 小律', avatar: null, position: '法务初审', description: '对照模板检查合同关键条款。', status: 'ACTIVE', employeeStatus: 'IDLE', endDate: null, active: true, currentUserCanUse: false },
    { employeeId: 'emp-mkt-1', subscriptionId: 'sub-mkt-1', name: '市场调研 · 小研', avatar: null, position: '市场调研', description: '收集公开信息并整理成带来源的简报。', status: 'EXPIRED', employeeStatus: 'IDLE', endDate: '2026-08-01', active: false, currentUserCanUse: false },
  ],
  departments: [
    { id: 'dept-data', name: '数据部', parentId: null, leaderId: 'm-1001', sortOrder: 0 },
    { id: 'dept-market', name: '市场部', parentId: null, leaderId: 'm-2001', sortOrder: 1 },
    { id: 'dept-cs', name: '客户成功部', parentId: null, leaderId: 'm-3001', sortOrder: 2 },
    { id: 'dept-quality', name: '质量部', parentId: 'dept-data', leaderId: null, sortOrder: 3 },
  ],
  members: [
    { id: 'm-1001', userId: 'u-1001', name: '姚远', departmentId: 'dept-data', position: '数据负责人', avatar: null },
    { id: 'm-1002', userId: 'u-1002', name: '林墨', departmentId: 'dept-data', position: '数据分析师', avatar: null },
    { id: 'm-1003', userId: 'u-1003', name: '周予安', departmentId: 'dept-quality', position: '质量审核', avatar: null },
    { id: 'm-2001', userId: 'u-2001', name: '苏见月', departmentId: 'dept-market', position: '市场负责人', avatar: null },
    { id: 'm-2002', userId: 'u-2002', name: '陈叙', departmentId: 'dept-market', position: '内容运营', avatar: null },
    { id: 'm-3001', userId: 'u-3001', name: '何斯远', departmentId: 'dept-cs', position: '客户成功负责人', avatar: null },
    { id: 'm-3002', userId: 'u-3002', name: '叶清和', departmentId: 'dept-cs', position: '客户支持', avatar: null },
  ],
  grants: [
    { id: 'g-1', subscriptionId: 'sub-analyst', memberId: 'm-1001', departmentId: null, expiresAt: null },
    { id: 'g-2', subscriptionId: 'sub-writer', memberId: 'm-2002', departmentId: null, expiresAt: null },
    { id: 'g-3', subscriptionId: 'sub-review', memberId: 'm-1003', departmentId: null, expiresAt: null },
    { id: 'g-4', subscriptionId: 'sub-support', memberId: 'm-3002', departmentId: null, expiresAt: null },
    { id: 'g-5', subscriptionId: 'sub-tidy', memberId: null, departmentId: 'dept-data', expiresAt: null },
    { id: 'g-6', subscriptionId: 'sub-coord', memberId: null, departmentId: 'dept-market', expiresAt: '2026-07-01T00:00:00.000Z' },
  ],
};

// ────────────────────────────── 工作（本地任务） ──────────────────────────────

interface SeedStep {
  id: string;
  employeeId: string;
  title: string;
  input: string;
  output: string;
  dependsOn: string[];
  needsConfirm: boolean;
}

function task(args: {
  id: string;
  title: string;
  status: ClientTask['status'];
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  progress?: number;
  error?: string | null;
  files?: string[];
  logs?: { at: number; message: string; level?: 'info' | 'warning' | 'error' }[];
  subscriptionId: string;
  activeRunId?: string | null;
  kind: 'conversation' | 'flow';
  goal: string;
  steps?: SeedStep[];
  participants: string[];
  confirmedInputs?: string[];
  templateId?: string;
  stopReason?: string | null;
}): ClientTask {
  const prompt = encodeWorkPrompt(args.title, {
    kind: args.kind,
    goal: args.goal,
    templateId: args.templateId,
    steps: (args.steps ?? []).map(({ id, employeeId, title, input, output, dependsOn, needsConfirm }) => ({
      id, employeeId, title, input, output, dependsOn, needsConfirm,
    })),
    participants: args.participants,
    sharedContext: {
      goal: args.goal,
      confirmedInputs: args.confirmedInputs ?? [],
      previousResults: [],
      userNotes: [],
    },
    stopReason: args.stopReason ?? null,
  });
  return {
    id: args.id,
    title: args.title,
    prompt,
    status: args.status,
    workDir: '/Users/yao/Documents/龙道科技/工作区',
    createdAt: args.createdAt,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    error: args.error ?? null,
    files: args.files ?? [],
    logs: (args.logs ?? []).map(log => ({ timestamp: log.at, message: log.message, level: log.level })),
    progress: args.progress,
    ownerId: SESSION.userId,
    ownerEnterpriseId: SESSION.enterpriseId,
    subscriptionId: args.subscriptionId,
    activeRunId: args.activeRunId ?? null,
  };
}

export const TASKS: ClientTask[] = [
  // 1) 正在进行的流程工作（多人协作，进度过半）——工作详情「团队」视图 + 进度环。
  task({
    id: 'work-customer-weekly',
    title: '本周客户周报',
    status: 'running',
    createdAt: NOW - 2 * HOUR,
    startedAt: NOW - 2 * HOUR + 5 * MIN,
    completedAt: null,
    progress: 55,
    subscriptionId: 'sub-support',
    activeRunId: 'run-cw-1',
    kind: 'flow',
    templateId: 'customer-weekly',
    goal: '汇总本周客户往来与进展，输出一份可直接发送的周报。',
    confirmedInputs: ['客户资料文件夹 ~/Documents/客户', '企业周报模板'],
    participants: ['sub-support', 'sub-writer', 'sub-review'],
    steps: [
      { id: 's1', employeeId: 'sub-support', title: '整理客户往来记录', input: '客户资料文件夹', output: '按客户归类的沟通记录', dependsOn: [], needsConfirm: false },
      { id: 's2', employeeId: 'sub-support', title: '提炼本周进展与风险', input: '上一步的沟通记录', output: '进展、风险和待跟进清单', dependsOn: ['s1'], needsConfirm: true },
      { id: 's3', employeeId: 'sub-writer', title: '撰写周报正文', input: '进展清单与企业周报模板', output: '周报初稿', dependsOn: ['s2'], needsConfirm: false },
      { id: 's4', employeeId: 'sub-review', title: '校对周报并定稿', input: '周报初稿', output: '可发送的周报文档', dependsOn: ['s3'], needsConfirm: false },
    ],
    logs: [
      { at: NOW - 2 * HOUR + 6 * MIN, message: '读取客户资料文件夹，发现 18 个客户记录' },
      { at: NOW - 90 * MIN, message: '按客户归类沟通记录，整理出 18 份' },
      { at: NOW - 60 * MIN, message: '提炼本周进展，标记出 3 项风险与 5 项待跟进' },
      { at: NOW - 30 * MIN, message: '正在撰写周报正文' },
    ],
  }),

  // 2) 正在进行的对话式工作——工作详情「单人」视图 + 继续对话抽屉。
  task({
    id: 'work-chat-summary',
    title: '帮我整理一下昨天的会议纪要',
    status: 'running',
    createdAt: NOW - 25 * MIN,
    startedAt: NOW - 24 * MIN,
    completedAt: null,
    progress: 40,
    subscriptionId: 'sub-writer',
    activeRunId: 'run-chat-1',
    kind: 'conversation',
    goal: '把昨天的项目评审会录音转写整理成结构化纪要。',
    participants: ['sub-writer'],
    logs: [
      { at: NOW - 24 * MIN, message: '读取会议录音转写文本' },
      { at: NOW - 12 * MIN, message: '按议题归并发言，正在生成纪要' },
    ],
  }),

  // 3) 等待你确认的流程工作——工作详情「现在需要你」确认条。
  task({
    id: 'work-contract-check',
    title: '采购合同初步检查',
    status: 'waiting_approval',
    createdAt: NOW - 5 * HOUR,
    startedAt: NOW - 5 * HOUR + 3 * MIN,
    completedAt: null,
    progress: 50,
    subscriptionId: 'sub-review',
    activeRunId: 'run-cc-1',
    kind: 'flow',
    templateId: 'contract-precheck',
    goal: '对照企业要求逐项检查合同，标出需要人工确认的条款。',
    confirmedInputs: ['合同文件 ~/Documents/合同/采购-2026-09.docx'],
    participants: ['sub-review'],
    steps: [
      { id: 's1', employeeId: 'sub-review', title: '提取合同关键条款', input: '合同文件', output: '条款清单与原文位置', dependsOn: [], needsConfirm: false },
      { id: 's2', employeeId: 'sub-review', title: '对照企业要求逐项检查', input: '条款清单', output: '不符合项与风险说明', dependsOn: ['s1'], needsConfirm: true },
      { id: 's3', employeeId: 'sub-review', title: '整理需人工确认的问题', input: '检查结果', output: '需你决定的问题清单', dependsOn: ['s2'], needsConfirm: false },
    ],
    logs: [
      { at: NOW - 5 * HOUR + 4 * MIN, message: '提取合同条款 32 条' },
      { at: NOW - 4 * HOUR, message: '逐项对照企业要求，发现 4 处需要人工确认' },
      { at: NOW - 3.5 * HOUR, message: '等待你确认检查结果', level: 'warning' },
    ],
  }),

  // 4) 已完成的流程工作（有产物）——工作详情「工作结果」+ 产出列表。
  task({
    id: 'work-data-summary',
    title: '8 月销售数据汇总',
    status: 'completed',
    createdAt: NOW - DAY - 3 * HOUR,
    startedAt: NOW - DAY - 3 * HOUR,
    completedAt: NOW - DAY - 1 * HOUR,
    progress: 100,
    subscriptionId: 'sub-analyst',
    kind: 'flow',
    templateId: 'data-summary',
    goal: '把多个区域的销售表合并成统一口径的汇总表，并说明异常。',
    confirmedInputs: ['销售数据文件夹 ~/Documents/销售/8月'],
    participants: ['sub-analyst', 'sub-review'],
    files: [
      '/Users/yao/Documents/龙道科技/工作区/8月销售汇总.xlsx',
      '/Users/yao/Documents/龙道科技/工作区/异常说明.md',
    ],
    steps: [
      { id: 's1', employeeId: 'sub-analyst', title: '统一字段与口径', input: '原始数据文件', output: '清洗后的数据与异常说明', dependsOn: [], needsConfirm: true },
      { id: 's2', employeeId: 'sub-analyst', title: '按维度汇总', input: '清洗后的数据', output: '汇总表', dependsOn: ['s1'], needsConfirm: false },
      { id: 's3', employeeId: 'sub-review', title: '复核数字', input: '汇总表', output: '经过核对的汇总表', dependsOn: ['s2'], needsConfirm: false },
    ],
    logs: [
      { at: NOW - DAY - 3 * HOUR, message: '读取 6 个区域销售表' },
      { at: NOW - DAY - 2.5 * HOUR, message: '统一口径，剔除重复记录 42 条' },
      { at: NOW - DAY - 2 * HOUR, message: '按月份和产品线汇总' },
      { at: NOW - DAY - 1.2 * HOUR, message: '复核数字，发现华南区一处口径异常已标注' },
      { at: NOW - DAY - 1 * HOUR, message: '工作完成，产出 2 个文件' },
    ],
  }),

  // 5) 已完成的对话式工作（有消息）——继续对话抽屉里有完整对话。
  task({
    id: 'work-chat-translate',
    title: '把产品说明翻译成英文',
    status: 'completed',
    createdAt: NOW - 2 * DAY,
    startedAt: NOW - 2 * DAY,
    completedAt: NOW - 2 * DAY + 40 * MIN,
    progress: 100,
    subscriptionId: 'sub-writer',
    kind: 'conversation',
    goal: '把新版产品说明翻译成英文，保持术语一致。',
    participants: ['sub-writer'],
    files: ['/Users/yao/Documents/龙道科技/工作区/product-spec-en.md'],
    logs: [{ at: NOW - 2 * DAY + 38 * MIN, message: '翻译完成，统一了 12 个术语' }],
  }),

  // 6) 中断（失败）的流程工作——工作详情「中断原因 + 重新试一次」。
  task({
    id: 'work-market-scan',
    title: '竞品定价信息收集',
    status: 'failed',
    createdAt: NOW - 8 * HOUR,
    startedAt: NOW - 8 * HOUR,
    completedAt: NOW - 7 * HOUR,
    progress: 33,
    error: '访问目标网站超时，连续重试 3 次后仍未取得数据。',
    subscriptionId: 'sub-analyst',
    kind: 'flow',
    templateId: 'market-scan',
    goal: '按主题收集同类产品近三个月的公开定价信息，整理成带来源的简报。',
    confirmedInputs: ['收集主题：同类产品近三个月定价变化'],
    participants: ['sub-analyst'],
    steps: [
      { id: 's1', employeeId: 'sub-analyst', title: '按主题收集公开信息', input: '收集主题', output: '原始信息与来源链接', dependsOn: [], needsConfirm: false },
      { id: 's2', employeeId: 'sub-analyst', title: '筛选并整理要点', input: '原始信息', output: '分类要点', dependsOn: ['s1'], needsConfirm: true },
      { id: 's3', employeeId: 'sub-analyst', title: '生成简报', input: '分类要点', output: '带来源的简报', dependsOn: ['s2'], needsConfirm: false },
    ],
    logs: [
      { at: NOW - 8 * HOUR, message: '开始收集公开信息' },
      { at: NOW - 7.5 * HOUR, message: '目标网站响应超时，正在重试', level: 'warning' },
      { at: NOW - 7 * HOUR, message: '连续重试失败，工作中断', level: 'error' },
    ],
  }),

  // 7) 已终止（用户主动停止）——工作详情「已终止 + 重新执行」。
  task({
    id: 'work-material-tidy',
    title: '项目资料整理归档',
    status: 'interrupted',
    createdAt: NOW - 3 * DAY,
    startedAt: NOW - 3 * DAY,
    completedAt: NOW - 3 * DAY + 20 * MIN,
    progress: 40,
    error: '资料给错了，需要重新准备后再来。',
    subscriptionId: 'sub-tidy',
    kind: 'flow',
    templateId: 'material-tidy',
    goal: '把项目散落的文件按规则归类命名，并给出一份目录索引。',
    participants: ['sub-tidy'],
    files: ['/Users/yao/Documents/龙道科技/工作区/文件清单.csv'],
    steps: [
      { id: 's1', employeeId: 'sub-tidy', title: '扫描并列出全部文件', input: '待整理文件夹', output: '文件清单与重复项标记', dependsOn: [], needsConfirm: false },
      { id: 's2', employeeId: 'sub-tidy', title: '按规则归类并重命名', input: '文件清单与命名规则', output: '整理方案', dependsOn: ['s1'], needsConfirm: true },
      { id: 's3', employeeId: 'sub-tidy', title: '生成目录索引', input: '整理方案', output: '索引表格', dependsOn: ['s2'], needsConfirm: false },
    ],
    logs: [
      { at: NOW - 3 * DAY, message: '扫描文件夹，列出 126 个文件' },
      { at: NOW - 3 * DAY + 18 * MIN, message: '你终止了这项工作' },
    ],
    stopReason: '资料给错了，需要重新准备后再来。',
  }),

  // 8) 安排中（草稿，尚未开工）——工作记录「查看安排」。
  task({
    id: 'work-draft-plan',
    title: '季度经营分析（草稿）',
    status: 'pending',
    createdAt: NOW - 40 * MIN,
    startedAt: null,
    completedAt: null,
    progress: 0,
    subscriptionId: 'sub-analyst',
    kind: 'flow',
    goal: '汇总本季度经营数据，输出一份给管理层看的分析。',
    participants: ['sub-analyst', 'sub-writer'],
    steps: [
      { id: 's1', employeeId: 'sub-analyst', title: '汇总经营数据', input: '财务与运营数据', output: '统一口径的数据表', dependsOn: [], needsConfirm: true },
      { id: 's2', employeeId: 'sub-writer', title: '撰写分析结论', input: '数据表', output: '分析草稿', dependsOn: ['s1'], needsConfirm: false },
    ],
  }),
];

// ────────────────────────────── 对话消息 ──────────────────────────────

export const MESSAGES: Record<string, ClientTaskMessage[]> = {
  'work-chat-summary': [
    { id: 'm1', role: 'user', content: '把昨天的项目评审会录音转写整理成结构化纪要。', createdAt: NOW - 25 * MIN, runId: 'run-chat-1' },
    { id: 'm2', role: 'assistant', content: '好的，我已经读取了转写文本，全长约 6400 字。我会按「议题 → 讨论要点 → 决议 → 待办」来整理。先确认一下：这次评审会有哪几个议题是你最关心的？', createdAt: NOW - 24 * MIN, runId: 'run-chat-1' },
    { id: 'm3', role: 'user', content: '重点是排期和分工，其它简略一点就行。', createdAt: NOW - 20 * MIN, runId: 'run-chat-1' },
    { id: 'm4', role: 'assistant', content: '明白。我已经把「排期」和「分工」两块展开整理，正在归并发言、提炼决议，稍后给你一份纪要初稿。', createdAt: NOW - 12 * MIN, runId: 'run-chat-1' },
  ],
  'work-chat-translate': [
    { id: 'm1', role: 'user', content: '把新版产品说明翻译成英文，保持术语一致。', createdAt: NOW - 2 * DAY, runId: 'run-tr-1' },
    { id: 'm2', role: 'assistant', content: '已翻译完成。我建立了一份术语对照表，统一了 12 个核心术语（例如「硅基员工」统一译为 silicon employee、「工作」译为 task）。译文已保存为 product-spec-en.md。', createdAt: NOW - 2 * DAY + 38 * MIN, runId: 'run-tr-1' },
    { id: 'm3', role: 'user', content: '很好，术语表也发我一份。', createdAt: NOW - 2 * DAY + 39 * MIN, runId: 'run-tr-1' },
    { id: 'm4', role: 'assistant', content: '术语对照表已附在文件末尾的 Glossary 一节，方便后续维护时复用。', createdAt: NOW - 2 * DAY + 40 * MIN, runId: 'run-tr-1' },
  ],
};

// ────────────────────────────── 技能库 ──────────────────────────────

function skillVersion(args: {
  id: string;
  capabilityId: string;
  scope: 'PLATFORM' | 'ENTERPRISE' | 'PERSONAL';
  version: string;
  status: string;
  changeSummary?: string;
  createdAt?: string;
}): SkillVersion {
  return {
    id: args.id,
    capabilityId: args.capabilityId,
    scope: args.scope,
    version: args.version,
    status: args.status,
    changeSummary: args.changeSummary ?? null,
    createdAt: args.createdAt ?? '2026-08-01T10:00:00.000Z',
    updatedAt: args.createdAt ?? '2026-08-01T10:00:00.000Z',
    parentVersionId: null,
    enterpriseId: args.scope === 'ENTERPRISE' ? SESSION.enterpriseId : null,
  };
}

export const SKILL_LIBRARY: SkillLibraryItem[] = [
  {
    capability: { id: 'cap-weekly-report', name: '周报撰写', description: '按企业模板把零散进展整理成结构统一的周报。', type: 'PROMPT' },
    bindings: [
      { subscriptionId: 'sub-writer', employeeId: 'emp-sub-writer', currentVersion: skillVersion({ id: 'sv-wr-ent', capabilityId: 'cap-weekly-report', scope: 'ENTERPRISE', version: '2.1.0', status: 'ENTERPRISE_APPROVED' }), selectedVersionId: 'sv-wr-ent' },
      { subscriptionId: 'sub-support', employeeId: 'emp-sub-support', currentVersion: skillVersion({ id: 'sv-wr-ent', capabilityId: 'cap-weekly-report', scope: 'ENTERPRISE', version: '2.1.0', status: 'ENTERPRISE_APPROVED' }), selectedVersionId: 'sv-wr-ent' },
    ],
    usableVersionIds: ['sv-wr-platform', 'sv-wr-ent'],
    versions: [
      skillVersion({ id: 'sv-wr-platform', capabilityId: 'cap-weekly-report', scope: 'PLATFORM', version: '2.0.0', status: 'PLATFORM_APPROVED', createdAt: '2026-06-12T08:00:00.000Z' }),
      skillVersion({ id: 'sv-wr-ent', capabilityId: 'cap-weekly-report', scope: 'ENTERPRISE', version: '2.1.0', status: 'ENTERPRISE_APPROVED', createdAt: '2026-08-01T10:00:00.000Z' }),
    ],
    localVersions: [],
  },
  {
    capability: { id: 'cap-data-clean', name: '数据清洗', description: '统一字段口径、剔除重复、标注异常，产出可汇总的干净数据。', type: 'PROMPT' },
    bindings: [
      { subscriptionId: 'sub-analyst', employeeId: 'emp-sub-analyst', currentVersion: skillVersion({ id: 'sv-dc-ent', capabilityId: 'cap-data-clean', scope: 'ENTERPRISE', version: '1.4.2', status: 'ENTERPRISE_APPROVED' }), selectedVersionId: 'sv-dc-ent' },
    ],
    usableVersionIds: ['sv-dc-platform', 'sv-dc-ent'],
    versions: [
      skillVersion({ id: 'sv-dc-platform', capabilityId: 'cap-data-clean', scope: 'PLATFORM', version: '1.3.0', status: 'PLATFORM_APPROVED', createdAt: '2026-05-20T08:00:00.000Z' }),
      skillVersion({ id: 'sv-dc-ent', capabilityId: 'cap-data-clean', scope: 'ENTERPRISE', version: '1.4.2', status: 'ENTERPRISE_APPROVED', createdAt: '2026-08-15T09:30:00.000Z' }),
    ],
    localVersions: [],
  },
  {
    capability: { id: 'cap-contract-check', name: '合同条款核对', description: '对照企业要求逐项检查合同，标出需要人工确认的条款。', type: 'PROMPT' },
    bindings: [
      { subscriptionId: 'sub-review', employeeId: 'emp-sub-review', currentVersion: skillVersion({ id: 'sv-cc-ent', capabilityId: 'cap-contract-check', scope: 'ENTERPRISE', version: '3.0.1', status: 'ENTERPRISE_APPROVED' }), selectedVersionId: 'sv-cc-ent' },
    ],
    usableVersionIds: ['sv-cc-ent', 'sv-cc-personal'],
    versions: [
      skillVersion({ id: 'sv-cc-ent', capabilityId: 'cap-contract-check', scope: 'ENTERPRISE', version: '3.0.1', status: 'ENTERPRISE_APPROVED', createdAt: '2026-07-30T10:00:00.000Z' }),
      skillVersion({ id: 'sv-cc-personal', capabilityId: 'cap-contract-check', scope: 'PERSONAL', version: '3.0.1-my', status: 'PENDING_ENTERPRISE_REVIEW', changeSummary: '我的优化版：增加付款条款的额外检查项', createdAt: '2026-09-10T14:00:00.000Z' }),
    ],
    localVersions: [],
  },
];

export const SKILL_SOURCES: Record<string, string> = {
  'cap-weekly-report': `---
name: 周报撰写
version: 2.1.0
scope: ENTERPRISE
---

# 周报撰写

## 目标
把一周内零散的工作进展，整理成结构统一、可直接发送的周报。

## 输出结构
1. **本周概要**：三句话讲清楚整体进展。
2. **关键进展**：按客户/项目分组，每组列出做了什么、结果如何。
3. **风险与阻塞**：明确写出卡在哪里、需要谁支持。
4. **下周计划**：可执行、可衡量的事项。

## 风格要求
- 用陈述句，不堆形容词。
- 数字优先：能量化的一律量化。
- 风险要写明影响范围与期望时间。
`,
  'cap-data-clean': `---
name: 数据清洗
version: 1.4.2
scope: ENTERPRISE
---

# 数据清洗

## 步骤
1. 读取全部原始表，列出字段差异。
2. 统一字段名与口径（日期格式、金额单位、产品分类）。
3. 剔除重复记录，保留最新一条并记录剔除数量。
4. 标注异常值（缺失、离群、口径不一致），不擅自填补。

## 产出
- 清洗后的统一数据表。
- 一份异常说明：每条异常的位置、类型、建议处理方式。
`,
  'cap-contract-check': `---
name: 合同条款核对
version: 3.0.1
scope: ENTERPRISE
---

# 合同条款核对

## 检查清单
- 付款与结算：账期、违约金、发票要求。
- 交付与验收：交付物、验收标准、时间。
- 违约与赔偿：责任上限、免责情形。
- 保密与数据：数据归属、保密期限。

## 输出
逐项给出「符合 / 需人工确认 / 不符合」，并附原文位置与建议。
`,
};
