import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ElectronAPI } from '../src/shared/ipc';
import type {
  ClientTask,
  TaskExecutionEvent,
  ToolAuthorizationRequest,
} from '../src/shared/types';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from './controller/channels';

export type { ElectronAPI } from '../src/shared/ipc';

const electronAPI = {
  login: credentials => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_LOGIN, credentials),
  listRememberedAccounts: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_LIST_REMEMBERED_ACCOUNTS),
  getRememberedPassword: email => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_REMEMBERED_PASSWORD, email),
  forgetAccount: email => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_FORGET_ACCOUNT, email),
  logout: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_LOGOUT),
  getInstances: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_INSTANCES),
  createTask: data => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_CREATE, data),
  executeTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_EXECUTE, taskId),
  continueTask: input => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_CONTINUE, input),
  getTaskMessages: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_MESSAGES, taskId),
  retryTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_RETRY, taskId),
  getTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET, taskId),
  getAllTasks: () => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_ALL),
  listTaskRuns: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_LIST_RUNS, taskId),
  getTaskRun: (taskId, runId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_RUN, { taskId, runId }),
  getTaskTimeline: (taskId, runId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_TIMELINE, { taskId, runId }),
  pauseTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_PAUSE, taskId),
  cancelTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_CANCEL, taskId),
  deleteTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_DELETE, taskId),
  getTaskStats: () => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_STATS),
  selectDirectory: () => ipcRenderer.invoke(INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY),
  onPiEvent: callback => {
    const handler = (_event: IpcRendererEvent, data: TaskExecutionEvent) => callback(data);
    ipcRenderer.on(EVENT_CHANNELS.PI_EVENT, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.PI_EVENT, handler);
  },
  onToolApprovalRequest: callback => {
    const handler = (_event: IpcRendererEvent, request: ToolAuthorizationRequest) => callback(request);
    ipcRenderer.on(EVENT_CHANNELS.TOOL_APPROVAL_REQUEST, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.TOOL_APPROVAL_REQUEST, handler);
  },
  onTaskUpdated: callback => {
    const handler = (_event: IpcRendererEvent, task: ClientTask) => callback(task);
    ipcRenderer.on(EVENT_CHANNELS.TASK_UPDATED, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.TASK_UPDATED, handler);
  },
  onTaskListUpdated: callback => {
    const handler = (_event: IpcRendererEvent, tasks: ClientTask[]) => callback(tasks);
    ipcRenderer.on(EVENT_CHANNELS.TASK_LIST_UPDATED, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.TASK_LIST_UPDATED, handler);
  },
  onAuthenticationRequired: callback => {
    const handler = () => callback();
    ipcRenderer.on(EVENT_CHANNELS.AUTH_REQUIRED, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.AUTH_REQUIRED, handler);
  },
  sendToolApprovalResponse: response => ipcRenderer.send(SEND_CHANNELS.TOOL_APPROVAL_RESPONSE, response),
  createConversation: data => ipcRenderer.invoke(INVOKE_CHANNELS.CONVERSATION_CREATE, data),
  switchConversationEmployee: data => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_SWITCH_EMPLOYEE, data),
  validateWorkflow: data => ipcRenderer.invoke(INVOKE_CHANNELS.WORKFLOW_VALIDATE, data),
  createWorkflow: data => ipcRenderer.invoke(INVOKE_CHANNELS.WORKFLOW_CREATE, data),
  getWorkflow: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.WORKFLOW_GET, taskId),
  startWorkflow: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.WORKFLOW_START, taskId),
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
