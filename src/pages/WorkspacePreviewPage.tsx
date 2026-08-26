import type { ElectronAPI } from '../shared/ipc';
import type { ClientTask, EmployeeInstanceSnapshot } from '../shared/types';
import { WorkspaceHomePage } from './WorkspaceHomePage';

const now = Date.now();
const previewInstances: EmployeeInstanceSnapshot[] = [
  { id: 'preview-content', name: '运营文案助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'content', name: '内容运营', avatar: '文' }, department: { id: 'marketing', name: '市场部' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-analysis', name: '数据分析助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'analysis', name: '数据分析', avatar: '数' }, department: { id: 'data', name: '数据部' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-review', name: '交付审核助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'review', name: '审核校对', avatar: '审' }, department: { id: 'quality', name: '质量部' }, allowedModels: ['gpt-5.2'] },
];

const planSteps = [
  { id: 'step-analysis', employeeInstanceId: 'preview-analysis', title: '整理输入数据', instruction: '检查输入数据的完整性，统一关键字段并整理异常项。', expectedOutput: '清洗后的数据和异常说明' },
  { id: 'step-content', employeeInstanceId: 'preview-content', title: '形成分析报告', instruction: '根据整理结果提炼趋势和结论，形成管理层可读的报告。', expectedOutput: '结构化分析报告' },
  { id: 'step-review', employeeInstanceId: 'preview-review', title: '复核并交付', instruction: '检查数字、结论和文字表达，整理最终交付说明。', expectedOutput: '经过审核的最终报告' },
];
const workflowPrompt = (goal: string) => `[SEP_WORKFLOW_TASK]\n分析报告\n\n工作目标：\n${goal}\n\n[SEP_TASK_PLAN]\n${JSON.stringify({ goal, steps: planSteps })}`;

let previewTasks: ClientTask[] = [
  { id: 'preview-running', title: '整理季度经营数据', prompt: workflowPrompt('整理季度经营数据并生成管理层分析报告'), status: 'running', workDir: 'D:/workspace/quarter-report', createdAt: now - 28 * 60_000, startedAt: now - 25 * 60_000, completedAt: null, error: null, files: ['D:/workspace/quarter-report/clean-data.xlsx'], logs: [{ timestamp: now - 20 * 60_000, message: '数据分析助手已接单' }, { timestamp: now - 6 * 60_000, message: '已完成数据清理，正在整理报告' }], progress: 62, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', employeeInstanceId: 'preview-analysis', activeRunId: 'preview-run-1' },
  { id: 'preview-failed', title: '官网内容更新', prompt: workflowPrompt('更新官网产品介绍并完成发布前审核'), status: 'failed', workDir: 'D:/workspace/website', createdAt: now - 3 * 60 * 60_000, startedAt: now - 2.8 * 60 * 60_000, completedAt: now - 2.5 * 60 * 60_000, error: '输入文件不可用', files: [], logs: [{ timestamp: now - 2.5 * 60 * 60_000, message: '读取输入文件失败', level: 'error' }], progress: 34, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', employeeInstanceId: 'preview-content', activeRunId: null },
  { id: 'preview-delivered', title: '上周项目进展周报', prompt: workflowPrompt('整理上周项目进展并生成周报'), status: 'completed', workDir: 'D:/workspace/weekly-report', createdAt: now - 24 * 60 * 60_000, startedAt: now - 23 * 60 * 60_000, completedAt: now - 22 * 60 * 60_000, error: null, files: ['D:/workspace/weekly-report/weekly-report.docx'], logs: [{ timestamp: now - 22 * 60 * 60_000, message: '最终报告已完成' }], progress: 100, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', employeeInstanceId: 'preview-content', activeRunId: null },
];

const taskListeners = new Set<(task: ClientTask) => void>();
const listListeners = new Set<(tasks: ClientTask[]) => void>();
const notifyTask = (task: ClientTask) => { taskListeners.forEach(listener => listener(task)); listListeners.forEach(listener => listener(previewTasks)); };
const command = async () => ({ success: true });

const previewApi: ElectronAPI = {
  login: async () => ({ success: true, data: { user: { id: 'preview-user', email: 'preview@sep.local', name: '预览账号' }, enterprise: { id: 'preview-enterprise', name: 'SEP 示例企业' } } }),
  listRememberedAccounts: async () => ({ accounts: [], encryptionAvailable: true }),
  getRememberedPassword: async () => ({ passwordAvailable: false }),
  forgetAccount: async () => ({ success: true, data: null }),
  logout: async () => ({ success: true, data: null }),
  getInstances: async () => ({ success: true, data: previewInstances }),
  createTask: async input => { const task: ClientTask = { id: `preview-${Date.now()}`, title: input.title, prompt: input.prompt, status: 'pending', workDir: input.workDir ?? null, createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [], progress: 0, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', employeeInstanceId: input.employeeInstanceId, activeRunId: null }; previewTasks = [task, ...previewTasks]; notifyTask(task); return { success: true, task }; },
  executeTask: async input => { const id = typeof input === 'string' ? input : input.taskId; const task = previewTasks.find(item => item.id === id); if (task) { task.status = 'running'; task.startedAt = Date.now(); task.progress = 18; task.logs = [...task.logs, { timestamp: Date.now(), message: '首位员工已接单' }]; notifyTask({ ...task }); } return { success: true }; },
  continueTask: command,
  getTaskMessages: async () => ({ success: true, messages: [] }),
  retryTask: async taskId => { const task = previewTasks.find(item => item.id === taskId); if (task) { task.status = 'running'; task.error = null; notifyTask({ ...task }); } return { success: true }; },
  getTask: async taskId => ({ success: true, task: previewTasks.find(item => item.id === taskId) }),
  getAllTasks: async () => ({ success: true, tasks: previewTasks }),
  listTaskRuns: async () => ({ success: true, runs: [] }),
  getTaskRun: async () => ({ success: true }),
  getTaskTimeline: async () => ({ success: true, events: [] }),
  pauseTask: command,
  cancelTask: async taskId => { const task = previewTasks.find(item => item.id === taskId); if (task) { task.status = 'paused'; notifyTask({ ...task }); } return { success: true }; },
  deleteTask: command,
  getTaskStats: async () => ({ success: true, stats: { total: previewTasks.length, pending: 0, running: 1, waitingApproval: 0, paused: 0, interrupted: 0, completed: 1, failed: 1 } }),
  selectDirectory: async () => ({ success: true, path: 'D:/workspace/new-plan' }),
  onPiEvent: () => () => undefined,
  onToolApprovalRequest: () => () => undefined,
  onTaskUpdated: callback => { taskListeners.add(callback); return () => taskListeners.delete(callback); },
  onTaskListUpdated: callback => { listListeners.add(callback); return () => listListeners.delete(callback); },
  onAuthenticationRequired: () => () => undefined,
  sendToolApprovalResponse: () => undefined,
  createWorkflow: async input => {
    const value = input as { title?: string; prompt?: string; nodes?: unknown[] };
    const task: ClientTask = { id: `preview-${Date.now()}`, title: value.title || 'DAG 工作流', prompt: value.prompt || '', status: 'pending', workDir: null, createdAt: Date.now(), startedAt: null, completedAt: null, error: null, files: [], logs: [], progress: 0, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', employeeInstanceId: previewInstances[0].id, activeRunId: null };
    previewTasks = [task, ...previewTasks]; notifyTask(task); return { success: true, task, graph: { nodes: value.nodes ?? [] } };
  },
  validateWorkflow: async data => ({ success: true, graph: data }),
  getWorkflow: async taskId => ({ success: true, task: previewTasks.find(item => item.id === taskId), graph: { nodes: [] } }),
  startWorkflow: async taskId => { const task = previewTasks.find(item => item.id === taskId); if (task) { task.status = 'running'; task.progress = 12; notifyTask({ ...task }); } return { success: true }; },
};

if (!('electronAPI' in window)) Object.defineProperty(window, 'electronAPI', { value: previewApi, configurable: true });

async function noOp(): Promise<void> {
  // Browser preview has no Electron session to log out from.
}

export function WorkspacePreviewPage() {
  return <WorkspaceHomePage userName="预览账号" enterpriseName="SEP 示例企业" instances={previewInstances} onLogout={noOp} />;
}
