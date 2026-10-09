import type { NotificationUpdate } from '../src/shared/notification-contracts';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ElectronAPI, UpdateState } from '../src/shared/ipc';
import type {
  ArrangementPlanningProgress,
  ClientTask,
  TaskExecutionEvent,
  ToolAuthorizationRequest,
} from '../src/shared/types';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from './controller/channels';
import { getWindowChromeConfig } from './common/window-layout';

export type { ElectronAPI } from '../src/shared/ipc';

const runtimePlatform = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'unknown';
const windowChromeConfig = getWindowChromeConfig(runtimePlatform === 'unknown' ? 'linux' : runtimePlatform);

const electronAPI = {
  getUpdateState: () => ipcRenderer.invoke(INVOKE_CHANNELS.UPDATE_GET_STATE),
  checkForUpdate: () => ipcRenderer.invoke(INVOKE_CHANNELS.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(INVOKE_CHANNELS.UPDATE_DOWNLOAD),
  cancelUpdateDownload: () => ipcRenderer.invoke(INVOKE_CHANNELS.UPDATE_CANCEL),
  installUpdate: () => ipcRenderer.invoke(INVOKE_CHANNELS.UPDATE_INSTALL),
  onUpdateStateChanged: callback => {
    const handler = (_event: IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on(EVENT_CHANNELS.UPDATE_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.UPDATE_STATE_CHANGED, handler);
  },
  listNotifications: query => ipcRenderer.invoke(INVOKE_CHANNELS.NOTIFICATION_LIST, query ?? {}),
  getUnreadNotificationCount: query => ipcRenderer.invoke(INVOKE_CHANNELS.NOTIFICATION_UNREAD_COUNT, query ?? {}),
  markNotificationRead: id => ipcRenderer.invoke(INVOKE_CHANNELS.NOTIFICATION_MARK_READ, id),
  markAllNotificationsRead: query => ipcRenderer.invoke(INVOKE_CHANNELS.NOTIFICATION_MARK_ALL_READ, query ?? {}),
  deleteNotification: id => ipcRenderer.invoke(INVOKE_CHANNELS.NOTIFICATION_DELETE, id),
  clearReadNotifications: query => ipcRenderer.invoke(INVOKE_CHANNELS.NOTIFICATION_CLEAR_READ, query ?? {}),
  openNotificationAction: url => ipcRenderer.invoke(INVOKE_CHANNELS.NOTIFICATION_OPEN_ACTION, url),
  onNotificationUpdate: callback => {
    const handler = (_event: IpcRendererEvent, update: NotificationUpdate) => callback(update);
    ipcRenderer.on(EVENT_CHANNELS.NOTIFICATION_UPDATED, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.NOTIFICATION_UPDATED, handler);
  },
  platform: runtimePlatform,
  windowChrome: { height: windowChromeConfig.contentTop, rightInset: windowChromeConfig.windowsRightInset },
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
  getSubscriptions: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_INSTANCES),
  getEmployeeStatus: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_EMPLOYEE_STATUS),
  getEnterpriseOrganization: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_GET_ORGANIZATION),
  getClientProfile: () => ipcRenderer.invoke(INVOKE_CHANNELS.PROFILE_GET),
  uploadUserAvatar: input => ipcRenderer.invoke(INVOKE_CHANNELS.PROFILE_UPLOAD_AVATAR, input),
  uploadEnterpriseLogo: input => ipcRenderer.invoke(INVOKE_CHANNELS.PROFILE_UPLOAD_ENTERPRISE_LOGO, input),
  createPersonalRecharge: input => ipcRenderer.invoke(INVOKE_CHANNELS.WALLET_CREATE_RECHARGE, input),
  getPersonalRecharge: orderNo => ipcRenderer.invoke(INVOKE_CHANNELS.WALLET_GET_RECHARGE, orderNo),
  reconcilePersonalRecharge: orderNo => ipcRenderer.invoke(INVOKE_CHANNELS.WALLET_RECONCILE_RECHARGE, orderNo),
  getComputeCenterOverview: () => ipcRenderer.invoke(INVOKE_CHANNELS.COMPUTE_CENTER_GET_OVERVIEW),
  getPersonalWalletTransactions: query => ipcRenderer.invoke(INVOKE_CHANNELS.COMPUTE_CENTER_GET_TRANSACTIONS, query),
  getComputeUsageRecords: query => ipcRenderer.invoke(INVOKE_CHANNELS.COMPUTE_CENTER_GET_USAGE_RECORDS, query),
  getComputeUsageBreakdown: days => ipcRenderer.invoke(INVOKE_CHANNELS.COMPUTE_CENTER_GET_BREAKDOWN, { days }),
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
  setWindowTheme: theme => ipcRenderer.invoke(INVOKE_CHANNELS.WINDOW_SET_THEME, theme),
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
  requestEmployeeAccess: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_REQUEST_EMPLOYEE_ACCESS, input),
  getEmployeeAccessRequest: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_GET_EMPLOYEE_ACCESS_REQUEST, input),
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
