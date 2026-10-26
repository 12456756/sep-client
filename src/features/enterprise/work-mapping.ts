/**
 * WorkItem ↔ ClientTask 的双向映射。
 *
 * 平台暂无「工作」这一层结构，本地 TaskManager 只保存标题、prompt、状态和文件。
 * 所以业务字段（目标、步骤、参与员工、共享背景）以一行 JSON 附在 prompt 末尾。
 * 后端补上工作结构后，把 encode/decode 换成真实字段读写即可，页面不受影响。
 */

import { runtimeKey } from '../../shared/work-activity';
import type { ArrangementExecutionSnapshot, ArrangementFinalFileSnapshot, ArrangementPlanSnapshot, TaskExecutionEvent, ClientTask, ClientTaskMessage } from '../../shared/types';
import type {
  SharedContext,
  WorkActivity,
  SiliconEmployee,
  WorkItem,
  WorkMessage,
  WorkStatus,
  WorkStep,
  WorkStepState,
  WorkTimelineEntry,
  WorkDeliverable,
} from './types';

const META_MARKER = '[SEP_WORK_META]';
/** 旧版流程任务使用的标记，仅用于识别历史数据的类型。 */
const LEGACY_WORKFLOW_MARKER = '[SEP_WORKFLOW_TASK]';
/** 旧版流程任务把步骤计划以 JSON 附在这个标记之后，界面上一律不展示。 */
const LEGACY_PLAN_MARKER = '[SEP_TASK_PLAN]';

export interface WorkMeta {
  kind: 'conversation' | 'flow';
  goal: string;
  templateId?: string;
  steps: Omit<WorkStep, 'state' | 'employeeName'>[];
  participants: string[];
  sharedContext: SharedContext;
  stopReason?: string | null;
}

