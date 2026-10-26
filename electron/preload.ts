import type { NotificationUpdate } from '../src/shared/notification-contracts';
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { ElectronAPI, UpdateState } from '../src/shared/ipc';
import type { KnowledgeRequestInput } from '../src/shared/knowledge-contracts';
import type {
  ArrangementPlanningProgress,
  ClientTask,
  TaskExecutionEvent,
  ToolAuthorizationRequest,
} from '../src/shared/types';
import type { AttachmentImportTarget } from '../src/shared/attachment-contracts';
import { attachmentImportLimits } from '../src/shared/attachment-contracts';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from './controller/channels';
import { getWindowChromeConfig } from './common/window-layout';

export type { ElectronAPI } from '../src/shared/ipc';

const runtimePlatform = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'unknown';
const windowChromeConfig = getWindowChromeConfig(runtimePlatform === 'unknown' ? 'linux' : runtimePlatform);

type PasteTarget = { composerId: string; sessionId: string; target: AttachmentImportTarget; isEnabled?: () => boolean; onPasteEdit?: (input: { operationId: string; composerId: string; text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => boolean };
const pasteTargets = new Map<string, PasteTarget>();
const pasteListeners = new Set<(event: { composerId: string; sessionId: string; operationId: string; text?: string; status?: 'started' | 'completed' | 'failed'; error?: string }) => void>();
const pasteDisposers = new Map<string, () => void>();

function registerPasteTarget(input: PasteTarget): () => void {
  pasteTargets.set(input.composerId, input);
  const handler = (event: Event) => {
    if (!event.isTrusted) return;
    const target = event.target as { closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null } | null;
    const editable = target as ({ matches?: (selector: string) => boolean; closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null } | null);
    if (!editable?.matches?.('textarea, input:not([type]), input[type="text"], [contenteditable="true"]')) return;
    const composerId = editable.closest?.('[data-composer-id]')?.getAttribute?.('data-composer-id');
    if (composerId !== input.composerId) return;
    const current = pasteTargets.get(input.composerId);
    if (!current || current.sessionId !== input.sessionId) return;
    if (current.isEnabled?.() === false) return;
    const clipboardData = (event as Event & { clipboardData?: { files?: ArrayLike<unknown>; getData: (type: string) => string } }).clipboardData;
    const files = Array.from(clipboardData?.files ?? []) as Array<{ name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
    const text = clipboardData?.getData('text/plain') || '';
    if (!files.length) return;
    const operationId = crypto.randomUUID();
    const editor = target as { selectionStart?: number; selectionEnd?: number } | null;
    const selectionStart = typeof editor?.selectionStart === 'number' ? editor.selectionStart : 0;
    const selectionEnd = typeof editor?.selectionEnd === 'number' ? editor.selectionEnd : selectionStart;
    const editorVersion = Number(target?.closest?.('[data-composer-id]')?.getAttribute?.('data-editor-version') || 0);
    let handledText = false;
    if (text && current.onPasteEdit) {
      try { handledText = current.onPasteEdit({ operationId, composerId: input.composerId, text, selectionStart, selectionEnd, editorVersion }) === true; } catch { return; }
      if (!handledText) return;
    }
    // Preserve the browser's native text insertion for mixed image/text pastes.
    // Attachment-only pastes have no text to preserve and are consumed here.
    if (!text || handledText) event.preventDefault();
    const notify = (event: { status?: 'started' | 'completed' | 'failed'; error?: string }) => { for (const callback of pasteListeners) callback({ composerId: input.composerId, sessionId: input.sessionId, operationId, text: text || undefined, ...event }); };
    notify({ status: 'started' });
    const entries = files.map(file => ({ file, path: (() => { try { return webUtils.getPathForFile(file as File); } catch { return ''; } })() }));
    if (entries.length > attachmentImportLimits.maxFiles) { notify({ status: 'failed', error: '一次最多添加 10 个附件' }); return; }
    void (async () => {
      const paths = entries.flatMap(entry => entry.path ? [entry.path] : []);
      const imageEntries = entries.filter(entry => !entry.path);
      const results: Array<{ success?: boolean; error?: { message?: string } }> = [];
      if (paths.length) results.push(await ipcRenderer.invoke(INVOKE_CHANNELS.ATTACHMENT_IMPORT_FILES, { sessionId: input.sessionId, operationId, paths }));
      for (const { file } of imageEntries) {
        if (!file.type.startsWith('image/')) throw new Error('剪贴板没有提供可读取的附件数据');
        if (file.size > attachmentImportLimits.maxFileBytes) throw new Error('粘贴图片超过 20 MB 限制');
        const bytes = new Uint8Array(await file.arrayBuffer());
        results.push(await ipcRenderer.invoke(INVOKE_CHANNELS.ATTACHMENT_IMPORT_IMAGE, { sessionId: input.sessionId, operationId, name: file.name || 'pasted-image', type: file.type, bytes }));
      }
      const failed = results.find(result => !result.success);
      notify(failed ? { status: 'failed', error: failed.error?.message || '附件导入失败' } : { status: 'completed' });
    })().catch((error: unknown) => notify({ status: 'failed', error: error instanceof Error ? error.message : '附件导入失败' }));
  };
  const doc = (globalThis as unknown as { document: { addEventListener: (type: string, listener: (event: Event) => void, capture: boolean) => void; removeEventListener: (type: string, listener: (event: Event) => void, capture: boolean) => void } }).document;
  doc.addEventListener('paste', handler, true);
  const dispose = () => { doc.removeEventListener('paste', handler, true); if (pasteTargets.get(input.composerId) === input) pasteTargets.delete(input.composerId); pasteDisposers.delete(input.composerId); };
  pasteDisposers.set(input.composerId, dispose);
  return dispose;
}

const electronAPI = {
  requestKnowledge: (input: KnowledgeRequestInput) => ipcRenderer.invoke(INVOKE_CHANNELS.KNOWLEDGE_REQUEST, input),
  cancelKnowledgeRequests: (requestIds: string[]) => ipcRenderer.invoke(INVOKE_CHANNELS.KNOWLEDGE_CANCEL, requestIds),
  getSpeechPermission: () => ipcRenderer.invoke(INVOKE_CHANNELS.SPEECH_PERMISSION),
  openSpeechSystemSettings: () => ipcRenderer.invoke(INVOKE_CHANNELS.SPEECH_OPEN_SYSTEM_SETTINGS),
  setSpeechEnabled: input => ipcRenderer.invoke(INVOKE_CHANNELS.SPEECH_SET_ENABLED, input),
  beginSpeechRecording: input => ipcRenderer.invoke(INVOKE_CHANNELS.SPEECH_BEGIN, input),
  recognizeSpeech: input => ipcRenderer.invoke(INVOKE_CHANNELS.SPEECH_RECOGNIZE, input),
  cancelSpeechRecording: input => ipcRenderer.invoke(INVOKE_CHANNELS.SPEECH_CANCEL, input),
  getTaskVideo: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_GET_TASK, taskId),
  importVideoReferences: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_IMPORT_REFERENCES, taskId),
  getVideoReferences: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_GET_REFERENCES, taskId),
  generateTaskVideo: input => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_GENERATE, input),
  previewVideoOutput: input => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_PREVIEW, input),
  exportVideoOutput: input => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_EXPORT, input),
  resumeVideoTracking: input => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_RESUME, input),
  retryVideoSave: input => ipcRenderer.invoke(INVOKE_CHANNELS.VIDEO_RETRY_SAVE, input),
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
  beginAttachmentImport: input => ipcRenderer.invoke(INVOKE_CHANNELS.ATTACHMENT_BEGIN, input),
  selectAttachments: input => ipcRenderer.invoke(INVOKE_CHANNELS.ATTACHMENT_SELECT, input),
  listAttachments: input => ipcRenderer.invoke(INVOKE_CHANNELS.ATTACHMENT_LIST, input),
  removeAttachment: input => ipcRenderer.invoke(INVOKE_CHANNELS.ATTACHMENT_REMOVE, input),
  cancelAttachmentImport: input => ipcRenderer.invoke(INVOKE_CHANNELS.ATTACHMENT_CANCEL, input),
  bindAttachmentPaste: input => registerPasteTarget(input),
  onAttachmentPaste: callback => { pasteListeners.add(callback); return () => pasteListeners.delete(callback); },
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
  getTaskMedia: (taskId, options) => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_GET_TASK, options ? { taskId, ...options } : taskId),
  setMediaReferenceSelection: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_SET_REFERENCE_SELECTION, input),
  importMediaReferences: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_IMPORT_REFERENCES, taskId),
  generateTaskMedia: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_GENERATE, input),
  previewMediaAsset: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_PREVIEW, input),
  exportMediaAsset: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_EXPORT, input),
  retryMediaSave: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_RETRY_SAVE, input),
  cancelMediaJob: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_CANCEL, input),
  resumeMediaTracking: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_RESUME, input),
  redoMediaJob: input => ipcRenderer.invoke(INVOKE_CHANNELS.MEDIA_REDO, input),
  getAllTasks: () => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_ALL),
  listTaskRuns: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_LIST_RUNS, taskId),
  getTaskRun: (taskId, runId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_RUN, { taskId, runId }),
  getTaskTimeline: (taskId, runId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_TIMELINE, { taskId, runId }),
  pauseTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_PAUSE, taskId),
  cancelTask: (taskId, reason) => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_CANCEL, { taskId, reason }),
  deleteTask: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_DELETE, taskId),
  updateTaskDetails: input => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_UPDATE_DETAILS, input),
  getTaskStats: () => ipcRenderer.invoke(INVOKE_CHANNELS.TASK_GET_STATS),
  selectDirectory: currentPath => ipcRenderer.invoke(INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY, currentPath),
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
  getArrangementExecution: taskId => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_GET_EXECUTION, taskId),
  previewArrangementDocument: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_PREVIEW_DOCUMENT, input),
  confirmArrangementNodes: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_CONFIRM_NODES, input),
  listArrangementDrafts: () => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_LIST_DRAFTS),
  createArrangementDraft: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_CREATE_DRAFT, input),
  getArrangementDraft: draftId => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_GET_DRAFT, draftId),
  updateArrangementExecutionSettings: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_UPDATE_EXECUTION_SETTINGS, input),
  updateArrangementInputs: input => ipcRenderer.invoke(INVOKE_CHANNELS.ARRANGE_UPDATE_INPUTS, input),
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
