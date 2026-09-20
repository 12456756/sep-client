import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientTask, ClientTaskMessage, Subscription } from '../../shared/types';

export type TaskType = 'conversation' | 'workflow';
export type TaskStatus = 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'stopped';
export type WorkspaceView = 'new-task' | 'tasks' | 'employees' | 'skills' | 'workflows' | 'status';

export interface AvailableModel {
  id: string;
  displayName: string;
  providerName: string;
  description: string;
  isDefault: boolean;
  supportsTools: boolean;
}

export interface AvailableEmployee {
  id: string;
  displayName: string;
  description: string;
  avatar: string;
  modelOptions: AvailableModel[];
}

export interface AvailableSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
  requiresTools?: boolean;
}

export interface WorkflowInput {
  id: string;
  label: string;
  type: 'text' | 'long-text' | 'number' | 'boolean' | 'enum' | 'path';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export interface AvailableWorkflow {
  id: string;
  name: string;
  description: string;
  version: string;
  inputs: WorkflowInput[];
  employeeIds: string[];
  requiresWorkspace: boolean;
}

export interface LocalWorkspaceBinding {
  path: string;
  displayName: string;
  accessMode: 'read-only' | 'read-write';
}

export interface TaskMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  modelId?: string;
}

export interface TaskArtifact {
  id: string;
  name: string;
  kind: 'document' | 'code' | 'report';
  summary: string;
}

export interface TaskPlanStepDraft {
  id: string;
  subscriptionId: string;
  title: string;
  instruction: string;
  expectedOutput: string;
}

export interface DagNodeDraft extends TaskPlanStepDraft {
  dependsOn: string[];
  x?: number;
  y?: number;
}

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  employeeId: string;
  employeeName: string;
  modelId: string;
  skillIds: string[];
  workspace: LocalWorkspaceBinding;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  messages: TaskMessage[];
  goal?: string;
  workflowId?: string;
  workflowInputs?: Record<string, string | number | boolean>;
  logs: string[];
  artifacts: TaskArtifact[];
  activity?: string;
  planSteps?: TaskPlanStepDraft[];
}

export interface ConversationDraft {
  employeeId: string;
  modelId: string;
  skillIds: string[];
  workspace: LocalWorkspaceBinding;
}

export interface WorkflowDraft {
  workflowId: string;
  employeeId: string;
  workspace: LocalWorkspaceBinding;
  inputs: Record<string, string | number | boolean>;
  goal?: string;
  steps?: TaskPlanStepDraft[];
  nodes?: DagNodeDraft[];
  mode?: 'auto' | 'manual';
}

export interface TaskFilters {
  status: TaskStatus[];
  type: TaskType | 'all';
  time: 'all' | 'today' | '7d' | '30d';
  query: string;
}

interface WorkspaceDemo {
  tasks: Task[];
  employees: AvailableEmployee[];
  skills: AvailableSkill[];
  workflows: AvailableWorkflow[];
  selectedTaskId: string | null;
  view: WorkspaceView;
  sidebarExpanded: boolean;
  filters: TaskFilters;
  conversationDraft: ConversationDraft;
  selectTask: (id: string) => void;
  setView: (view: WorkspaceView) => void;
  setSidebarExpanded: (expanded: boolean) => void;
  setFilters: (filters: TaskFilters) => void;
  updateConversationDraft: (patch: Partial<ConversationDraft>) => void;
  createConversationTask: (text: string) => void;
  createWorkflowTask: (draft: WorkflowDraft) => void;
  sendMessage: (text: string) => void;
  stopTask: () => void;
  retryTask: (taskId?: string) => void;
  cancelTask: () => void;
  resolveApproval: (approved: boolean) => void;
  switchTaskModel: (modelId: string) => void;
  installSkill: (id: string) => void;
  newTask: () => void;
  error: string | null;
}

const initialSkills: AvailableSkill[] = [
  { id: 'code-review', name: '代码审查', description: '检查改动风险并给出可执行建议。', version: '1.2.0', installed: true, requiresTools: true },
  { id: 'project-map', name: '项目结构分析', description: '快速建立项目目录与依赖关系概览。', version: '2.0.1', installed: true },
  { id: 'report-writer', name: '报告生成', description: '将分析结果整理为结构化文档。', version: '1.0.4', installed: false },
];

