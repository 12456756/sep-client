/**
 * electron/controller/channels.ts — IPC 通道名的唯一定义处
 *
 * 主进程与 preload 都从这里取通道名，避免两侧字面量漂移。
 * 通道名本身是既有契约，本文件只做集中声明，**不得改动任何字符串**。
 */

/** renderer -> main，`ipcRenderer.invoke` / `ipcMain.handle`。 */
export const INVOKE_CHANNELS = {
  SKILL_LIBRARY_LIST: 'skill-library:list',
  SKILL_LIBRARY_PREVIEW: 'skill-library:preview',
  SKILL_LIBRARY_SELECT: 'skill-library:select',
  SKILL_LIBRARY_SAVE: 'skill-library:save',
  SKILL_LIBRARY_RETRY: 'skill-library:retry',
  AUTH_LOGIN: 'auth:login',
  AUTH_LIST_REMEMBERED_ACCOUNTS: 'auth:list-remembered-accounts',
  AUTH_GET_REMEMBERED_PASSWORD: 'auth:get-remembered-password',
  AUTH_REVEAL_REMEMBERED_PASSWORD: 'auth:reveal-remembered-password',
  AUTH_FORGET_ACCOUNT: 'auth:forget-account',
  AUTH_LOGOUT: 'auth:logout',
  SYSTEM_RUNTIME_INFO: 'system:runtime-info',
  SYSTEM_LOG_ERROR: 'system:log-error',
  SYSTEM_LOG_PERFORMANCE: 'system:log-performance',
  AUTH_GET_INSTANCES: 'auth:get-instances',
  AUTH_GET_EMPLOYEE_STATUS: 'auth:get-employee-status',
  AUTH_GET_ORGANIZATION: 'auth:get-organization',
  SUBSCRIPTION_GET_SKILLS: 'subscription:get-skills',
  SUBSCRIPTION_PREVIEW_SKILL: 'subscription:preview-skill',
  CONVERSATION_CREATE: 'conversation:create',
  TASK_CREATE: 'task:create',
  TASK_EXECUTE: 'task:execute',
  TASK_CONTINUE: 'task:continue',
  TASK_SWITCH_EMPLOYEE: 'task:switch-employee',
  TASK_GET_MESSAGES: 'task:get-messages',
  TASK_RETRY: 'task:retry',
  TASK_GET: 'task:get',
  TASK_GET_ALL: 'task:get-all',
  TASK_LIST_RUNS: 'task:list-runs',
  TASK_GET_RUN: 'task:get-run',
  TASK_GET_TIMELINE: 'task:get-timeline',
  TASK_PAUSE: 'task:pause',
  TASK_CANCEL: 'task:cancel',
  TASK_DELETE: 'task:delete',
  TASK_GET_STATS: 'task:get-stats',
  ARRANGE_GET_CONTEXT: 'arrange:get-context',
  ARRANGE_GET_PLAN: 'arrange:get-plan',
  ARRANGE_LIST_DRAFTS: 'arrange:list-drafts',
  ARRANGE_CREATE_DRAFT: 'arrange:create-draft',
  ARRANGE_GET_DRAFT: 'arrange:get-draft',
  ARRANGE_UPDATE_DRAFT: 'arrange:update-draft',
  ARRANGE_DELETE_DRAFT: 'arrange:delete-draft',
  ARRANGE_VALIDATE_DRAFT: 'arrange:validate-draft',
  ARRANGE_PREFLIGHT_DRAFT: 'arrange:preflight-draft',
  ARRANGE_CONFIRM_DRAFT: 'arrange:confirm-draft',
  ARRANGE_CONFIRM_AND_START: 'arrange:confirm-and-start',
  ARRANGE_PLAN_DRAFT: 'arrange:plan-draft',
  ARRANGE_CANCEL_PLAN: 'arrange:cancel-plan',
  UTIL_SELECT_DIRECTORY: 'util:select-directory',
} as const

/** renderer -> main，单向 `ipcRenderer.send` / `ipcMain.on`。 */
export const SEND_CHANNELS = {
  TOOL_APPROVAL_RESPONSE: 'pi:tool-approval-response',
} as const

/** main -> renderer，`webContents.send` / `ipcRenderer.on`。 */
export const EVENT_CHANNELS = {
  AUTH_REQUIRED: 'auth:required',
  PI_EVENT: 'pi:event',
  TOOL_APPROVAL_REQUEST: 'pi:tool-approval-request',
  TASK_UPDATED: 'task:updated',
  TASK_LIST_UPDATED: 'task:list-updated',
  ARRANGEMENT_PLANNING_EVENT: 'arrangement:planning-event',
} as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[keyof typeof INVOKE_CHANNELS]
export type SendChannel = (typeof SEND_CHANNELS)[keyof typeof SEND_CHANNELS]
export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS]
export type IpcChannel = InvokeChannel | SendChannel | EventChannel

/** 全部通道名，供契约测试与边界脚本使用。 */
export const ALL_CHANNELS: readonly IpcChannel[] = [
  ...Object.values(INVOKE_CHANNELS),
  ...Object.values(SEND_CHANNELS),
  ...Object.values(EVENT_CHANNELS),
]