/** 把业务信息编码进 prompt。正文部分仍是给员工看的自然语言。 */
export function encodeWorkPrompt(title: string, meta: WorkMeta): string {
  const lines = [title, '', '工作目标：', meta.goal];
  if (meta.steps.length) {
    lines.push('', '工作步骤：');
    meta.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title}`);
      if (step.input) lines.push(`   需要：${step.input}`);
      if (step.output) lines.push(`   产出：${step.output}`);
    });
  }
  if (meta.sharedContext.confirmedInputs.length) {
    lines.push('', '已确认的资料：', ...meta.sharedContext.confirmedInputs.map(item => `- ${item}`));
  }
  return `${lines.join('\n')}\n\n${META_MARKER}${JSON.stringify(meta)}`;
}

/**
 * prompt 中给用户看的部分：去掉全部编码标记与随附的 JSON。
 * 界面上永远不应该出现 [SEP_...] 这类技术标记，历史数据也一样。
 */
export function stripWorkMeta(prompt: string): string {
  let text = prompt;
  for (const marker of [META_MARKER, LEGACY_PLAN_MARKER]) {
    const index = text.indexOf(marker);
    if (index !== -1) text = text.slice(0, index);
  }
  return text.split(LEGACY_WORKFLOW_MARKER).join('').trim();
}

/** 用户可读的工作目标。旧版任务把目标写在「工作目标：」段落里，优先取它。 */
export function readableGoal(prompt: string): string {
  const text = stripWorkMeta(prompt);
  const section = /工作目标[:：]\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(text);
  return section?.[1].trim() || text;
}

export function decodeWorkMeta(prompt: string): WorkMeta | null {
  const index = prompt.indexOf(META_MARKER);
  if (index === -1) return null;
  const payload = prompt.slice(index + META_MARKER.length).trim().split('\n')[0];
  try {
    const parsed = JSON.parse(payload) as Partial<WorkMeta>;
    if (parsed.kind !== 'conversation' && parsed.kind !== 'flow') return null;
    return {
      kind: parsed.kind,
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      templateId: typeof parsed.templateId === 'string' ? parsed.templateId : undefined,
      steps: normalizeSteps(parsed.steps),
      participants: Array.isArray(parsed.participants) ? parsed.participants.filter(item => typeof item === 'string') : [],
      sharedContext: normalizeContext(parsed.sharedContext),
      stopReason: typeof parsed.stopReason === 'string' ? parsed.stopReason : null,
    };
  } catch {
    return null;
  }
}

/**
 * 步骤反序列化。老工作的步骤只有 inheritPrevious（单亲链），
 * 这里按「依赖上一步」还原成依赖图 —— 不转换的话历史工作的步骤清单会全部断链。
 */
function normalizeSteps(raw: unknown): Omit<WorkStep, 'state' | 'employeeName'>[] {
  if (!Array.isArray(raw)) return [];
  const out: Omit<WorkStep, 'state' | 'employeeName'>[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    if (typeof source.id !== 'string' || typeof source.employeeId !== 'string' || typeof source.title !== 'string') continue;
    const previous = out[out.length - 1];
    out.push({
      id: source.id,
      employeeId: source.employeeId,
      title: source.title,
      input: typeof source.input === 'string' ? source.input : '',
      output: typeof source.output === 'string' ? source.output : '',
      dependsOn: Array.isArray(source.dependsOn)
        ? source.dependsOn.filter((dep): dep is string => typeof dep === 'string')
        : source.inheritPrevious && previous ? [previous.id] : [],
      needsConfirm: source.needsConfirm === true,
    });
  }
  return out;
}

function normalizeContext(value: unknown): SharedContext {
  const source = (value ?? {}) as Partial<SharedContext>;
  const list = (input: unknown) => (Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []);
  return {
    goal: typeof source.goal === 'string' ? source.goal : '',
    confirmedInputs: list(source.confirmedInputs),
    previousResults: list(source.previousResults),
    userNotes: list(source.userNotes),
  };
}

// ─────────────────────────────── 状态映射 ───────────────────────────────

export function toWorkStatus(status: ClientTask['status']): WorkStatus {
  switch (status) {
    case 'pending': return 'arranging';
    case 'running': return 'running';
    case 'waiting_approval': return 'waiting-user';
    case 'paused': return 'paused';
    case 'interrupted': return 'paused';
    case 'completed': return 'completed';
    default: return 'failed';
  }
}

/**
 * 步骤状态由整体状态与进度推导。平台补上按步骤上报后应改为直接读取。
 * 规则：已完成的步骤在前，当前步骤继承工作状态，其后为等待开始。
 */
function deriveStepStates(count: number, status: WorkStatus, progress: number): WorkStepState[] {
  if (!count) return [];
  if (status === 'completed') return Array.from({ length: count }, () => 'done');
  if (status === 'arranging') return Array.from({ length: count }, () => 'pending');
  const done = Math.min(count - 1, Math.max(0, Math.floor((progress / 100) * count)));
  const current: WorkStepState = status === 'running' ? 'running'
    : status === 'waiting-user' ? 'waiting-user'
    : status === 'failed' ? 'failed'
    : 'pending';
  return Array.from({ length: count }, (_, index) => (index < done ? 'done' : index === done ? current : 'pending'));
}

export function completedStepCount(steps: WorkStep[]): number {
  return steps.filter(step => step.state === 'done').length;
}

function nextUserAction(status: WorkStatus, steps: WorkStep[]): string | null {
  if (status === 'waiting-user') {
    const current = steps.find(step => step.state === 'waiting-user');
    return current ? `确认「${current.title}」的结果后继续` : '确认当前结果后继续';
  }
  if (status === 'failed') return '查看启动或中断原因，决定重试或换其他员工';
  if (status === 'arranging') return '检查安排并开始工作';
  return null;
}

// ─────────────────────────────── 组装 WorkItem ───────────────────────────────

interface BuildInput {
  plan?: ArrangementPlanSnapshot;
  arrangementEvents?: TaskExecutionEvent[];
  task: ClientTask;
  employees: SiliconEmployee[];
  messages?: ClientTaskMessage[];
  /** 正在流式输出的文本，按 taskId 传入。 */
  streamingText?: string;
  streamingRunId?: string;
  activities?: WorkActivity[];
  arrangementExecution?: ArrangementExecutionSnapshot | null;
  /** 当前活跃员工，切换员工后由本地状态覆盖任务上的订阅。 */
  activeEmployeeId?: string;
}

export function buildWorkItem({ task, employees, messages, streamingText, streamingRunId, activities = [], activeEmployeeId, plan, arrangementEvents = [], arrangementExecution }: BuildInput): WorkItem {
  const legacyMeta = decodeWorkMeta(task.prompt);
  const workType: WorkItem['workType'] = task.workType ?? { state: 'loading' };
  const resolvedKind = workType.state === 'resolved' ? workType.kind : null;
  const meta: WorkMeta | null = plan && plan.mode !== 'conversation' ? {
    kind: 'flow', goal: plan.goal,
    steps: plan.nodes.map(node => ({ id: node.id, employeeId: node.subscriptionId, title: node.title,
      input: node.instruction, output: node.expectedOutput, dependsOn: [...node.dependsOn], needsConfirm: false })),
    participants: [...new Set(plan.nodes.map(node => node.subscriptionId))],
    sharedContext: { goal: plan.goal, confirmedInputs: [...plan.confirmedInputs], previousResults: [], userNotes: [] },
  } : legacyMeta;
  const kind: 'conversation' | 'flow' = resolvedKind === 'arrangement'
    ? 'flow'
    : resolvedKind === 'conversation'
      ? 'conversation'
      : meta?.kind ?? (task.prompt.startsWith(LEGACY_WORKFLOW_MARKER) ? 'flow' : 'conversation');
  const effectiveExecution = executionFromEvents(plan, arrangementEvents, arrangementExecution);
  let status = toWorkStatus(task.status);
  if ((task.status === 'running' || task.status === 'waiting_approval') && task.activeRunId === null) status = 'arranging';
  if (task.status === 'pending' && task.executionHealth === 'start-failed') status = 'failed';
  if (plan && plan.mode !== 'conversation' && task.status === 'paused') {
    const latestState = [...arrangementEvents].reverse().find(event => event.type === 'arrangement_state_changed' || event.type === 'stop_requested');
    if (latestState?.type !== 'stop_requested' && effectiveExecution?.status === 'waiting-user') {
      status = effectiveExecution.nodes.some(node => node.pendingConfirmation) ? 'waiting-user' : 'failed';
    }
  }
  const legacyProgress = task.status === 'pending' && task.activeRunId === null
    ? 0
    : task.progress ?? (status === 'completed' ? 100 : 0);
  const nameOf = (id: string | null | undefined) => employees.find(item => item.id === id)?.name ?? '硅基员工';

  const stepStates = deriveStepStates(meta?.steps.length ?? 0, status, legacyProgress);
  const steps: WorkStep[] = (meta?.steps ?? []).map((step, index) => ({
    ...step,
    employeeName: nameOf(step.employeeId),
    state: plan && plan.mode !== 'conversation' ? arrangementStepState(step.id, status, arrangementEvents, effectiveExecution) : stepStates[index],
  }));

  const progress = plan && plan.mode !== 'conversation' && steps.length
    ? steps.filter(step => step.state === 'done').length / steps.length * 100 : legacyProgress;
  const currentEmployeeId = activeEmployeeId
    ?? steps.find(step => step.state === 'running' || step.state === 'waiting-user')?.employeeId
    ?? task.subscriptionId
    ?? steps[0]?.employeeId
    ?? '';

  const deliverables = kind === 'flow' && (effectiveExecution?.nodes.some(node => node.finalFiles.length)
    || plan?.nodes.some(node => node.deliverables?.length))
    ? finalDeliverables(plan, effectiveExecution, task.workDir ?? plan?.workspace.path ?? null)
    : task.files.map((file, index) => ({
      id: `${task.id}-file-${index}`,
      name: file.split(/[\\/]/).pop() || file,
      path: file,
      note: '由员工在工作过程中产出',
    }));
  return {
    id: task.id,
    title: task.title,
    pinnedAt: task.pinnedAt ?? null,
    goal: meta?.goal || readableGoal(task.prompt),
    kind,
    workType,
    status,
    isActive: task.activeRunId !== null && (task.status === 'running' || task.status === 'waiting_approval' || task.status === 'pending'),
    executionHealth: task.executionHealth,
    queuedAt: task.queuedAt ?? null,
    currentRunStartedAt: task.currentRunStartedAt ?? null,
    lastRunId: task.lastRunId ?? null,
    lastRunStartedAt: task.lastRunStartedAt ?? null,
    lastRunEndedAt: task.lastRunEndedAt ?? null,
    progress,
    currentEmployeeId,
    currentEmployeeName: nameOf(currentEmployeeId),
    steps,
    nextUserAction: nextUserAction(status, steps),
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.completedAt ?? task.lastRunEndedAt ?? task.currentRunStartedAt ?? task.queuedAt ?? task.startedAt ?? task.createdAt,
    participants: meta?.participants.length ? meta.participants : [currentEmployeeId].filter(Boolean),
    deliverables,
    arrangementExecution: kind === 'flow' ? effectiveExecution : undefined,
    timeline: buildTimeline(task, kind, nameOf(currentEmployeeId)),
    messages: buildMessages(task, messages, streamingText, currentEmployeeId, nameOf(currentEmployeeId), streamingRunId),
    activities: status === 'completed' || status === 'failed' || status === 'paused'
      ? activities.map(activity => activity.state === 'running' ? { ...activity, state: status === 'completed' ? 'completed' : 'failed', endedAt: task.completedAt ?? task.createdAt } : activity)
      : activities,
    sharedContext: meta?.sharedContext ?? { goal: readableGoal(task.prompt), confirmedInputs: [], previousResults: [], userNotes: [] },
    /*
     * 为什么中断 / 为什么被终止，都落在 task.error 上：平台报的失败原因写在这里，
     * 用户自己填的终止原因也由 stopWork 写在这里（见 useEnterpriseWorkspace）。
     * 不映射过来的话，工作详情页那条提示和工作记录里的「终止原因」永远是空的 ——
     * 界面已经答应过用户「终止原因会保留」。
     */
    stopReason: meta?.stopReason ?? task.error ?? (task.status === 'interrupted' ? '应用退出导致中断' : null),
    workDir: task.workDir,
  };
}

/**
 * 工作过程。task.logs 没有带「这条是谁做的」，所以只能统一署当前员工的名字，
 * 换过员工之后回看历史条目会显示新员工的名字——这是已知的近似。
 * 平台的 getTaskTimeline 事件里带 subscriptionId，接上之后应改为按事件逐条署名。
 */
function buildTimeline(task: ClientTask, kind: 'conversation' | 'flow', employeeName: string): WorkTimelineEntry[] {
  const entries: WorkTimelineEntry[] = [
    { id: `${task.id}-created`, at: task.createdAt, actor: '你', text: kind === 'flow' ? '安排了这项工作' : '开始了一段对话', kind: 'create' },
  ];
  task.logs.forEach((log, index) => {
    entries.push({
      id: `${task.id}-log-${index}`,
      at: log.timestamp,
      actor: employeeName,
      text: log.message,
      kind: log.level === 'error' ? 'fail' : 'employee',
    });
  });
  task.files.forEach((file, index) => {
    entries.push({
      id: `${task.id}-deliver-${index}`,
      at: task.completedAt ?? task.startedAt ?? task.createdAt,
      actor: employeeName,
      text: `产出 ${file.split(/[\\/]/).pop() || file}`,
      kind: 'deliver',
    });
  });
  if (task.status === 'paused') {
    entries.push({ id: `${task.id}-stop`, at: task.completedAt ?? Date.now(), actor: '你', text: '终止了这项工作', kind: 'stop' });
  }
  return entries.sort((left, right) => left.at - right.at);
}

function buildMessages(
  task: ClientTask,
  messages: ClientTaskMessage[] | undefined,
  streamingText: string | undefined,
  employeeId: string,
  employeeName: string,
  streamingRunId?: string,
): WorkMessage[] {
  const source: WorkMessage[] = messages?.length
    ? messages.filter(message => !(streamingText && message.role === 'assistant' && message.runId === streamingRunId)).map(message => ({
        id: message.id,
        role: message.role === 'user' ? 'user' : 'employee',
        employeeId: message.role === 'user' ? undefined : employeeId,
        employeeName: message.role === 'user' ? undefined : employeeName,
        content: message.role === 'user' && message.content.includes(META_MARKER)
          ? decodeWorkMeta(message.content)?.goal ?? readableGoal(message.content)
          : message.content,
        createdAt: message.createdAt,
        attachments: message.attachments,
      }))
    : [{ id: `${task.id}-goal`, role: 'user', content: decodeWorkMeta(task.prompt)?.goal ?? readableGoal(task.prompt), createdAt: task.createdAt }];

  if (streamingText) {
    source.push({ id: `${task.id}-streaming`, role: 'employee', employeeId, employeeName, content: streamingText, createdAt: Date.now() });
  }
  if (task.error) {
    source.push({ id: `${task.id}-error`, role: 'system', content: `工作中断：${task.error}`, createdAt: task.completedAt ?? Date.now() });
  }
  return source;
}

/** Keep completed progress visible until the retry run publishes its checkpoint snapshot. */
export function getArrangementDisplayEvents(
  eventsByRun: Record<string, TaskExecutionEvent[]>, taskId: string, runId: string,
): TaskExecutionEvent[] {
  const key = runtimeKey(taskId, runId);
  const current = eventsByRun[key] ?? [];
  if (current.some(event => event.type === 'arrangement_state_changed'
    && Array.isArray((event.data as { nodeStates?: unknown } | null)?.nodeStates))) return current;

  const completed: TaskExecutionEvent[] = [];
  for (const [previousKey, events] of Object.entries(eventsByRun)) {
    if (previousKey === key) continue;
    for (const event of events) {
      if (event.taskId !== taskId) continue;
      if (event.type === 'arrangement_node_completed') completed.push(event);
      if (event.type !== 'arrangement_state_changed') continue;
      const data = event.data as { nodeId?: string; nodeStatus?: string; nodeStates?: Array<{ nodeId: string; status: string }> } | null;
      const nodeStates = Array.isArray(data?.nodeStates) ? data.nodeStates.filter(node => node.status === 'completed') : [];
      if (data?.nodeId && data.nodeStatus === 'completed') nodeStates.push({ nodeId: data.nodeId, status: 'completed' });
      if (nodeStates.length) completed.push({ ...event, data: { nodeStates } });
    }
  }
  return completed.length ? [...completed, ...current] : current;
}

function executionFromEvents(plan: ArrangementPlanSnapshot | undefined, events: TaskExecutionEvent[], persisted?: ArrangementExecutionSnapshot | null): ArrangementExecutionSnapshot | null {
  if (!plan || plan.mode === 'conversation') return null
  // Replay only events newer than the checkpoint, using it as the base for unchanged nodes.
  const nodes: ArrangementExecutionSnapshot['nodes'] = plan.nodes.map(node => {
    const saved = persisted?.nodes.find(item => item.nodeId === node.id)
    return saved ? { ...saved, finalFiles: [...saved.finalFiles] } : { nodeId: node.id, status: 'pending', finalFiles: [] }
  })
  let status = persisted?.status ?? 'running'
  let activeRunId = persisted?.activeRunId ?? null
  let updatedAt = persisted?.updatedAt ?? 0
  let changed = false
  for (const event of events) {
    if (persisted && event.occurredAt <= persisted.updatedAt) continue
    const data = event.data as { status?: string; nodeId?: string; nodeStatus?: string; nodeStates?: Array<{ nodeId: string; status: ArrangementExecutionSnapshot['nodes'][number]['status']; pendingConfirmation?: boolean }>; finalDeliverables?: unknown } | null
    if (event.type === 'arrangement_state_changed' && data?.status) {
      status = data.status as typeof status
      changed = true
    }
    if (Array.isArray(data?.nodeStates)) {
      for (const saved of data.nodeStates) {
        const target = nodes.find(node => node.nodeId === saved.nodeId)
        if (target) { target.status = saved.status; target.pendingConfirmation = saved.pendingConfirmation; changed = true }
      }
    }
    if (data?.nodeId && data.nodeStatus) {
      const target = nodes.find(node => node.nodeId === data.nodeId)
      if (target) { target.status = data.nodeStatus as typeof target.status; changed = true }
    }
    if (data?.nodeId && ['arrangement_node_started', 'arrangement_node_completed', 'arrangement_node_failed'].includes(event.type)) {
      const target = nodes.find(node => node.nodeId === data.nodeId)
      if (target) {
        target.status = event.type === 'arrangement_node_started' ? 'running' : event.type === 'arrangement_node_completed' ? 'completed'
          : data.status === 'PAUSED' ? 'interrupted' : data.status === 'CANCELLED' ? 'stopped' : 'failed'
        if (event.type === 'arrangement_node_completed' && Array.isArray(data.finalDeliverables)) target.finalFiles = data.finalDeliverables.filter(isFinalFile)
        changed = true
      }
    }
    activeRunId = event.runId
    updatedAt = Math.max(updatedAt, event.occurredAt)
  }
  return changed ? { activeRunId, status, nodes, updatedAt } : persisted ?? null
}

function isFinalFile(value: unknown): value is ArrangementFinalFileSnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ArrangementFinalFileSnapshot>
  return typeof item.id === 'string' && typeof item.path === 'string' && typeof item.format === 'string'
    && typeof item.size === 'number' && typeof item.sha256 === 'string' && typeof item.nodeRunId === 'string' && typeof item.validatedAt === 'number'
}

function finalDeliverables(plan: ArrangementPlanSnapshot | undefined, execution: ArrangementExecutionSnapshot | null, workspace: string | null): WorkDeliverable[] {
  if (!plan || !execution) return []
  const files: WorkDeliverable[] = []
  for (const node of plan.nodes) {
    const state = execution.nodes.find(item => item.nodeId === node.id)
    if (state?.status !== 'completed') continue
    for (const file of state?.finalFiles ?? []) files.push({
      id: `${node.id}:${file.id}`,
      name: file.path.split(/[\\/]/).pop() || file.path,
      path: workspace && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(file.path)
        ? `${workspace.replace(/[\\/]+$/, '')}${workspace.includes('\\') ? '\\' : '/'}${file.path.replace(/[\\/]/g, workspace.includes('\\') ? '\\' : '/')}`
        : file.path,
      note: `节点最终交付物 · ${node.title}`,
      nodeId: node.id,
      nodeTitle: node.title,
      deliverableId: file.id,
      format: file.format,
      previewVersion: `${file.nodeRunId}:${file.snapshot?.sha256 ?? file.sha256}`,
    })
  }
  return files
}

/** Node IDs (not array position) drive parallel/out-of-order execution state. */
function arrangementStepState(nodeId: string, status: WorkStatus, events: TaskExecutionEvent[], execution: ArrangementExecutionSnapshot | null): WorkStepState {
  const checkpoint = execution?.nodes.find(node => node.nodeId === nodeId)
  const saved = checkpoint?.status
  if (saved === 'completed') return checkpoint?.pendingConfirmation ? 'waiting-user' : 'done'
  if (saved === 'running') return status === 'paused' || status === 'failed' ? 'interrupted' : 'running'
  if (saved === 'failed') return 'failed'
  if (saved === 'blocked') return 'blocked'
  if (saved === 'interrupted') return 'interrupted'
  if (saved === 'stopped') return 'stopped'
  if (saved === 'ready' || saved === 'pending') return 'pending'
  if (status === 'completed') return 'done';
  let state: WorkStepState = 'pending';
  for (const event of events) {
    const data = event.data as { nodeId?: string; nodeStatus?: string; status?: string; nodeStates?: Array<{ nodeId: string; status: string }> };
    if (event.type === 'arrangement_state_changed' && Array.isArray(data?.nodeStates)) {
      const saved = data.nodeStates.find(node => node.nodeId === nodeId)?.status;
      if (saved === 'completed') state = 'done';
      else if (saved === 'running') state = 'running';
      else if (saved === 'failed') state = 'failed';
      else if (saved === 'blocked') state = 'blocked';
      else if (saved === 'interrupted') state = 'interrupted';
      else if (saved === 'stopped') state = 'stopped';
      else if (saved) state = 'pending';
    }
    if (data?.nodeId !== nodeId) continue;
    if (event.type === 'arrangement_node_started') state = 'running';
    if (event.type === 'arrangement_node_completed') state = 'done';
    if (event.type === 'arrangement_node_failed') state = data.status === 'PAUSED' ? 'interrupted' : data.status === 'CANCELLED' ? 'stopped' : 'failed';
    if (event.type === 'arrangement_state_changed') {
      if (data.nodeStatus === 'waiting-user') state = 'waiting-user';
      if (data.nodeStatus === 'completed') state = 'done';
      if (data.nodeStatus === 'failed') state = 'failed';
      if (data.nodeStatus === 'blocked') state = 'blocked';
      if (data.nodeStatus === 'interrupted') state = 'interrupted';
      if (data.nodeStatus === 'stopped') state = 'stopped';
      if (data.nodeStatus === 'pending') state = 'pending';
    }
  }
  // A stopped/interrupted run must not leave an active animation behind.
  if ((status === 'paused' || status === 'failed') && state === 'running') return 'interrupted';
  return state;
}
