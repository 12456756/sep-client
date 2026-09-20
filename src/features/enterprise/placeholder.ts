/**
 * 平台接口尚未开放部分的占位数据。
 *
 * 每一项都标注了将来应由哪个接口提供。接口补齐后，删除对应常量并在
 * useEnterpriseWorkspace 里换成 IPC 调用即可，页面组件无需改动。
 *
 * 已经有真实来源的数据不在此文件内：
 * - 我可用的员工      ← GET /client/subscriptions（getInstances）
 * - 工作列表与状态    ← 本地 TaskManager（getAllTasks / onTaskUpdated）
 */

import type { OperationPermission, SiliconEmployee, WorkTemplate } from './types';

// ──────────────────── 本机操作权限（本地设置，非平台数据） ────────────────────

/**
 * 权限由用户自己开启，开启时提醒。界面不出现工具名、协议或执行参数。
 * 后端策略仍以 pi-extension/guard.ts 为准，这里只是用户可见的意愿表达。
 */
export function defaultPermissions(): OperationPermission[] {
  return [
    {
      id: 'read-files',
      label: '读取指定文件夹',
      summary: '打开你选择的文件夹，读取里面的资料',
      risk: 'low',
      enabled: true,
      scope: '未选择文件夹',
      notice: '员工只能读取你指定的这个文件夹，不会读取其他位置。你可以随时更改范围或关闭。',
      confirmEachTime: false,
    },
    {
      id: 'browser',
      label: '浏览器操作',
      summary: '打开网页、查看内容、填写表单',
      risk: 'medium',
      enabled: false,
      notice: '员工会在一个独立的浏览器窗口里操作，你能看到它在做什么。它可能会登录网站或提交表单，涉及付款或对外发送的页面会先问你。',
      confirmEachTime: false,
    },
    {
      id: 'write-files',
      label: '修改本机文件',
      summary: '在授权文件夹内新建和修改文件',
      risk: 'high',
      enabled: false,
      notice: '员工可以在你授权的文件夹里新建或改写文件。开启后，每次改写前仍会单独问你一次。',
      confirmEachTime: true,
    },
    {
      id: 'desktop-app',
      label: '桌面应用操作',
      summary: '打开并操作你电脑上已安装的软件',
      risk: 'high',
      enabled: false,
      notice: '员工可以打开并操作你电脑上的软件，例如表格或办公工具。开启后，每个动作都会先问你。',
      confirmEachTime: true,
    },
    {
      id: 'shell',
      label: '执行系统命令',
      summary: '运行命令完成批量处理',
      risk: 'high',
      enabled: false,
      notice: '这是权限最大的一项。员工可以运行系统命令，影响范围可能超出授权文件夹。开启后每条命令都会先问你，建议只在需要时临时开启。',
      confirmEachTime: true,
    },
  ];
}

// ────────────── 员工画像补充：TODO ← GET /enterprise/employees/:id ──────────────

interface EmployeeProfile {
  intro: string;
  goodAt: string[];
  cannotDo: string[];
}

/** 按职能名匹配。真实接口应直接返回这些字段。 */
const PROFILE_BY_ROLE: Record<string, EmployeeProfile> = {
  数据分析: {
    intro: '负责把零散的表格和记录整理成能看懂的结论，擅长发现数字上的异常。',
    goodAt: ['整理和清洗表格数据', '对比多个时间段的变化', '找出异常数据并说明原因', '生成图表所需的数据'],
    cannotDo: ['提供投资或财务决策建议', '处理没有明确口径的估算', '访问未授权的数据库'],
  },
  内容运营: {
    intro: '负责把资料写成可以直接使用的文字，擅长按不同场合调整语气和长度。',
    goodAt: ['撰写产品与活动文案', '整理会议记录成纪要', '按模板生成周报月报', '统一多篇文档的口径'],
    cannotDo: ['对外正式发布内容', '承诺法律或合规相关表述', '编造没有依据的数据'],
  },
  审核校对: {
    intro: '负责在交付前把文件检查一遍，擅长发现数字、口径和格式上的问题。',
    goodAt: ['核对数字与前后文一致性', '检查错别字和格式', '对照要求逐项验收', '整理修改建议清单'],
    cannotDo: ['替你做最终决定', '修改企业规定的模板', '判断业务上的对错'],
  },
  客户支持: {
    intro: '负责整理客户往来信息，擅长从多轮沟通里提炼出待办和风险。',
    goodAt: ['整理客户沟通记录', '归纳待跟进事项', '起草回复邮件初稿', '汇总客户反馈分类'],
    cannotDo: ['直接向客户发送内容', '承诺交付时间或价格', '处理客户支付信息'],
  },
  资料整理: {
    intro: '负责把散落在各处的文件收拢归类，擅长建立清晰的目录结构。',
    goodAt: ['按规则重命名和归档文件', '提取文档要点建立索引', '合并重复资料', '检查资料完整性'],
    cannotDo: ['删除任何原始文件', '处理加密或受限文件', '判断资料的保密级别'],
  },
};

