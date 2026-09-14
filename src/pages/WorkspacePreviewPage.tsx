import type { ElectronAPI } from '../shared/ipc';

const previewArrangement = {
  getArrangementPlan: async (taskId: string) => ({ success: true, plan: previewPlans[taskId] ?? null }),
  listArrangementDrafts: async () => ({ success: true, drafts: [...previewDrafts.values()] }),
  createArrangementDraft: async (input: unknown) => {
    const draft = { id: 'preview-arr-' + Date.now(), revision: 1, input: normalizePreviewDraft(input) };
    previewDrafts.set(draft.id, draft);
    return { success: true, draft };
  },
  getArrangementDraft: async (draftId: string) => ({ success: true, draft: previewDrafts.get(draftId) }),
  updateArrangementDraft: async (input: unknown) => ({ success: true, draft: updatePreviewDraft(input) }),
  deleteArrangementDraft: async (draftId: string) => ({ success: true, deleted: previewDrafts.delete(draftId) }),
  validateArrangementDraft: async (draftId: string) => {
    const draft = previewDrafts.get(draftId);
    return { success: true, validation: { valid: Boolean(draft), issues: draft ? [] : ['draft-not-found'], revision: draft?.revision ?? 0 } };
  },
  preflightArrangementDraft: async (input: unknown) => ({ success: true, preflight: preflightPreviewDraft(input) }),
  confirmArrangementDraft: async (input: unknown) => startPreviewArrangement(input, false),
  confirmAndStartArrangement: async (input: unknown) => startPreviewArrangement(input, true),
  getArrangementContext: async () => ({ success: true }),
};
import type { ArrangementPlanSnapshot, ClientTask, ClientTaskMessage, Subscription, TaskExecutionEvent } from '../shared/types';
import { ClientAppPage } from './ClientAppPage';

const now = Date.now();
/**
 * 预览里放十四位员工：宽窗口下首页一屏能铺六列（十二张），必须比它多才看得出
 * 员工墙成环之后的样子 —— 两侧被裁掉的那一列、左右两个箭头、右上角的可用人数。
 * 前六位挂着真实的工作，用来看状态标签和提醒气泡；后面几位只占位置。
 */
