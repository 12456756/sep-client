import type { ElectronAPI } from '../shared/ipc';
import type { ClientTask, ClientTaskMessage, EmployeeInstanceSnapshot, TaskExecutionEvent } from '../shared/types';
import { ClientAppPage } from './ClientAppPage';

const now = Date.now();
/** 预览里放六位员工：首页员工墙一行铺四张卡，两行才看得出换行和气泡的位置。 */
const previewInstances: EmployeeInstanceSnapshot[] = [
  { id: 'preview-content', name: '运营文案助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'content', name: '内容运营', avatar: '文' }, department: { id: 'marketing', name: '市场部' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-analysis', name: '数据分析助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'analysis', name: '数据分析', avatar: '数' }, department: { id: 'data', name: '数据部' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-review', name: '交付审核助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'review', name: '审核校对', avatar: '审' }, department: { id: 'quality', name: '质量部' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-support', name: '客户支持助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'support', name: '客户支持', avatar: '客' }, department: { id: 'service', name: '客服部' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-research', name: '市场调研助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'research', name: '市场调研', avatar: '研' }, department: { id: 'marketing', name: '市场部' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-design', name: '设计助理', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'design', name: '视觉设计', avatar: '设' }, department: { id: 'design', name: '设计部' }, allowedModels: ['gpt-5.2'] },
];

const planSteps = [
  { id: 'step-analysis', subscriptionId: 'preview-analysis', title: '整理输入数据', instruction: '检查输入数据的完整性，统一关键字段并整理异常项。', expectedOutput: '清洗后的数据和异常说明' },
  { id: 'step-content', subscriptionId: 'preview-content', title: '形成分析报告', instruction: '根据整理结果提炼趋势和结论，形成管理层可读的报告。', expectedOutput: '结构化分析报告' },
  { id: 'step-review', subscriptionId: 'preview-review', title: '复核并交付', instruction: '检查数字、结论和文字表达，整理最终交付说明。', expectedOutput: '经过审核的最终报告' },
];
const workflowPrompt = (goal: string) => `[SEP_WORKFLOW_TASK]\n分析报告\n\n工作目标：\n${goal}\n\n[SEP_TASK_PLAN]\n${JSON.stringify({ goal, steps: planSteps })}`;

/**
 * 多人协作的工作。走新的 [SEP_WORK_META] 编码（见 work-mapping），
 * 这样工作详情页才读得出参与员工和步骤 —— 上面那个 legacy 编码只带得出一位员工。
 */
const teamPrompt = (goal: string) => {
  const steps = [
    { id: 'step-1', employeeId: 'preview-research', title: '收集竞品活动资料', input: '活动周期与竞品名单', output: '竞品活动资料汇总', dependsOn: [] as string[], needsConfirm: false },
    { id: 'step-2', employeeId: 'preview-analysis', title: '分析活动转化率', input: '竞品资料与本次活动数据', output: '转化率分析结果', dependsOn: ['step-1'], needsConfirm: false },
    { id: 'step-3', employeeId: 'preview-content', title: '生成活动复盘报告', input: '转化率分析结果', output: '618 活动复盘报告', dependsOn: ['step-2'], needsConfirm: true },
  ];
  const meta = {
    kind: 'flow' as const,
    goal,
    steps,
    participants: ['preview-research', 'preview-analysis', 'preview-content'],
    sharedContext: { goal, confirmedInputs: ['活动数据在「运营/618」文件夹', '上季度复盘可作为格式参考'], previousResults: [], userNotes: [] },
  };
  return `618 活动复盘报告\n\n工作目标：\n${goal}\n\n[SEP_WORK_META]${JSON.stringify(meta)}`;
};