const FALLBACK_PROFILE: EmployeeProfile = {
  intro: '负责按你交代的目标完成具体工作，遇到不确定的地方会先问你。',
  goodAt: ['按目标拆解并完成工作', '整理资料形成结果', '说明每一步做了什么'],
  cannotDo: ['替你做业务决定', '处理未授权的资料', '对外发送任何内容'],
};

export function profileForRole(roleName: string): EmployeeProfile {
  return PROFILE_BY_ROLE[roleName] ?? FALLBACK_PROFILE;
}

// ───────── 企业员工总名册：TODO ← GET /enterprise/employees（含未分配给我的） ─────────

/**
 * 首页要回答「企业共有多少名硅基员工」。订阅目录只返回我有权限的，
 * 所以这里补一份企业名册。未分配的员工只用于建立规模认知，不可直接操作。
 */
const ENTERPRISE_ROSTER: { role: string; department: string; count: number }[] = [
  { role: '数据分析', department: '数据部', count: 6 },
  { role: '内容运营', department: '市场部', count: 7 },
  { role: '审核校对', department: '质量部', count: 4 },
  { role: '客户支持', department: '客户成功部', count: 8 },
  { role: '资料整理', department: '行政部', count: 5 },
  { role: '流程协调', department: '运营部', count: 6 },
];

export const ENTERPRISE_TOTAL_EMPLOYEES = ENTERPRISE_ROSTER.reduce((sum, item) => sum + item.count, 0);

export const ENTERPRISE_DEPARTMENTS = ENTERPRISE_ROSTER.map(item => item.department);

/**
 * 生成企业名册中未分配给当前用户的员工，用于「硅基员工」页展示企业全貌。
 * assignedToMe 为 false 的卡片只提供「申请使用」，不提供开始对话。
 */
export function unassignedEmployees(assignedRoles: string[]): SiliconEmployee[] {
  const result: SiliconEmployee[] = [];
  for (const entry of ENTERPRISE_ROSTER) {
    const taken = assignedRoles.filter(role => role === entry.role).length;
    for (let index = taken; index < entry.count; index += 1) {
      const profile = profileForRole(entry.role);
      result.push({
        id: `roster-${entry.role}-${index}`,
        name: `${entry.role}员工 ${String(index + 1).padStart(2, '0')}`,
        mark: entry.role.slice(0, 1),
        roleName: entry.role,
        department: entry.department,
        availability: 'unavailable',
        assignedToMe: false,
        intro: profile.intro,
        goodAt: profile.goodAt,
        cannotDo: profile.cannotDo,
        lastWorkedAt: null,
        allowedModels: [],
        skillIds: [],
        permissions: defaultPermissions(),
        templateVersion: '—',
      });
    }
  }
  return result;
}

// ────────── 固定工作流程：TODO ← GET /enterprise/work-templates（尚未开放） ──────────