const previewInstances: Subscription[] = [
  { id: 'preview-content', name: '运营文案助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'content', name: '内容运营', avatar: '文' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-analysis', name: '数据分析助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'analysis', name: '数据分析', avatar: '数' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-review', name: '交付审核助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'review', name: '审核校对', avatar: '审' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-support', name: '客户支持助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'support', name: '客户支持', avatar: '客' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-research', name: '市场调研助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'research', name: '市场调研', avatar: '研' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-design', name: '设计助理', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'design', name: '视觉设计', avatar: '设' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-ops', name: '流程运维助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'ops', name: '流程运维', avatar: '运' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-hr', name: '招聘协助员', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'hr', name: '人力协助', avatar: '人' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-finance', name: '财务对账助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'finance', name: '财务对账', avatar: '财' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-legal', name: '合同审阅助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'legal', name: '合同审阅', avatar: '法' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-sales', name: '销售线索助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'sales', name: '销售支持', avatar: '销' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-training', name: '培训编写助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'training', name: '培训编写', avatar: '培' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-translate', name: '文档翻译助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'translate', name: '文档翻译', avatar: '译' }, allowedModels: ['gpt-5.2'] },
  { id: 'preview-qa', name: '测试用例助手', status: 'ACTIVE', templateVersion: '1.0.0', template: { id: 'qa', name: '质量测试', avatar: '测' }, allowedModels: ['gpt-5.2'] },
];

const planSteps: ArrangementPlanSnapshot['nodes'] = [
  { id: 'step-analysis', subscriptionId: 'preview-analysis', modelId: 'gpt-5.2', title: '整理输入数据', instruction: '检查输入数据的完整性，统一关键字段并整理异常项。', expectedOutput: '清洗后的数据和异常说明', dependsOn: [], skillIds: [], requiresUserConfirmation: false },
  { id: 'step-content', subscriptionId: 'preview-content', modelId: 'gpt-5.2', title: '形成分析报告', instruction: '根据整理结果提炼趋势和结论，形成管理层可读的报告。', expectedOutput: '结构化分析报告', dependsOn: ['step-analysis'], skillIds: [], requiresUserConfirmation: false },
  { id: 'step-review', subscriptionId: 'preview-review', modelId: 'gpt-5.2', title: '复核并交付', instruction: '检查数字、结论和文字表达，整理最终交付说明。', expectedOutput: '经过审核的最终报告', dependsOn: ['step-content'], skillIds: [], requiresUserConfirmation: true },
];
const plainPrompt = (goal: string) => goal;

/**
 * 预览用的多人安排。详情页从安排方案读取参与员工和步骤。
 */
const teamNodes: ArrangementPlanSnapshot['nodes'] = [
  { id: 'step-1', subscriptionId: 'preview-research', modelId: 'gpt-5.2', title: '收集竞品活动资料', instruction: '活动周期与竞品名单', expectedOutput: '竞品活动资料汇总', dependsOn: [], skillIds: [], requiresUserConfirmation: false },
  { id: 'step-2', subscriptionId: 'preview-analysis', modelId: 'gpt-5.2', title: '分析活动转化率', instruction: '竞品资料与本次活动数据', expectedOutput: '转化率分析结果', dependsOn: ['step-1'], skillIds: [], requiresUserConfirmation: false },
  { id: 'step-3', subscriptionId: 'preview-content', modelId: 'gpt-5.2', title: '生成活动复盘报告', instruction: '转化率分析结果', expectedOutput: '618 活动复盘报告', dependsOn: ['step-2'], skillIds: [], requiresUserConfirmation: true },
];
const teamPrompt = (goal: string) => plainPrompt(goal);

/**
 * 对话式工作。工作详情页抬头右边那颗主按钮按类型分岔：这一类是「继续对话」，
 * 上面的编排工作是「改一版安排」，所以预览里两类都得有。
 */
const chatPrompt = (goal: string) => plainPrompt(goal);

let previewTasks: ClientTask[] = [
  { id: 'preview-chat', title: '客户反馈整理成改进清单', prompt: chatPrompt('把这个季度收到的客户反馈整理成一份可执行的改进清单'), status: 'running', workDir: 'D:/workspace/feedback', createdAt: now - 42 * 60_000, startedAt: now - 40 * 60_000, completedAt: null, error: null, files: [], logs: [{ timestamp: now - 40 * 60_000, message: '运营文案助手已接单' }, { timestamp: now - 9 * 60_000, message: '已按主题归好类，正在写改进建议' }], progress: 55, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-content', activeRunId: 'preview-run-chat' },
  { id: 'preview-team', title: '618 活动复盘报告', prompt: teamPrompt('复盘 618 活动的投放与转化，产出可交付的复盘报告'), status: 'running', workDir: 'D:/workspace/618-analysis', createdAt: now - 136 * 60_000, startedAt: now - 130 * 60_000, completedAt: null, error: null, files: ['D:/workspace/618-analysis/活动数据分析.xlsx', 'D:/workspace/618-analysis/关键结论汇总.pptx'], logs: [{ timestamp: now - 130 * 60_000, message: '市场调研助手已接单' }, { timestamp: now - 96 * 60_000, message: '整理竞品活动资料' }, { timestamp: now - 74 * 60_000, message: '读取 12 个数据文件' }, { timestamp: now - 38 * 60_000, message: '完成数据清洗' }, { timestamp: now - 12 * 60_000, message: '正在分析活动转化率' }], progress: 72, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-analysis', activeRunId: 'preview-run-0' },
  { id: 'preview-running', title: '整理季度经营数据', prompt: plainPrompt('整理季度经营数据并生成管理层分析报告'), status: 'running', workDir: 'D:/workspace/quarter-report', createdAt: now - 28 * 60_000, startedAt: now - 25 * 60_000, completedAt: null, error: null, files: ['D:/workspace/quarter-report/clean-data.xlsx'], logs: [{ timestamp: now - 20 * 60_000, message: '数据分析助手已接单' }, { timestamp: now - 6 * 60_000, message: '已完成数据清理，正在整理报告' }], progress: 62, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-analysis', activeRunId: 'preview-run-1' },
  { id: 'preview-failed', title: '官网内容更新', prompt: plainPrompt('更新官网产品介绍并完成发布前审核'), status: 'failed', workDir: 'D:/workspace/website', createdAt: now - 3 * 60 * 60_000, startedAt: now - 2.8 * 60 * 60_000, completedAt: now - 2.5 * 60 * 60_000, error: '输入文件不可用', files: [], logs: [{ timestamp: now - 2.5 * 60 * 60_000, message: '读取输入文件失败', level: 'error' }], progress: 34, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-research', activeRunId: null },
  { id: 'preview-delivered', title: '上周项目进展周报', prompt: plainPrompt('整理上周项目进展并生成周报'), status: 'completed', workDir: 'D:/workspace/weekly-report', createdAt: now - 3 * 60 * 60_000, startedAt: now - 2.9 * 60 * 60_000, completedAt: now - 2.2 * 60 * 60_000, error: null, files: ['D:/workspace/weekly-report/weekly-report.docx'], logs: [{ timestamp: now - 2.2 * 60 * 60_000, message: '最终报告已完成' }], progress: 100, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-content', activeRunId: null },
  { id: 'preview-waiting', title: '客户续约风险清单', prompt: plainPrompt('整理本月到期客户的续约风险清单'), status: 'waiting_approval', workDir: 'D:/workspace/renewal', createdAt: now - 50 * 60_000, startedAt: now - 46 * 60_000, completedAt: null, error: null, files: [], logs: [{ timestamp: now - 8 * 60_000, message: '清单已整理好，等你确认口径' }], progress: 70, ownerId: 'preview-user', ownerEnterpriseId: 'preview-enterprise', subscriptionId: 'preview-support', activeRunId: null },
];

const previewPlans: Record<string, ArrangementPlanSnapshot> = {};
interface PreviewDraftInput {
  mode: ArrangementPlanSnapshot['mode'];
  title: string;
  goal: string;
  confirmedInputs: string[];
  sharedSkillIds: string[];
  conversation: ArrangementPlanSnapshot['conversation'];
  nodes: ArrangementPlanSnapshot['nodes'];
  workspace: { mode: 'shared'; path: string | null };
  permissions: {
    preset: ArrangementPlanSnapshot['permissions']['preset'];
    allowWithoutApproval: boolean;
  };
}

interface PreviewDraftRecord {
  id: string;
  revision: number;
  input: PreviewDraftInput;
}

const previewDrafts = new Map<string, PreviewDraftRecord>();
const previewPermission = {
  preset: 'read-only' as const,
  allowedTools: ['read', 'grep', 'find', 'ls'],
  allowedPaths: [],
  deniedPaths: [],
  requireApprovalFor: ['write', 'edit', 'bash'],
  commandPolicy: 'disabled' as const,
  approvalMode: 'confirm-each' as const,
};

function recordOf(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
}

function stringsOf(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((value): value is string => typeof value === 'string') : [];
}

function normalizePreviewNode(input: unknown, index: number): ArrangementPlanSnapshot['nodes'][number] | null {
  const value = recordOf(input);
  if (typeof value.subscriptionId !== 'string' || typeof value.modelId !== 'string') return null;
  const title = typeof value.title === 'string' ? value.title : `第 ${index + 1} 步`;
  return {
    id: typeof value.id === 'string' ? value.id : `preview-step-${index + 1}`,
    subscriptionId: value.subscriptionId,
    modelId: value.modelId,
    title,
    instruction: typeof value.instruction === 'string' ? value.instruction : title,
    expectedOutput: typeof value.expectedOutput === 'string' ? value.expectedOutput : title,
    dependsOn: stringsOf(value.dependsOn),
    skillIds: stringsOf(value.skillIds),
    requiresUserConfirmation: value.requiresUserConfirmation === true,
  };
}

function normalizePreviewDraft(input: unknown): PreviewDraftInput {
  const value = recordOf(input);
  const mode = value.mode === 'conversation' || value.mode === 'auto' || value.mode === 'manual' ? value.mode : 'manual';
  const rawConversation = recordOf(value.conversation);
  const participants = Array.isArray(rawConversation.participants)
    ? rawConversation.participants.flatMap(participant => {
        const item = recordOf(participant);
        return typeof item.subscriptionId === 'string' && typeof item.modelId === 'string'
          ? [{ subscriptionId: item.subscriptionId, modelId: item.modelId }]
          : [];
      })
    : [];
  const rawWorkspace = recordOf(value.workspace);
  const rawPermissions = recordOf(value.permissions);
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.flatMap((node, index) => {
        const normalized = normalizePreviewNode(node, index);
        return normalized ? [normalized] : [];
      })
    : [];
  const activeSubscriptionId = typeof rawConversation.activeSubscriptionId === 'string'
    ? rawConversation.activeSubscriptionId
    : null;

  return {
    mode,
    title: typeof value.title === 'string' ? value.title : '未命名安排',
    goal: typeof value.goal === 'string' ? value.goal : '',
    confirmedInputs: stringsOf(value.confirmedInputs),
    sharedSkillIds: stringsOf(value.sharedSkillIds),
    conversation: mode === 'conversation' ? { participants, activeSubscriptionId } : null,
    nodes,
    workspace: {
      mode: 'shared',
      path: typeof rawWorkspace.path === 'string' && rawWorkspace.path.trim() ? rawWorkspace.path : null,
    },
    permissions: {
      preset: rawPermissions.preset === 'workspace-edit' || rawPermissions.preset === 'full-local' ? rawPermissions.preset : 'read-only',
      allowWithoutApproval: rawPermissions.allowWithoutApproval === true,
    },
  };
}

function updatePreviewDraft(input: unknown): PreviewDraftRecord | undefined {
  const value = recordOf(input);
  const draftId = typeof value.draftId === 'string' ? value.draftId : '';
  const current = previewDrafts.get(draftId);
  if (!current || value.expectedRevision !== current.revision) return undefined;
  const next: PreviewDraftRecord = {
    id: current.id,
    revision: current.revision + 1,
    input: normalizePreviewDraft(value.document),
  };
  previewDrafts.set(draftId, next);
  return next;
}

function permissionForPreview(input: PreviewDraftInput['permissions']): ArrangementPlanSnapshot['permissions'] {
  const allowedTools = input.preset === 'read-only'
    ? ['read', 'grep', 'find', 'ls']
    : input.preset === 'workspace-edit'
      ? ['read', 'grep', 'find', 'ls', 'write', 'edit']
      : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'];
  return {
    preset: input.preset,
    allowedTools,
    allowedPaths: [],
    deniedPaths: [],
    requireApprovalFor: ['write', 'edit', 'bash'],
    commandPolicy: input.preset === 'full-local' ? 'confirm-each' : 'disabled',
    approvalMode: input.allowWithoutApproval ? 'auto-approve' : 'confirm-each',
  };
}

function preflightPreviewDraft(input: unknown): Record<string, unknown> {
  const value = recordOf(input);
  const draft = typeof value.draftId === 'string' ? previewDrafts.get(value.draftId) : undefined;
  const valid = Boolean(draft && value.expectedRevision === draft.revision);
  return {
    preflightId: 'preview-preflight-' + Date.now(),
    draftId: typeof value.draftId === 'string' ? value.draftId : '',
    draftRevision: draft?.revision ?? 0,
    valid,
    canStart: valid,
    subscriptions: [],
    modelIssues: [],
    permissionPolicy: draft ? permissionForPreview(draft.input.permissions) : null,
    blockingIssues: valid ? [] : ['draft-not-found-or-stale'],
    checkedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function makePreviewPlan(
  id: string,
  mode: ArrangementPlanSnapshot['mode'],
  title: string,
  goal: string,
  nodes: ArrangementPlanSnapshot['nodes'],
  workDir: string,
  activeSubscriptionId: string | null,
  confirmedInputs: string[] = [],
  permissions: ArrangementPlanSnapshot['permissions'] = previewPermission,
): ArrangementPlanSnapshot {
  return {
    id,
    schemaVersion: 1,
    sourceDraftId: 'preview-draft-' + id,
    sourceDraftRevision: 1,
    owner: { memberId: 'preview-user', enterpriseId: 'preview-enterprise' },
    mode,
    title,
    goal,
    conversation: mode === 'conversation'
      ? { participants: [{ subscriptionId: activeSubscriptionId ?? 'preview-content', modelId: 'gpt-5.2' }], activeSubscriptionId }
      : null,
    nodes: nodes.map(node => ({ ...node, dependsOn: [...node.dependsOn], skillIds: [...node.skillIds] })),
    workspace: { mode: 'shared', path: workDir },
    permissions: { ...permissions, allowedTools: [...permissions.allowedTools], requireApprovalFor: [...permissions.requireApprovalFor] },
    confirmedInputs: [...confirmedInputs],
    planHash: 'preview-plan-' + id,
    createdAt: now,
  };
}

const previewTaskById = new Map(previewTasks.map(task => [task.id, task]));
previewTaskById.forEach(task => {
  if (task.id === 'preview-chat') {
    previewPlans[task.id] = makePreviewPlan(task.id, 'conversation', task.title, task.prompt, [], task.workDir ?? '', task.subscriptionId ?? null);
    return;
  }
  const nodes = task.id === 'preview-team' ? teamNodes : planSteps;
  previewPlans[task.id] = makePreviewPlan(task.id, 'manual', task.title, task.prompt, nodes, task.workDir ?? '', null, task.id === 'preview-team' ? ['活动数据在「运营/618」文件夹', '上季度复盘可作为格式参考'] : []);
});

const taskListeners = new Set<(task: ClientTask) => void>();
const listListeners = new Set<(tasks: ClientTask[]) => void>();
const piListeners = new Set<(event: TaskExecutionEvent) => void>();
const notifyTask = (task: ClientTask) => { taskListeners.forEach(listener => listener(task)); listListeners.forEach(listener => listener(previewTasks)); };
const command = async () => ({ success: true });

function startPreviewArrangement(input: unknown, start: boolean) {
  const value = recordOf(input);
  const draftId = typeof value.draftId === 'string' ? value.draftId : '';
  const expectedRevision = typeof value.expectedRevision === 'number' ? value.expectedRevision : 0;
  const draft = previewDrafts.get(draftId);
  if (!draft || draft.revision !== expectedRevision) {
    return { success: false, error: { message: '安排草稿不存在或已经过期' } };
  }

  const document = draft.input;
  const primarySubscriptionId = document.mode === 'conversation'
    ? document.conversation?.participants[0]?.subscriptionId
    : document.nodes[0]?.subscriptionId;
  if (!primarySubscriptionId) return { success: false, error: { message: '预览安排缺少参与员工' } };

  const taskId = `preview-arr-task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const task: ClientTask = {
    id: taskId,
    title: document.title || document.goal,
    prompt: document.goal,
    status: start ? 'running' : 'pending',
    workDir: document.workspace.path,
    createdAt: startedAt,
    startedAt: start ? startedAt : null,
    completedAt: null,
    error: null,
    files: [],
    logs: start ? [{ timestamp: startedAt, message: '安排已确认，员工开始处理' }] : [],
    progress: start ? 12 : 0,
    ownerId: 'preview-user',
    ownerEnterpriseId: 'preview-enterprise',
    subscriptionId: primarySubscriptionId,
    activeRunId: start ? `${taskId}-run` : null,
  };
  const plan = makePreviewPlan(
    taskId,
    document.mode,
    task.title,
    document.goal,
    document.nodes,
    document.workspace.path ?? '',
    document.conversation?.activeSubscriptionId ?? null,
    document.confirmedInputs,
    permissionForPreview(document.permissions),
  );
  previewPlans[taskId] = plan;
  previewTasks = [task, ...previewTasks];
  notifyTask({ ...task });

  if (start && document.mode === 'conversation') {
    pushMessage(taskId, 'user', document.goal);
    fakeReply(taskId, '我已经收到这项安排，会和你选中的员工共享上下文，接下来按你的目标继续处理。');
  }

  return {
    success: true,
    plan,
    execution: start ? { id: taskId, status: 'queued' as const } : null,
  };
}

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

// 对话式工作要有几句话才看得出对话抽屉长什么样：气泡左右分列、员工那一侧带头像。
pushMessage('preview-chat', 'user', '把这个季度收到的客户反馈整理成一份可执行的改进清单，按影响面排序。');
pushMessage('preview-chat', 'assistant', '我先把反馈按主题归类，一共分出六类：交付时效、沟通节奏、报告可读性、价格、功能缺口、售后响应。其中交付时效和沟通节奏出现得最多。\n\n接下来我按「影响多少客户 × 我们改起来的成本」排一遍，再给每一类写两三条具体的改进动作。');
pushMessage('preview-chat', 'user', '价格这一类先不用管，那不是我们能决定的。');
pushMessage('preview-chat', 'assistant', '好，价格那一类我从清单里去掉，只在附录里留一句「已收到相关反馈」备查。现在按剩下五类写改进动作。');

const previewApi: ElectronAPI = {
  login: async () => ({ success: true, data: { user: { id: 'preview-user', email: 'preview@sep.local', name: '预览账号' }, enterprise: { id: 'preview-enterprise', name: 'SEP 示例企业' } } }),
  listRememberedAccounts: async () => ({ accounts: [], encryptionAvailable: true }),
  getRememberedPassword: async () => ({ passwordAvailable: false }),
  forgetAccount: async () => ({ success: true, data: null }),
  logout: async () => ({ success: true, data: null }),
  getSubscriptions: async () => ({ success: true, data: previewInstances }),
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
  selectDirectory: async () => ({ success: false, path: null, error: { message: '预览模式请手动输入工作目录；正式客户端将打开系统文件夹选择器' } }),
  onPiEvent: callback => { piListeners.add(callback); return () => piListeners.delete(callback); },
  onToolApprovalRequest: () => () => undefined,
  onTaskUpdated: callback => { taskListeners.add(callback); return () => taskListeners.delete(callback); },
  onTaskListUpdated: callback => { listListeners.add(callback); return () => listListeners.delete(callback); },
  onAuthenticationRequired: () => () => undefined,
  sendToolApprovalResponse: () => undefined,
  ...previewArrangement,
};

if (!('electronAPI' in window)) Object.defineProperty(window, 'electronAPI', { value: previewApi, configurable: true });

async function noOp(): Promise<void> {
  // Browser preview has no Electron session to log out from.
}

export function WorkspacePreviewPage() {
  return <ClientAppPage userName="预览账号" enterpriseId="preview-enterprise" enterpriseName="SEP 示例企业" instances={previewInstances} onLogout={noOp} />;
}