let previewTasks: ClientTask[] = [
  { id: 'preview-team', title: '618 活动复盘报告', prompt: teamPrompt('复盘 618 活动的投放与转化，产出可交付的复盘报告'), status: 'running', workDir: 'D:/workspace/618-analysis', createdAt: now - 136 * 60_000, startedAt: now - 130 * 60_000, completedAt: null, error: null, files: ['D:/workspace/618-analysis/活动数据分析.xlsx', 'D:/workspace/618-analysis/关键结论汇总.pptx'], logs: [{ timestamp: now - 130 * 60_000, message: '市场调研助手已接单' }, { timestamp: now - 96 * 60_000, message: '整理竞品活动资料' }, { timestamp: now - 74 * 60_000, message: '读取 12 个数据文件' }, { timestamp: now - 38 * 60_000, message: '完成数据清洗' }, { timestamp: now - 12 * 60_000, message: '正在分析活动转化率' }], progress: 72, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-analysis', activeRunId: 'preview-run-0' },
  { id: 'preview-running', title: '整理季度经营数据', prompt: workflowPrompt('整理季度经营数据并生成管理层分析报告'), status: 'running', workDir: 'D:/workspace/quarter-report', createdAt: now - 28 * 60_000, startedAt: now - 25 * 60_000, completedAt: null, error: null, files: ['D:/workspace/quarter-report/clean-data.xlsx'], logs: [{ timestamp: now - 20 * 60_000, message: '数据分析助手已接单' }, { timestamp: now - 6 * 60_000, message: '已完成数据清理，正在整理报告' }], progress: 62, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-analysis', activeRunId: 'preview-run-1' },
  { id: 'preview-failed', title: '官网内容更新', prompt: workflowPrompt('更新官网产品介绍并完成发布前审核'), status: 'failed', workDir: 'D:/workspace/website', createdAt: now - 3 * 60 * 60_000, startedAt: now - 2.8 * 60 * 60_000, completedAt: now - 2.5 * 60 * 60_000, error: '输入文件不可用', files: [], logs: [{ timestamp: now - 2.5 * 60 * 60_000, message: '读取输入文件失败', level: 'error' }], progress: 34, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-research', activeRunId: null },
  { id: 'preview-delivered', title: '上周项目进展周报', prompt: workflowPrompt('整理上周项目进展并生成周报'), status: 'completed', workDir: 'D:/workspace/weekly-report', createdAt: now - 24 * 60 * 60_000, startedAt: now - 23 * 60 * 60_000, completedAt: now - 22 * 60 * 60_000, error: null, files: ['D:/workspace/weekly-report/weekly-report.docx'], logs: [{ timestamp: now - 22 * 60 * 60_000, message: '最终报告已完成' }], progress: 100, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-content', activeRunId: null },
  { id: 'preview-waiting', title: '客户续约风险清单', prompt: workflowPrompt('整理本月到期客户的续约风险清单'), status: 'waiting_approval', workDir: 'D:/workspace/renewal', createdAt: now - 50 * 60_000, startedAt: now - 46 * 60_000, completedAt: null, error: null, files: [], logs: [{ timestamp: now - 8 * 60_000, message: '清单已整理好，等你确认口径' }], progress: 70, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-support', activeRunId: null },
];

const taskListeners = new Set<(task: ClientTask) => void>();
const listListeners = new Set<(tasks: ClientTask[]) => void>();
const piListeners = new Set<(event: TaskExecutionEvent) => void>();
const notifyTask = (task: ClientTask) => { taskListeners.forEach(listener => listener(task)); listListeners.forEach(listener => listener(previewTasks)); };
const command = async () => ({ success: true });

/** 浏览器预览没有真实员工，这里按字分片假装流式回复，让界面状态可被观察。 */
function emitPi(taskId: string, type: string, data: unknown, sequence: number) {
  const event: TaskExecutionEvent = { taskId, runId: `${taskId}-run`, subscriptionId: 'preview', sequence, type, occurredAt: Date.now(), data };
  piListeners.forEach(listener => listener(event));
}

function fakeReply(taskId: string, text: string) {
  const chunks = text.match(/[\s\S]{1,6}/g) ?? [];
  chunks.forEach((chunk, index) => {
    setTimeout(() => emitPi(taskId, 'text_delta', { text: chunk }, index + 1), 180 * (index + 1));
  });
  setTimeout(() => {
    emitPi(taskId, 'agent_end', {}, chunks.length + 1);
    pushMessage(taskId, 'assistant', text);
    const task = previewTasks.find(item => item.id === taskId);
    if (task) {
      task.status = 'waiting_approval';
      task.progress = Math.min(96, (task.progress ?? 0) + 30);
      notifyTask({ ...task });
    }
  }, 180 * (chunks.length + 1));
}

const previewMessages = new Map<string, ClientTaskMessage[]>();
function pushMessage(taskId: string, role: ClientTaskMessage['role'], content: string) {
  const list = previewMessages.get(taskId) ?? [];
  list.push({ id: `${taskId}-msg-${list.length}`, role, content, createdAt: Date.now(), runId: `${taskId}-run` });
  previewMessages.set(taskId, list);
}

const previewApi: ElectronAPI = {
  login: async () => ({ success: true, data: { user: { id: 'preview-user', email: 'preview@sep.local', name: '预览账号' }, enterprise: { id: 'preview-enterprise', name: 'SEP 示例企业' } } }),
  listRememberedAccounts: async () => ({ accounts: [], encryptionAvailable: true }),
  getRememberedPassword: async () => ({ passwordAvailable: false }),
  forgetAccount: async () => ({ success: true, data: null }),
  logout: async () => ({ success: true, data: null }),
  getInstances: async () => ({ success: true, data: previewInstances }),
  createTask: async input => { const task: ClientTask = { id: `preview-${Date.now()}`, title: input.title, prompt: input.prompt, status: 'pending', workDir: input.workDir ?? null, createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [], progress: 0, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: input.subscriptionId, activeRunId: null }; previewTasks = [task, ...previewTasks]; notifyTask(task); return { success: true, task }; },
  createConversation: async input => {
    const task: ClientTask = { id: `preview-chat-${Date.now()}`, title: input.title, prompt: input.prompt, status: 'pending', workDir: input.workDir ?? null, createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [], progress: 0, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: input.subscriptionId, activeRunId: null };
    previewTasks = [task, ...previewTasks];
    pushMessage(task.id, 'user', input.prompt);
    notifyTask(task);
    return { success: true, task };
  },
  executeTask: async input => { const id = typeof input === 'string' ? input : input.taskId; const task = previewTasks.find(item => item.id === id); if (task) { task.status = 'running'; task.startedAt = Date.now(); task.progress = 18; task.logs = [...task.logs, { timestamp: Date.now(), message: '员工已接单，开始处理' }]; notifyTask({ ...task }); fakeReply(task.id, '我已经收到这项工作。我会先确认需要用到的资料，再按步骤完成，遇到需要你决定的地方会停下来问你。'); } return { success: true }; },
  continueTask: async input => {
    const task = previewTasks.find(item => item.id === input.taskId);
    if (task) {
      pushMessage(task.id, 'user', input.prompt);
      task.status = 'running';
      notifyTask({ ...task });
      fakeReply(task.id, '明白，我按你说的继续处理，完成后会把结果整理给你。');
    }
    return { success: true };
  },
  switchConversationEmployee: async input => {
    const task = previewTasks.find(item => item.id === input.taskId);
    if (task) {
      task.subscriptionId = input.subscriptionId;
      task.logs = [...task.logs, { timestamp: Date.now(), message: '已更换负责这项工作的员工' }];
      notifyTask({ ...task });
      fakeReply(task.id, '我接手了这项工作。我看到了工作目标、你已确认的资料和上一位员工的结果，可以直接继续。');
    }
    return { success: true };
  },
  getTaskMessages: async taskId => ({ success: true, messages: previewMessages.get(taskId) ?? [] }),
  retryTask: async taskId => { const task = previewTasks.find(item => item.id === taskId); if (task) { task.status = 'running'; task.error = null; notifyTask({ ...task }); } return { success: true }; },
  getTask: async taskId => ({ success: true, task: previewTasks.find(item => item.id === taskId) }),
  getAllTasks: async () => ({ success: true, tasks: previewTasks }),
  listTaskRuns: async () => ({ success: true, runs: [] }),
  getTaskRun: async () => ({ success: true }),
  getTaskTimeline: async () => ({ success: true, events: [] }),
  pauseTask: command,
  cancelTask: async taskId => { const task = previewTasks.find(item => item.id === taskId); if (task) { task.status = 'paused'; notifyTask({ ...task }); } return { success: true }; },
  deleteTask: async taskId => { previewTasks = previewTasks.filter(item => item.id !== taskId); previewMessages.delete(taskId); listListeners.forEach(listener => listener(previewTasks)); return { success: true }; },
  getTaskStats: async () => ({ success: true, stats: { total: previewTasks.length, pending: 0, running: 1, waitingApproval: 0, paused: 0, interrupted: 0, completed: 1, failed: 1 } }),
  selectDirectory: async () => ({ success: true, path: 'D:/workspace/new-plan' }),
  onPiEvent: callback => { piListeners.add(callback); return () => piListeners.delete(callback); },
  onToolApprovalRequest: () => () => undefined,
  onTaskUpdated: callback => { taskListeners.add(callback); return () => taskListeners.delete(callback); },
  onTaskListUpdated: callback => { listListeners.add(callback); return () => listListeners.delete(callback); },
  onAuthenticationRequired: () => () => undefined,
  sendToolApprovalResponse: () => undefined,
  createWorkflow: async input => {
    const value = input as { title?: string; prompt?: string; nodes?: unknown[] };
    const task: ClientTask = { id: `preview-${Date.now()}`, title: value.title || 'DAG 工作流', prompt: value.prompt || '', status: 'pending', workDir: null, createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [], progress: 0, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: previewInstances[0].id, activeRunId: null };
    previewTasks = [task, ...previewTasks]; notifyTask(task); return { success: true, task, graph: { nodes: value.nodes ?? [] } };
  },
  validateWorkflow: async data => ({ success: true, graph: data }),
  getWorkflow: async taskId => ({ success: true, task: previewTasks.find(item => item.id === taskId), graph: { nodes: [] } }),
  startWorkflow: async taskId => { const task = previewTasks.find(item => item.id === taskId); if (task) { task.status = 'running'; task.startedAt = Date.now(); task.progress = 12; task.logs = [...task.logs, { timestamp: Date.now(), message: '第一位员工开始处理第一个步骤' }]; notifyTask({ ...task }); fakeReply(task.id, '我先按第一个步骤整理需要的资料，完成后会把结果交给下一位员工。'); } return { success: true }; },
};

if (!('electronAPI' in window)) Object.defineProperty(window, 'electronAPI', { value: previewApi, configurable: true });

async function noOp(): Promise<void> {
  // Browser preview has no Electron session to log out from.
}

export function WorkspacePreviewPage() {
  return <ClientAppPage userName="预览账号" enterpriseId="preview-enterprise" enterpriseName="SEP 示例企业" instances={previewInstances} onLogout={noOp} />;
}
