import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientTask, ClientTaskMessage, EmployeeInstanceSnapshot } from '../../shared/types';

export type TaskType = 'conversation' | 'workflow';
export type TaskStatus = 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'stopped';
export type WorkspaceView = 'tasks' | 'employees' | 'skills' | 'workflows' | 'status';

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
  retryTask: () => void;
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

  return {
    id: task.id,
    type: isConversation,
    title: task.title,
    employeeId: task.employeeInstanceId ?? 'selected-instance',
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
    goal: task.prompt,
    logs: task.logs.map((entry) => entry.message),
    artifacts: task.files.map((file, index) => ({
      id: `${task.id}-file-${index}`,
      name: file.split(/[\\/]/).pop() || file,
      kind: 'document' as const,
      summary: file,
    })),
    activity: task.status === 'running' ? '正在执行' : undefined,
  };
}

export function useWorkspaceDemo(options: { employeeInstanceId?: string; employeeName?: string; instances?: EmployeeInstanceSnapshot[] } = {}): WorkspaceDemo {
  const [tasks, setTasks] = useState<Task[]>([]);
  const employees = useMemo<AvailableEmployee[]>(() => (options.instances ?? []).map((instance) => ({
    id: instance.id,
    displayName: instance.name,
    description: `${instance.template.name}${instance.department ? ` · ${instance.department.name}` : ''}`,
    avatar: instance.template.avatar ?? instance.name.slice(0, 1),
    modelOptions: instance.allowedModels.map((id, index) => ({ id, displayName: id, providerName: 'SEP Gateway', description: '授权模型', isDefault: index === 0, supportsTools: true })),
  })), [options.instances]);
  const [skills, setSkills] = useState(initialSkills);
  const workflows = useMemo(() => {
    const employeeIds = (options.instances ?? []).map(instance => instance.id);
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
      const selected = (options.instances ?? []).find(instance => instance.id === draft.employeeId)
        ?? (options.instances ?? []).find(instance => instance.id === options.employeeInstanceId)
        ?? options.instances?.[0];
      if (!selected) return draft;
      return { ...draft, employeeId: selected.id, modelId: selected.allowedModels[0] ?? '' };
    });
    const replaceTasks = (nextTasks: ClientTask[]) => {
      if (active) setTasks(current => nextTasks.map((task) => {
        const mapped = mapClientTask(task, options.instances?.find(item => item.id === task.employeeInstanceId)?.name ?? options.employeeName, taskTypeById.current.get(task.id));
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
              // Keep the task and its initial prompt if one history file cannot be read.
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
      const nextTask = mapClientTask(updatedTask, options.instances?.find(item => item.id === updatedTask.employeeInstanceId)?.name ?? options.employeeName, taskTypeById.current.get(updatedTask.id), textByTask.current.get(updatedTask.id));
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
  }, [options.employeeInstanceId, options.employeeName, options.instances]);
  const currentTask = () => tasks.find((item) => item.id === selectedTaskId);

  const createConversationTask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const employeeInstanceId = conversationDraft.employeeId || options.employeeInstanceId;
      const result = await window.electronAPI.createTask({ title: trimmed.slice(0, 80), prompt: trimmed, workDir: conversationDraft.workspace.path || undefined, employeeInstanceId });
      if (!result.success || !result.task) throw new Error(result.error?.message || '创建任务失败');
      taskTypeById.current.set(result.task.id, 'conversation');
      textByTask.current.delete(result.task.id);
      setSelectedTaskId(result.task.id); setView('tasks');
      const execution = await window.electronAPI.executeTask({ taskId: result.task.id, employeeInstanceId });
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
    void window.electronAPI.continueTask({ taskId: task.id, prompt, employeeInstanceId: task.employeeId }).then(result => {
      if (!result.success) {
        setTasks(items => items.map(item => item.id === task.id ? { ...item, messages: item.messages.filter(message => message.id !== pendingId) } : item));
        setError(result.error?.message || '发送消息失败');
      }
    }).catch(cause => {
      setTasks(items => items.map(item => item.id === task.id ? { ...item, messages: item.messages.filter(message => message.id !== pendingId) } : item));
      setError(cause instanceof Error ? cause.message : '发送消息失败');
    });
  };

  const createWorkflowTask = async (draft: WorkflowDraft) => {
    const workflow = workflows.find((item) => item.id === draft.workflowId); const employee = employees.find((item) => item.id === draft.employeeId) ?? employees[0];
    if (!workflow || !employee) return;
    setError(null);
    const inputLines = Object.entries(draft.inputs).map(([key, value]) => `- ${key}: ${String(value)}`).join('\n');
    const prompt = `${WORKFLOW_PROMPT_MARKER}\n${workflow.name}\n\n${workflow.description}\n\n执行参数：\n${inputLines || '- 无'}`;
    try {
      const result = await window.electronAPI.createTask({ title: workflow.name, prompt, workDir: draft.workspace.path || undefined, employeeInstanceId: employee.id });
      if (!result.success || !result.task) throw new Error(result.error?.message || '创建任务失败');
      taskTypeById.current.set(result.task.id, 'workflow');
      setSelectedTaskId(result.task.id); setView('tasks');
      const execution = await window.electronAPI.executeTask({ taskId: result.task.id, employeeInstanceId: employee.id });
      if (!execution.success) throw new Error(execution.error?.message || '启动任务失败');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务启动失败');
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
    retryTask: () => { if (task) void runTaskCommand(() => window.electronAPI.retryTask(task.id), setError); },
    cancelTask: () => { if (task) void runTaskCommand(() => window.electronAPI.cancelTask(task.id), setError); },
    resolveApproval: () => undefined,
    switchTaskModel: () => undefined,
    installSkill: (id) => setSkills((items) => items.map((item) => item.id === id ? { ...item, installed: true } : item)),
    newTask: () => { setSelectedTaskId(null); setView('tasks'); setError(null); setConversationDraft({ employeeId: '', modelId: '', skillIds: [], workspace: defaultWorkspace }); },
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