const initialWorkflows: AvailableWorkflow[] = [
  { id: 'release-review', name: '发布前检查', description: '检查代码、文档与发布风险，输出检查报告。', version: '3.1.0', inputs: [{ id: 'release', label: '发布版本', type: 'text', required: true, placeholder: '例如 v1.4.0' }, { id: 'notes', label: '额外要求', type: 'long-text', required: false }], employeeIds: ['product-assistant'], requiresWorkspace: true },
  { id: 'project-plan', name: '生成开发计划', description: '根据目标和现有项目生成分阶段计划。', version: '1.8.0', inputs: [{ id: 'goal', label: '目标', type: 'long-text', required: true }, { id: 'priority', label: '优先级', type: 'enum', required: true, options: ['稳定性', '交付速度', '技术债务'] }], employeeIds: ['product-assistant', 'data-assistant'], requiresWorkspace: true },
];

const defaultWorkspace: LocalWorkspaceBinding = { path: '', displayName: '未选择工作空间', accessMode: 'read-write' };
const WORKFLOW_PROMPT_MARKER = '[SEP_WORKFLOW_TASK]';
const TASK_PLAN_MARKER = '[SEP_TASK_PLAN]';

function parseTaskPlan(prompt: string): { goal: string; steps: TaskPlanStepDraft[] } | null {
  const markerIndex = prompt.indexOf(TASK_PLAN_MARKER);
  if (markerIndex === -1) return null;
  const payload = prompt.slice(markerIndex + TASK_PLAN_MARKER.length).trim().split('\n')[0];
  try {
    const parsed = JSON.parse(payload) as { goal?: unknown; steps?: unknown };
    if (typeof parsed.goal !== 'string' || !Array.isArray(parsed.steps)) return null;
    const steps = parsed.steps.filter((step): step is TaskPlanStepDraft => {
      if (!step || typeof step !== 'object') return false;
      const item = step as Record<string, unknown>;
      return typeof item.id === 'string' && typeof item.subscriptionId === 'string' && typeof item.title === 'string' && typeof item.instruction === 'string' && typeof item.expectedOutput === 'string';
    });
    return { goal: parsed.goal, steps };
  } catch {
    return null;
  }
}

function mapTaskStatus(status: ClientTask['status']): TaskStatus {
  switch (status) {
    case 'pending': return 'queued';
    case 'running': return 'running';
    case 'waiting_approval': return 'waiting-approval';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'paused': return 'stopped';
    case 'interrupted': return 'stopped';
    default: return 'failed';
  }
}

function mapClientTask(task: ClientTask, employeeName = '硅基员工', type?: TaskType, streamedText?: string): Task {
  const createdAt = new Date(task.createdAt).toISOString();
  const updatedAt = new Date(task.completedAt ?? task.startedAt ?? task.createdAt).toISOString();
  const isConversation = type ?? (task.prompt.startsWith(WORKFLOW_PROMPT_MARKER) ? 'workflow' : 'conversation');
  const taskPlan = isConversation === 'workflow' ? parseTaskPlan(task.prompt) : null;

  return {
    id: task.id,
    type: isConversation,
    title: task.title,
    employeeId: task.subscriptionId ?? 'selected-instance',
    employeeName,
    modelId: 'sep-balanced',
    skillIds: [],
    workspace: task.workDir
      ? { path: task.workDir, displayName: task.workDir, accessMode: 'read-write' }
      : defaultWorkspace,
    status: mapTaskStatus(task.status),
    progress: task.progress ?? (task.status === 'completed' ? 100 : 0),
    createdAt,
    updatedAt,
    messages: isConversation === 'conversation'
      ? [{ id: `${task.id}-prompt`, role: 'user', content: task.prompt, createdAt }, ...(streamedText ? [{ id: `${task.id}-assistant`, role: 'assistant' as const, content: streamedText, createdAt, modelId: 'sep-balanced' }] : [])]
      : [],
    goal: taskPlan?.goal ?? task.prompt,
    logs: task.logs.map((entry) => entry.message),
    artifacts: task.files.map((file, index) => ({
      id: `${task.id}-file-${index}`,
      name: file.split(/[\\/]/).pop() || file,
      kind: 'document' as const,
      summary: file,
    })),
    activity: task.status === 'running' ? '正在执行' : undefined,
    planSteps: taskPlan?.steps,
  };
}

