import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ElectronAPI } from '../src/shared/ipc';
import type {
  ClientTask,
  TaskExecutionEvent,
  ToolAuthorizationRequest,
} from '../src/shared/types';

export type { ElectronAPI } from '../src/shared/ipc';

const electronAPI = {
  login: credentials => ipcRenderer.invoke('auth:login', credentials),
  listRememberedAccounts: () => ipcRenderer.invoke('auth:list-remembered-accounts'),
  getRememberedPassword: email => ipcRenderer.invoke('auth:get-remembered-password', email),
  forgetAccount: email => ipcRenderer.invoke('auth:forget-account', email),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getInstances: () => ipcRenderer.invoke('auth:get-instances'),
  createTask: data => ipcRenderer.invoke('task:create', data),
  executeTask: taskId => ipcRenderer.invoke('task:execute', taskId),
  continueTask: input => ipcRenderer.invoke('task:continue', input),
  getTaskMessages: taskId => ipcRenderer.invoke('task:get-messages', taskId),
  retryTask: taskId => ipcRenderer.invoke('task:retry', taskId),
  getTask: taskId => ipcRenderer.invoke('task:get', taskId),
  getAllTasks: () => ipcRenderer.invoke('task:get-all'),
  listTaskRuns: taskId => ipcRenderer.invoke('task:list-runs', taskId),
  getTaskRun: (taskId, runId) => ipcRenderer.invoke('task:get-run', { taskId, runId }),
  getTaskTimeline: (taskId, runId) => ipcRenderer.invoke('task:get-timeline', { taskId, runId }),
  pauseTask: taskId => ipcRenderer.invoke('task:pause', taskId),
  cancelTask: taskId => ipcRenderer.invoke('task:cancel', taskId),
  deleteTask: taskId => ipcRenderer.invoke('task:delete', taskId),
  getTaskStats: () => ipcRenderer.invoke('task:get-stats'),
  selectDirectory: () => ipcRenderer.invoke('util:select-directory'),
  onPiEvent: callback => {
    const handler = (_event: IpcRendererEvent, data: TaskExecutionEvent) => callback(data);
    ipcRenderer.on('pi:event', handler);
    return () => ipcRenderer.removeListener('pi:event', handler);
  },
  onToolApprovalRequest: callback => {
    const handler = (_event: IpcRendererEvent, request: ToolAuthorizationRequest) => callback(request);
    ipcRenderer.on('pi:tool-approval-request', handler);
    return () => ipcRenderer.removeListener('pi:tool-approval-request', handler);
  },
  onTaskUpdated: callback => {
    const handler = (_event: IpcRendererEvent, task: ClientTask) => callback(task);
    ipcRenderer.on('task:updated', handler);
    return () => ipcRenderer.removeListener('task:updated', handler);
  },
  onTaskListUpdated: callback => {
    const handler = (_event: IpcRendererEvent, tasks: ClientTask[]) => callback(tasks);
    ipcRenderer.on('task:list-updated', handler);
    return () => ipcRenderer.removeListener('task:list-updated', handler);
  },
  onAuthenticationRequired: callback => {
    const handler = () => callback();
    ipcRenderer.on('auth:required', handler);
    return () => ipcRenderer.removeListener('auth:required', handler);
  },
  sendToolApprovalResponse: response => ipcRenderer.send('pi:tool-approval-response', response),
  createConversation: (data: unknown) => ipcRenderer.invoke('conversation:create', data),
  switchConversationEmployee: (data: unknown) => ipcRenderer.invoke('task:switch-employee', data),
  validateWorkflow: (data: unknown) => ipcRenderer.invoke('workflow:validate', data),
  createWorkflow: (data: unknown) => ipcRenderer.invoke('workflow:create', data),
  getWorkflow: (taskId: string) => ipcRenderer.invoke('workflow:get', taskId),
  startWorkflow: (taskId: string) => ipcRenderer.invoke('workflow:start', taskId),
} as ElectronAPI & {
  createConversation: (data: unknown) => Promise<unknown>
  switchConversationEmployee: (data: unknown) => Promise<unknown>
  validateWorkflow: (data: unknown) => Promise<unknown>
  createWorkflow: (data: unknown) => Promise<unknown>
  getWorkflow: (taskId: string) => Promise<unknown>
  startWorkflow: (taskId: string) => Promise<unknown>
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
