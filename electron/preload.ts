import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ElectronAPI } from '../src/shared/ipc';
import type {
  ArrangementPlanningProgress,
  ClientTask,
  TaskExecutionEvent,
  ToolAuthorizationRequest,
} from '../src/shared/types';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from './controller/channels';

export type { ElectronAPI } from '../src/shared/ipc';

const electronAPI = {
  listSkillLibrary: () => ipcRenderer.invoke(INVOKE_CHANNELS.SKILL_LIBRARY_LIST),
  previewLibrarySkill: (input: { capabilityId: string; versionId: string }) => ipcRenderer.invoke(INVOKE_CHANNELS.SKILL_LIBRARY_PREVIEW, input),
  selectSkillVersion: (input: { capabilityId: string; versionId: string }) => ipcRenderer.invoke(INVOKE_CHANNELS.SKILL_LIBRARY_SELECT, input),
  savePersonalSkill: (input: import('../src/shared/skill-library').SaveSkillInput) => ipcRenderer.invoke(INVOKE_CHANNELS.SKILL_LIBRARY_SAVE, input),
  retryPersonalSkillUpload: (input: { capabilityId: string; idempotencyKey: string }) => ipcRenderer.invoke(INVOKE_CHANNELS.SKILL_LIBRARY_RETRY, input),
  login: credentials => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_LOGIN, credentials),
  listRememberedAccounts: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_LIST_REMEMBERED_ACCOUNTS),
  getRememberedPassword: email => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_REMEMBERED_PASSWORD, email),
  revealRememberedPassword: email => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_REVEAL_REMEMBERED_PASSWORD, email),
  forgetAccount: email => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_FORGET_ACCOUNT, email),
  logout: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_LOGOUT),
  getRuntimeInfo: () => ipcRenderer.invoke(INVOKE_CHANNELS.SYSTEM_RUNTIME_INFO),
  logError: error => ipcRenderer.invoke(INVOKE_CHANNELS.SYSTEM_LOG_ERROR, error),
  logPerformance: metrics => ipcRenderer.invoke(INVOKE_CHANNELS.SYSTEM_LOG_PERFORMANCE, metrics),
  getSubscriptions: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_INSTANCES),
  getEmployeeStatus: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_EMPLOYEE_STATUS),
  getEnterpriseOrganization: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_ORGANIZATION),
  getEmployeeSkills: employeeId => ipcRenderer.invoke(INVOKE_CHANNELS.SUBSCRIPTION_GET_SKILLS, employeeId),
  previewSkill: versionId => ipcRenderer.invoke(INVOKE_CHANNELS.SUBSCRIPTION_PREVIEW_SKILL, versionId),
  createTask: data => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_CREATE, data),
  executeTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_EXECUTE, taskId),
  continueTask: input => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_CONTINUE, input),
  getTaskMessages: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_MESSAGES, taskId),
  retryTask: input => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_RETRY, input),
  getTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET, taskId),
  getAllTasks: () => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_ALL),
  listTaskRuns: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_LIST_RUNS, taskId),
  getTaskRun: (taskId, runId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_RUN, { taskId, runId }),
  getTaskTimeline: (taskId, runId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_TIMELINE, { taskId, runId }),
  pauseTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_PAUSE, taskId),
  cancelTask: (taskId, reason) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_CANCEL, { taskId, reason }),
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
  onArrangementPlanningEvent: callback => {
    const handler = (_event: IpcRendererEvent, data: ArrangementPlanningProgress) => callback(data);
    ipcRenderer.on(EVENT_CHANNELS.ARRANGEMENT_PLANNING_EVENT, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.ARRANGEMENT_PLANNING_EVENT, handler);
  },
  sendToolApprovalResponse: response => ipcRenderer.send(SEND_CHANNELS.TOOL_APPROVAL_RESPONSE, response),
  createConversation: data => ipcRenderer.invoke(INVOKE_CHANNELS.CONVERSATION_CREATE, data),
  switchConversationEmployee: data => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_SWITCH_EMPLOYEE, data),
  getArrangementContext: () => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_GET_CONTEXT),
  getArrangementPlan: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_GET_PLAN, taskId),
  listArrangementDrafts: () => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_LIST_DRAFTS),
  createArrangementDraft: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_CREATE_DRAFT, input),
  getArrangementDraft: draftId => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_GET_DRAFT, draftId),
  updateArrangementDraft: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_UPDATE_DRAFT, input),
  deleteArrangementDraft: draftId => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_DELETE_DRAFT, draftId),
  validateArrangementDraft: draftId => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_VALIDATE_DRAFT, draftId),
  preflightArrangementDraft: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_PREFLIGHT_DRAFT, input),
  confirmArrangementDraft: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_CONFIRM_DRAFT, input),
  confirmAndStartArrangement: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_CONFIRM_AND_START, input),
  planArrangementDraft: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_PLAN_DRAFT, input),
  cancelArrangementPlanning: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_CANCEL_PLAN, input),
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