function departmentLabel(department: unknown): string {
  if (!department || typeof department !== 'object' || !('name' in department)) return '';
  const name = (department as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

export function useWorkspaceDemo(options: { subscriptionId?: string; employeeName?: string; instances?: Subscription[] } = {}): WorkspaceDemo {
  const [tasks, setTasks] = useState<Task[]>([]);
  const employees = useMemo<AvailableEmployee[]>(() => (options.instances ?? []).map((instance) => ({
    id: instance.subscriptionId,
    displayName: instance.name,
    description: `${instance.position || instance.functionalCategory || instance.template.name}${departmentLabel(instance.department) ? ` ? ${departmentLabel(instance.department)}` : ''}`,
    avatar: instance.template.avatar ?? instance.name.slice(0, 1),
    // 旧版或当前 SEP 实例响应可能省略可选的模型列表。
    // 保留员工显示，避免登录时整个工作区崩溃。
    modelOptions: (Array.isArray(instance.allowedModels) ? instance.allowedModels : []).map((id, index) => ({ id, displayName: id, providerName: 'SEP Gateway', description: '授权模型', isDefault: index === 0, supportsTools: true })),
  })), [options.instances]);
  const [skills, setSkills] = useState(initialSkills);
  const workflows = useMemo(() => {
    const employeeIds = (options.instances ?? []).map(instance => instance.subscriptionId);
    return initialWorkflows.map(workflow => ({ ...workflow, employeeIds }));
  }, [options.instances]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [view, setView] = useState<WorkspaceView>('tasks');
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [filters, setFilters] = useState<TaskFilters>({ status: [], type: 'all', time: 'all', query: '' });
  const [conversationDraft, setConversationDraft] = useState<ConversationDraft>({ employeeId: '', modelId: '', skillIds: [], workspace: defaultWorkspace });
  const [error, setError] = useState<string | null>(null);
  const textByTask = useRef(new Map<string, string>());
  const messagesByTask = useRef(new Map<string, ClientTaskMessage[]>());
  const taskTypeById = useRef(new Map<string, TaskType>());

  useEffect(() => {
    let active = true;
    setConversationDraft(draft => {
      if (!draft.employeeId || (options.instances ?? []).some(instance => instance.subscriptionId === draft.employeeId)) return draft;
      return { ...draft, employeeId: '', modelId: '' };
    });
    const replaceTasks = (nextTasks: ClientTask[]) => {
      if (active) setTasks(current => nextTasks.map((task) => {
        const mapped = mapClientTask(task, options.instances?.find(item => item.id === task.subscriptionId)?.name ?? options.employeeName, taskTypeById.current.get(task.id));
        const existing = current.find(item => item.id === task.id);
        return existing?.messages.length ? { ...mapped, messages: existing.messages } : mapped;
      }));
    };

    void window.electronAPI.getAllTasks().then(async (result) => {
      if (result.success) {
        replaceTasks(result.tasks ?? []);
        await Promise.all((result.tasks ?? []).map(async task => {
          if (!task.prompt.startsWith(WORKFLOW_PROMPT_MARKER)) {
            try {
              const messages = await window.electronAPI.getTaskMessages(task.id);
              if (messages.success && messages.messages) messagesByTask.current.set(task.id, messages.messages);
            } catch {
              // 如果某个历史文件无法读取，仍保留任务及其初始提示词。
            }
          }
        }));
        if (active) setTasks((items) => items.map(item => {
          const messages = messagesByTask.current.get(item.id);
          return messages ? { ...item, messages: messages.map(message => ({ id: message.id, role: message.role, content: message.content, createdAt: new Date(message.createdAt).toISOString(), modelId: item.modelId })) } : item;
        }));
      }
    }).catch(() => {
      if (active) setTasks([]);
    });

    const unsubscribeList = window.electronAPI.onTaskListUpdated(replaceTasks);
    const unsubscribeTask = window.electronAPI.onTaskUpdated((updatedTask) => {
      if (!active) return;
      const nextTask = mapClientTask(updatedTask, options.instances?.find(item => item.id === updatedTask.subscriptionId)?.name ?? options.employeeName, taskTypeById.current.get(updatedTask.id), textByTask.current.get(updatedTask.id));
      setTasks((items) => {
        const index = items.findIndex((item) => item.id === nextTask.id);
        if (index === -1) return [nextTask, ...items];
        return items.map((item) => item.id === nextTask.id ? { ...nextTask, messages: item.messages.length ? item.messages : nextTask.messages } : item);
      });
    });
    const unsubscribePi = window.electronAPI.onPiEvent((event) => {
      if (!active) return;
      if (event.type === 'text_delta') {
        const data = event.data as { text?: unknown };
        if (typeof data.text === 'string') {
          const key = `${event.taskId}:${event.runId}`;
          const nextText = `${textByTask.current.get(key) ?? ''}${data.text}`;
          textByTask.current.set(key, nextText);
          setTasks((items) => items.map((item) => item.id !== event.taskId ? item : ({
            ...item,
            messages: item.type === 'conversation'
              ? [...item.messages.filter((message) => message.role === 'user' || message.id !== `${item.id}-${event.runId}-assistant`), { id: `${item.id}-${event.runId}-assistant`, role: 'assistant', content: nextText, createdAt: new Date().toISOString(), modelId: item.modelId }]
              : item.messages,
            activity: '正在生成响应',
          })));
        }
      } else if (event.type === 'tool_execution_start') {
        setTasks((items) => items.map((item) => item.id === event.taskId ? { ...item, activity: '正在执行工具' } : item));
      } else if (event.type === 'agent_end' || event.type === 'session_error') {
        setTasks((items) => items.map((item) => item.id === event.taskId ? { ...item, activity: undefined } : item));
      }
    });

    return () => {
      active = false;
      unsubscribeList();
      unsubscribeTask();
      unsubscribePi();
    };
  }, [options.subscriptionId, options.employeeName, options.instances]);
  const currentTask = () => tasks.find((item) => item.id === selectedTaskId);

  const createConversationTask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const subscriptionId = conversationDraft.employeeId || options.subscriptionId;
      if (!subscriptionId) throw new Error('请选择一位硅基员工');
      const result = await window.electronAPI.createTask({ title: trimmed.slice(0, 80), prompt: trimmed, workDir: conversationDraft.workspace.path || undefined, subscriptionId });
      if (!result.success || !result.task) throw new Error(result.error?.message || '创建任务失败');
      taskTypeById.current.set(result.task.id, 'conversation');
      textByTask.current.delete(result.task.id);
      setSelectedTaskId(result.task.id); setView('tasks');
      const execution = await window.electronAPI.executeTask({ taskId: result.task.id });
      if (!execution.success) throw new Error(execution.error?.message || '启动任务失败');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务启动失败');
    }
  };

  const sendMessage = (text: string) => {
    const task = currentTask();
    if (!task || task.type !== 'conversation' || !text.trim() || task.status === 'queued' || task.status === 'running') return;
    setError(null);
    const prompt = text.trim();
    const pendingId = `${task.id}-pending-user-${Date.now()}`;
    setTasks(items => items.map(item => item.id === task.id ? { ...item, messages: [...item.messages, { id: pendingId, role: 'user', content: prompt, createdAt: new Date().toISOString() }] } : item));
    void window.electronAPI.continueTask({ taskId: task.id, prompt }).then(result => {
      if (!result.success) {
        setTasks(items => items.map(item => item.id === task.id ? { ...item, messages: item.messages.filter(message => message.id !== pendingId) } : item));
        setError(result.error?.message || '发送消息失败');
      }
    }).catch(cause => {
      setTasks(items => items.map(item => item.id === task.id ? { ...item, messages: item.messages.filter(message => message.id !== pendingId) } : item));
      setError(cause instanceof Error ? cause.message : '发送消息失败');
    });
  };

  const createWorkflowTask = async (draft: WorkflowDraft): Promise<void> => {
    const workflow = workflows.find(item => item.id === draft.workflowId);
    const fallbackEmployee = employees.find(item => item.id === draft.employeeId) ?? employees[0];
    if (!fallbackEmployee) return;
    setError(null);
    const rawNodes = draft.nodes ?? (draft.steps ?? []).map((step, index, steps) => ({
      ...step,
      dependsOn: index ? [steps[index - 1]!.id] : [],
    }));
    if (!rawNodes.length) { setError('???????????'); return; }
    const nodeByEmployee = new Map(employees.map(employee => [employee.id, employee]));
    const nodes = rawNodes.map(node => {
      const employee = nodeByEmployee.get(node.subscriptionId) ?? fallbackEmployee;
      return {
        id: node.id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128),
        subscriptionId: employee.id,
        modelId: employee.modelOptions[0]?.id ?? '',
        title: node.title,
        instruction: node.instruction,
        expectedOutput: node.expectedOutput,
        dependsOn: node.dependsOn,
        skillIds: [],
        requiresUserConfirmation: false,
      };
    });
    if (nodes.some(node => !node.modelId)) { setError('??????????'); return; }
    const goal = draft.goal?.trim() || workflow?.description || '?????????';
    const confirmedInputs = Object.entries(draft.inputs).map(([key, value]) => `${key}: ${String(value)}`);
    try {
      const created = await window.electronAPI.createArrangementDraft({
        schemaVersion: 1,
        mode: draft.mode === 'auto' ? 'auto' : 'manual',
        title: workflow?.name || goal.slice(0, 80),
        goal,
        confirmedInputs,
        sharedSkillIds: [],
        conversation: null,
        nodes,
        workspace: { mode: 'shared', path: draft.workspace.path || null },
        permissions: { preset: draft.workspace.accessMode === 'read-write' ? 'workspace-edit' : 'read-only' },
        lastPlanning: null,
      });
      if (!created.success || !created.draft) throw new Error(created.error?.message || '????????');
      const preflight = await window.electronAPI.preflightArrangementDraft({ draftId: created.draft.id, expectedRevision: created.draft.revision });
      if (!preflight.success || !preflight.preflight?.canStart) throw new Error(preflight.error?.message || preflight.preflight?.blockingIssues.join('?') || '????????');
      const started = await window.electronAPI.confirmAndStartArrangement({ draftId: created.draft.id, expectedRevision: created.draft.revision, idempotencyKey: crypto.randomUUID() });
      if (!started.success || !started.execution) throw new Error(started.error?.message || '??????');
      taskTypeById.current.set(started.execution.id, 'workflow');
      setSelectedTaskId(started.execution.id);
      setView('tasks');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '??????');
    }
  };

  const selectTask = (id: string) => {
    const selected = tasks.find((item) => item.id === id);
    if (!selected) return;
    setSelectedTaskId(id);
    setView('tasks');
    if (selected.type === 'conversation') {
      setConversationDraft({
        employeeId: selected.employeeId,
        modelId: selected.modelId,
        skillIds: selected.skillIds,
        workspace: selected.workspace,
      });
    }
  };

  const task = currentTask();
  return {
    tasks, employees, skills, workflows, selectedTaskId, view, sidebarExpanded, filters, conversationDraft,
    selectTask, setView, setSidebarExpanded, setFilters,
    updateConversationDraft: (patch) => setConversationDraft((draft) => ({ ...draft, ...patch })),
    createConversationTask, createWorkflowTask, sendMessage,
    stopTask: () => { if (task) void runTaskCommand(() => window.electronAPI.pauseTask(task.id), setError); },
    retryTask: (taskId) => { const target = taskId ? tasks.find(item => item.id === taskId) : task; if (target) void runTaskCommand(() => window.electronAPI.retryTask(target.id), setError); },
    cancelTask: () => { if (task) void runTaskCommand(() => window.electronAPI.cancelTask(task.id), setError); },
    resolveApproval: () => undefined,
    switchTaskModel: () => undefined,
    installSkill: (id) => setSkills((items) => items.map((item) => item.id === id ? { ...item, installed: true } : item)),
    newTask: () => { setSelectedTaskId(null); setView('new-task'); setError(null); setConversationDraft({ employeeId: '', modelId: '', skillIds: [], workspace: defaultWorkspace }); },
    error,
  };
}

async function runTaskCommand(
  command: () => Promise<{ success: boolean; error?: { message: string } }>,
  setError: (message: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    const result = await command();
    if (!result.success) setError(result.error?.message || '任务操作失败');
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : '任务操作失败');
  }
}