export const WORK_TEMPLATES: WorkTemplate[] = [
  {
    id: 'customer-weekly',
    name: '客户周报',
    goal: '汇总本周客户往来与进展，输出一份可直接发送的周报。',
    employeeIds: [],
    outputForm: 'Word 周报文档',
    requiredInputs: [
      { id: 'range', label: '统计时间范围', type: 'text', required: true, placeholder: '例如 8 月 24 日至 8 月 30 日' },
      { id: 'source', label: '客户资料文件夹', type: 'path', required: true },
      { id: 'focus', label: '需要重点说明的客户', type: 'long-text', required: false, placeholder: '没有可留空' },
    ],
    steps: [
      { title: '整理客户往来记录', input: '客户资料文件夹', output: '按客户归类的沟通记录', needsConfirm: false },
      { title: '提炼本周进展与风险', input: '上一步的沟通记录', output: '进展、风险和待跟进清单', needsConfirm: true },
      { title: '生成周报并检查', input: '进展清单与企业周报模板', output: '可发送的周报文档', needsConfirm: false },
    ],
  },
  {
    id: 'contract-precheck',
    name: '合同初步检查',
    goal: '对照企业要求逐项检查合同，标出需要人工确认的条款。',
    employeeIds: [],
    outputForm: '检查结论清单',
    requiredInputs: [
      { id: 'file', label: '合同文件所在文件夹', type: 'path', required: true },
      { id: 'concern', label: '特别关注的条款', type: 'enum', required: true, options: ['付款与结算', '交付与验收', '违约与赔偿', '保密与数据', '全部逐项检查'] },
    ],
    steps: [
      { title: '提取合同关键条款', input: '合同文件', output: '条款清单与原文位置', needsConfirm: false },
      { title: '对照企业要求逐项检查', input: '条款清单', output: '不符合项与风险说明', needsConfirm: true },
      { title: '整理需人工确认的问题', input: '检查结果', output: '需你决定的问题清单', needsConfirm: false },
    ],
  },
  {
    id: 'material-tidy',
    name: '资料整理',
    goal: '把杂乱的文件按规则归类命名，并给出一份目录索引。',
    employeeIds: [],
    outputForm: '整理后的文件夹与索引表',
    requiredInputs: [
      { id: 'source', label: '需要整理的文件夹', type: 'path', required: true },
      { id: 'rule', label: '命名与归类规则', type: 'long-text', required: false, placeholder: '留空则按日期和文件类型归类' },
    ],
    steps: [
      { title: '扫描并列出全部文件', input: '待整理文件夹', output: '文件清单与重复项标记', needsConfirm: false },
      { title: '按规则归类并重命名', input: '文件清单与命名规则', output: '整理方案', needsConfirm: true },
      { title: '生成目录索引', input: '整理方案', output: '索引表格', needsConfirm: false },
    ],
  },
  {
    id: 'data-summary',
    name: '数据汇总',
    goal: '把多个表格合并成统一口径的汇总表，并说明异常。',
    employeeIds: [],
    outputForm: 'Excel 汇总表',
    requiredInputs: [
      { id: 'source', label: '数据文件所在文件夹', type: 'path', required: true },
      { id: 'dimension', label: '汇总维度', type: 'text', required: true, placeholder: '例如 按月份和产品线' },
    ],
    steps: [
      { title: '统一字段与口径', input: '原始数据文件', output: '清洗后的数据与异常说明', needsConfirm: true },
      { title: '按维度汇总', input: '清洗后的数据', output: '汇总表', needsConfirm: false },
      { title: '复核数字', input: '汇总表', output: '经过核对的汇总表', needsConfirm: false },
    ],
  },
  {
    id: 'market-scan',
    name: '市场信息收集',
    goal: '按主题收集公开信息，整理成带来源的简报。',
    employeeIds: [],
    outputForm: '带来源的信息简报',
    requiredInputs: [
      { id: 'topic', label: '收集主题', type: 'long-text', required: true, placeholder: '例如 同类产品近三个月的定价变化' },
      { id: 'depth', label: '需要的详细程度', type: 'enum', required: true, options: ['只要结论', '结论加要点', '完整摘录'] },
    ],
    steps: [
      { title: '按主题收集公开信息', input: '收集主题', output: '原始信息与来源链接', needsConfirm: false },
      { title: '筛选并整理要点', input: '原始信息', output: '分类要点', needsConfirm: true },
      { title: '生成简报', input: '分类要点', output: '带来源的简报', needsConfirm: false },
    ],
  },
];
