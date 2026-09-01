/**
 * Electron 主进程入口，负责窗口、任务运行时和 IPC。
/*
 * electron/main.ts 鈥?Electron 涓昏繘绋嬪叆鍙?
 *
 * 鑱岃矗:
 *   - 鍒涘缓 BrowserWindow + preload 娉ㄥ叆
 *   - 管理 pi session 生命周期（通过 TaskExecutionCoordinator）
 *   - 处理经过校验的 renderer <-> main IPC 通信
 *   - 搴旂敤鐢熷懡鍛ㄦ湡绠＄悊锛坮eady, quit, 绛夛級
 */

import { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu } from 'electron';
import { join } from 'node:path';
import './infrastructure/undici-polyfill'; // Pi SDK 使用的网络兼容层。
import type { TaskExecutionCoordinator } from './tasks/task-execution-coordinator';
import { ConversationRecoveryError } from './tasks/conversation-recovery-error';
import { TaskAdmissionError, TaskManager, TaskPersistenceError, TaskScopeError } from './tasks/task-manager';
import { TaskRunStore, type TaskRunRecord } from './tasks/task-run-store';
import { getDeviceFingerprint } from './auth/device-fingerprint';
import { login, getInstances, AuthApiError, type ClientInstance } from './auth/auth-api';
import { AuthSessionManager, AuthenticationRequiredError } from './auth/auth-session-manager';
import { config } from './infrastructure/config';
import type {
  AuthError,
  AuthErrorCode,
  ForgetAccountResult,
  LoginResult,
  LogoutResult,
  PasswordAvailabilityResult,
  RememberedAccountsResult,
} from '../src/shared/types';
import { createWorkflowGraph, WorkflowGraphError } from './tasks/domain/workflow-graph';
import { WorkflowStore } from './tasks/workflow-store';
import { TaskMetadataStore } from './tasks/task-metadata-store';
import { SubscriptionRuntime } from './runtime/subscription-runtime';
import {
  forgetRememberedAccount,
  getRememberedPassword,
  listRememberedAccounts,
  saveRememberedAccount,
} from './auth/credentials';

let mainWindow: BrowserWindow | null = null;
let taskCoordinator: TaskExecutionCoordinator | null = null;
let taskCoordinatorInitialization: Promise<void> | null = null;
let taskManager: TaskManager | null = null;
let taskRunStore: TaskRunStore | null = null;
let workflowStore: WorkflowStore | null = null;
let taskMetadataStore: TaskMetadataStore | null = null;
let activeInstances: ClientInstance[] = [];
let subscriptionRuntime: SubscriptionRuntime | null = null
let authenticationCleanupPromise: Promise<void> | null = null;
const authSession = new AuthSessionManager();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

function authError(
  code: AuthErrorCode,
  message: string,
  statusCode: number,
  retryable = false,
): AuthError {
  return { code, message, statusCode, ...(retryable ? { retryable: true } : {}) };
}

function mapAuthError(error: unknown): AuthError {
  if (error instanceof AuthenticationRequiredError) {
    return authError('AUTH_REQUIRED', 'Please sign in again.', 401);
  }
  if (error instanceof AuthApiError) {
    if (error.isNetworkError && error.statusCode === 0) {
      return authError('NETWORK_ERROR', 'Network connection failed. Please try again.', 0, true);
    }
    if (error.statusCode === 401) {
      return authError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
    }
    if (error.statusCode === 403) {
      return authError('ACCOUNT_DISABLED', 'This account is not permitted to sign in.', 403);
    }
    if (error.statusCode === 429) {
      return authError('RATE_LIMITED', 'Too many attempts. Please try again later.', 429, true);
    }
    if (error.statusCode >= 500) {
      return authError('SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.', error.statusCode, true);
    }
    return authError('INTERNAL_ERROR', 'The request could not be completed.', error.statusCode);
  }
  if (error instanceof Error && /safeStorage|secure storage|persist credentials/i.test(error.message)) {
    return authError('STORAGE_UNAVAILABLE', 'System secure storage is unavailable.', 422);
  }
  return authError('INTERNAL_ERROR', 'The request could not be completed.', 0);
}

async function ensureTaskManager(): Promise<TaskManager> {
  if (!taskManager) {
    taskManager = new TaskManager(app.getPath('userData'), mainWindow)
    await taskManager.initialize()
  } else {
    taskManager.setMainWindow(mainWindow)
    await taskManager.initialize()
  }
  return taskManager
}

function ensureTaskRunStore(): TaskRunStore {
  if (!taskRunStore) taskRunStore = new TaskRunStore(app.getPath('userData'))
  return taskRunStore
}

function ensureWorkflowStore(): WorkflowStore {
  if (!workflowStore) workflowStore = new WorkflowStore(app.getPath('userData'))
  return workflowStore
}

function ensureTaskMetadataStore(): TaskMetadataStore {
  if (!taskMetadataStore) taskMetadataStore = new TaskMetadataStore(app.getPath('userData'))
  return taskMetadataStore
}

function toClientTaskRun(record: TaskRunRecord) {
  return {
    id: record.id,
    taskId: record.taskId,
    subscriptionId: record.subscriptionId,
    modelId: record.modelId,
    runtimeKey: record.runtimeKey,
    outcome: record.outcome,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    sessionId: record.sessionId,
    error: record.error,
  }
}

function taskError(error: unknown): { code: string; message: string } {
  if (error instanceof AuthenticationRequiredError || (error instanceof AuthApiError && error.statusCode === 401)) return { code: 'AUTH_REQUIRED', message: 'Please sign in again.' }
  if (error instanceof AuthApiError && error.resource === 'package' && error.statusCode === 404) return { code: 'EMPLOYEE_PACKAGE_UNAVAILABLE', message: 'The selected employee package is not available. Ask an administrator to publish the subscribed version.' }
  if (error instanceof AuthApiError && (error.statusCode === 403 || error.statusCode === 404)) return { code: 'AUTH_REQUIRED', message: 'The selected employee is no longer available.' }
  if (error instanceof ConversationRecoveryError) return { code: error.code, message: error.message }
  if (error instanceof TaskAdmissionError) return { code: 'INVALID_STATE', message: error.message }
  if (error instanceof TaskScopeError) return { code: 'AUTH_REQUIRED', message: error.message }
  if (error instanceof TaskPersistenceError) return { code: 'PERSISTENCE_ERROR', message: 'Task history could not be saved.' }
  return { code: 'INTERNAL_ERROR', message: 'The task operation could not be completed.' }
}

function resolveEmployee(subscriptionId: string) {
  const instance = activeInstances.find(item => item.id === subscriptionId)
  const modelId = instance?.allowedModels?.[0]
  if (!instance || !modelId) return null
  return {
    subscriptionId,
    modelId,
    gatewayUrl: config.SEP_GATEWAY_URL,
  }
}

function ensureSubscriptionRuntime(): SubscriptionRuntime {
  if (!subscriptionRuntime) subscriptionRuntime = new SubscriptionRuntime(join(app.getPath('userData'), 'runtime'))
  return subscriptionRuntime
}

async function authorizeEmployee(subscriptionId: string) {
  const accessToken = await authSession.getValidAccessToken()
  const instances = await getInstances(accessToken)
  activeInstances = instances.filter(instance => instance.status === 'ACTIVE')
  const instance = activeInstances.find(item => item.id === subscriptionId)
  const employee = resolveEmployee(subscriptionId)
  if (!instance || !employee || !instance.template.id || !instance.templateVersion) return null
  const runtime = await ensureSubscriptionRuntime().prepare({
    enterpriseId: authSession.getMeta()?.enterpriseId ?? '',
    subscriptionId,
    employeeId: instance.template.id,
    templateVersion: instance.templateVersion,
    accessToken,
  })
  return { ...employee, additionalSkillPaths: runtime.skillPaths }
}

function invalidateAuthentication(): void {
  if (authenticationCleanupPromise) return
  authenticationCleanupPromise = (async () => {
    try {
      if (taskCoordinator) await taskCoordinator.stopAll()
    } catch (error) {
      console.warn('[main] Failed to stop Pi during authentication cleanup:', error instanceof Error ? error.name : 'unknown')
    } finally {
      const manager = await ensureTaskManager()
      manager.clearCurrentUser()
      activeInstances = []
      subscriptionRuntime?.invalidate()
      authSession.clear()
      mainWindow?.webContents.send('auth:required')
      authenticationCleanupPromise = null
    }
  })()
}

async function ensureTaskCoordinator(): Promise<TaskExecutionCoordinator> {
  if (taskCoordinator) return taskCoordinator
  if (taskCoordinatorInitialization) { await taskCoordinatorInitialization; return taskCoordinator! }
  taskCoordinatorInitialization = (async () => {
    if (!safeStorage.isEncryptionAvailable()) console.warn('[main] safeStorage encryption NOT available on this platform')
    const manager = await ensureTaskManager()
    // 将 Pi SDK 放在异步边界之后加载：其内置 undici 依赖的 Node API，
    // 只有先加载上面的兼容层后，Electron 33 才能提供。
    const { TaskExecutionCoordinator } = await import('./tasks/task-execution-coordinator')
    taskCoordinator = new TaskExecutionCoordinator({
      taskManager: manager,
      getRefreshToken: () => authSession.getRefreshToken(),
      onAuthenticationRequired: invalidateAuthentication,
      onEvent: event => mainWindow?.webContents.send('pi:event', event),
      onApprovalRequest: request => mainWindow?.webContents.send('pi:tool-approval-request', request),
      resolveEmployee,
      authorizeEmployee,
      userDataDir: app.getPath('userData'),
    })
  })()
  try { await taskCoordinatorInitialization } catch (error) { taskCoordinatorInitialization = null; throw error }
  return taskCoordinator!
}

// 鈹€鈹€ 1. 鍒涘缓涓荤獥鍙?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function createWindow(): void {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    center: true,
    show: false,
    backgroundColor: '#fffafa',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f1f1f0',
      symbolColor: '#6f6567',
      height: 44,
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    sandbox: false, // Pi runs in main, renderer is isolated via contextBridge
    },
  });

  // 加载渲染进程。
  if (process.env['ELECTRON_RENDERER_URL']) {
    console.log('[main] loading renderer from URL:', process.env['ELECTRON_RENDERER_URL']);
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    console.log('[main] ELECTRON_RENDERER_URL not set, loading from file');
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[main] renderer failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] renderer loaded successfully');
    // 某些 Windows/Electron 组合在从 Vite 开发服务器加载渲染进程时，
    // 不会触发 ready-to-show。加载成功后不要让窗口一直隐藏。
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  console.log('[main] window created');
}

// 2. TaskExecutionCoordinator 和 Pi 运行时。

// 鈹€鈹€ 3. IPC handlers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

// 鈹€鈹€ Auth: Login 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

ipcMain.handle('auth:login', async (_event, input: unknown): Promise<LoginResult> => {
  try {
    if (!isRecord(input)) {
      return { success: false, error: authError('INVALID_ARGUMENT', 'Invalid login request.', 400) };
    }
    const email = normalizeEmail(input.email);
    const rememberPassword = input.rememberPassword;
    const useSavedPassword = input.useSavedPassword;
    if (
      !email ||
      typeof rememberPassword !== 'boolean' ||
      typeof useSavedPassword !== 'boolean' ||
      (typeof input.password !== 'string' && !useSavedPassword) ||
      (useSavedPassword && typeof input.password !== 'undefined')
    ) {
      return { success: false, error: authError('INVALID_ARGUMENT', 'Invalid login request.', 400) };
    }
    if (rememberPassword && !safeStorage.isEncryptionAvailable()) {
      return { success: false, error: authError('STORAGE_UNAVAILABLE', 'System secure storage is unavailable.', 422) };
    }
    const password = useSavedPassword ? getRememberedPassword(email) : input.password as string;
    if (!password) {
      return { success: false, error: authError('INVALID_ARGUMENT', 'Please enter your password again.', 400) };
    }

    const response = await login({
      email,
      password,
      fingerprint: getDeviceFingerprint(),
      platform: process.platform,
      clientVersion: app.getVersion(),
    });
    if (
      !response || typeof response.accessToken !== 'string' || typeof response.refreshToken !== 'string' ||
      !response.user || typeof response.user.id !== 'string' || typeof response.user.name !== 'string' ||
      typeof response.user.email !== 'string' || !response.enterprise ||
      typeof response.enterprise.id !== 'string' || typeof response.enterprise.name !== 'string'
    ) {
      return { success: false, error: authError('INTERNAL_ERROR', 'The service returned an invalid response.', 502, true) };
    }

    if (taskCoordinator) await taskCoordinator.stopAll()
    authSession.setLogin(response)
    const manager = await ensureTaskManager()
    await manager.setCurrentUser(response.user.id, response.enterprise.id)
    activeInstances = []
    subscriptionRuntime?.invalidate()
    saveRememberedAccount(
      {
        email: response.user.email || email,
        displayName: response.user.name,
        enterpriseName: response.enterprise.name,
      },
      password,
      rememberPassword,
    );
    return { success: true, data: { user: response.user, enterprise: response.enterprise } };
  } catch (error) {
    authSession.clear();
    taskManager?.clearCurrentUser();
    return { success: false, error: mapAuthError(error) };
  }
});

ipcMain.handle('auth:list-remembered-accounts', async (): Promise<RememberedAccountsResult> => ({
  accounts: listRememberedAccounts(),
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
}));

ipcMain.handle('auth:get-remembered-password', async (_event, email: unknown): Promise<PasswordAvailabilityResult> => {
  const normalized = normalizeEmail(email);
  return { passwordAvailable: normalized ? Boolean(getRememberedPassword(normalized)) : false };
});

ipcMain.handle('auth:forget-account', async (_event, email: unknown): Promise<ForgetAccountResult> => {
  const normalized = normalizeEmail(email);
  if (!normalized) return { success: false, error: authError('INVALID_ARGUMENT', 'A valid email is required.', 400) };
  try {
    forgetRememberedAccount(normalized);
    return { success: true, data: null };
  } catch (error) {
    return { success: false, error: mapAuthError(error) };
  }
});

ipcMain.handle('auth:logout', async (): Promise<LogoutResult> => {
  try {
    if (taskCoordinator) await taskCoordinator.stopAll()
    const manager = await ensureTaskManager()
    manager.clearCurrentUser()
    activeInstances = []
    subscriptionRuntime?.invalidate()
    authSession.clear()
    return { success: true, data: null }
  } catch (error) {
    return { success: false, error: mapAuthError(error) }
  }
})

// 鈹€鈹€ Auth: Get instances 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

ipcMain.handle('auth:get-instances', async () => {
  try {
    const instances = await getInstances(await authSession.getValidAccessToken());

// 仅保留 ACTIVE 状态的实例。
    activeInstances = instances.filter(inst => inst.status === 'ACTIVE')

    return {
      success: true,
      data: activeInstances,
    };
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      invalidateAuthentication();
      return { success: false, error: { message: error.message, statusCode: 401 } };
    }
    if (error instanceof AuthApiError) {
      if (error.isUnauthorized) invalidateAuthentication();
      return {
        success: false,
        error: {
          message: error.message,
          statusCode: error.statusCode,
        },
      };
    }

    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 0,
      },
    };
  }
});

// 鈹€鈹€ Task Management 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

ipcMain.handle('task:create', async (_event, data: unknown) => {
  try {
    if (!isRecord(data) || typeof data.title !== 'string' || !data.title.trim() || typeof data.prompt !== 'string' || !data.prompt.trim()) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'Invalid task request.' } }
    }
    if (typeof data.workDir !== 'undefined' && (typeof data.workDir !== 'string' || !data.workDir.trim())) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The workspace directory is invalid.' } }
    }
    if (typeof data.subscriptionId !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee is invalid.' } }
    }
    const subscriptionId = data.subscriptionId
    if (!await authorizeEmployee(subscriptionId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee is unavailable.' } }
    }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(data.title.trim(), data.prompt.trim(), data.workDir?.trim(), subscriptionId)
  // 当前 renderer 的对话编辑器使用 task:create。
  // 在 task:create 边界完成初始化，确保首轮运行被识别为对话任务，
  // 并使用任务级共享 Pi 会话。
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    await ensureTaskMetadataStore().save(scope, {
      version: 1,
      taskId: task.id,
      kind: 'conversation',
      participantSubscriptionIds: [subscriptionId],
      currentSubscriptionId: subscriptionId,
      createdAt: Date.now(),
    })
    return { success: true, task }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:execute', async (_event, input: unknown) => {
  try {
    const taskId = typeof input === 'string'
      ? input
      : isRecord(input) && typeof input.taskId === 'string'
        ? input.taskId
        : null
    if (!taskId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    }
    const manager = await ensureTaskManager()
    const scope = manager.getCurrentUserScope()
    const metadata = scope ? await ensureTaskMetadataStore().load(scope, taskId) : null
    await (await ensureTaskCoordinator()).executeTask(taskId, { conversation: metadata?.kind === 'conversation' })
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:continue', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.prompt !== 'string' || !input.prompt.trim()) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task and message are required.' } }
    }
    const validRecoveryModes = new Set(['strict', 'confirm_rebuild', 'auto_rebuild_from_task_history'])
    if (typeof input.recoveryMode !== 'undefined' && (typeof input.recoveryMode !== 'string' || !validRecoveryModes.has(input.recoveryMode))) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The recovery mode is invalid.' } }
    }
    if (typeof input.confirmRecovery !== 'undefined' && typeof input.confirmRecovery !== 'boolean') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The recovery confirmation is invalid.' } }
    }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(input.taskId)
    if (!task || !task.subscriptionId) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Task or employee binding not found.' } }
    }
    if (!await authorizeEmployee(task.subscriptionId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The task employee is unavailable.' } }
    }
    await (await ensureTaskCoordinator()).continueConversation(input.taskId, input.prompt, {
      mode: input.recoveryMode === 'strict' || input.recoveryMode === 'auto_rebuild_from_task_history' ? input.recoveryMode : 'confirm_rebuild',
      confirmed: input.confirmRecovery === true,
    })
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:switch-employee', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.subscriptionId !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task and employee are required.' } }
    }
    if (!await authorizeEmployee(input.subscriptionId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee is unavailable.' } }
    }
    await (await ensureTaskCoordinator()).switchConversationEmployee(input.taskId, input.subscriptionId)
    const manager = await ensureTaskManager()
    const scope = manager.getCurrentUserScope()
    if (scope) {
      const metadata = await ensureTaskMetadataStore().load(scope, input.taskId)
      if (metadata?.kind === 'conversation') {
        metadata.currentSubscriptionId = input.subscriptionId
        if (!metadata.participantSubscriptionIds.includes(input.subscriptionId)) metadata.participantSubscriptionIds.push(input.subscriptionId)
        await ensureTaskMetadataStore().save(scope, metadata)
      }
    }
    return { success: true }
  } catch (error) { return { success: false, error: taskError(error) } }
})

ipcMain.handle('workflow:validate', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || !Array.isArray(input.nodes)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'Workflow nodes are required.' } }
    }
    return { success: true, graph: createWorkflowGraph(input.nodes as never) }
  } catch (error) {
    if (error instanceof WorkflowGraphError) return { success: false, error: { code: 'INVALID_ARGUMENT', message: error.message } }
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('workflow:create', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || !Array.isArray(input.nodes)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A title and workflow nodes are required.' } }
    }
    const graph = createWorkflowGraph(input.nodes as never)
    const employee = graph.nodes[0]?.subscriptionId
    if (!employee || !await authorizeEmployee(employee)) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The workflow employee is unavailable.' } }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(input.title.trim(), typeof input.prompt === 'string' ? input.prompt : input.title.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, employee)
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    await ensureWorkflowStore().save(scope, task.id, graph)
    await ensureTaskMetadataStore().save(scope, {
      version: 1, taskId: task.id, kind: 'workflow', participantSubscriptionIds: [...new Set(graph.nodes.map(node => node.subscriptionId))],
      currentSubscriptionId: employee, createdAt: Date.now(),
    })
    return { success: true, task, graph }
  } catch (error) {
    if (error instanceof WorkflowGraphError) return { success: false, error: { code: 'INVALID_ARGUMENT', message: error.message } }
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('conversation:create', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || typeof input.prompt !== 'string' || !input.prompt.trim() || typeof input.subscriptionId !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A title, prompt, and employee are required.' } }
    }
    if (!await authorizeEmployee(input.subscriptionId)) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee is unavailable.' } }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(input.title.trim(), input.prompt.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, input.subscriptionId)
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    await ensureTaskMetadataStore().save(scope, {
      version: 1, taskId: task.id, kind: 'conversation', participantSubscriptionIds: [input.subscriptionId],
      currentSubscriptionId: input.subscriptionId, createdAt: Date.now(),
    })
    return { success: true, task }
  } catch (error) { return { success: false, error: taskError(error) } }
})

ipcMain.handle('workflow:get', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    const manager = await ensureTaskManager()
    if (!await manager.getTask(taskId)) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    const graph = await ensureWorkflowStore().load(scope, taskId)
    if (!graph) return { success: false, error: { code: 'NOT_FOUND', message: 'Workflow not found.' } }
    return { success: true, graph }
  } catch (error) { return { success: false, error: taskError(error) } }
})

ipcMain.handle('workflow:start', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    const scope = manager.getCurrentUserScope()
    if (!scope || !await ensureWorkflowStore().load(scope, taskId)) return { success: false, error: { code: 'INVALID_STATE', message: 'A valid workflow definition is required.' } }
    await (await ensureTaskCoordinator()).executeTask(taskId)
    return { success: true }
  } catch (error) { return { success: false, error: taskError(error) } }
})

ipcMain.handle('task:get-messages', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    return { success: true, messages: await ensureTaskRunStore().getMessages(scope, taskId, task.prompt) }
  } catch (error) { return { success: false, error: taskError(error) } }
})

ipcMain.handle('task:retry', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    if (!task.subscriptionId || !await authorizeEmployee(task.subscriptionId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The task employee is unavailable.' } }
    }
    const scope = manager.getCurrentUserScope()
    const metadata = scope ? await ensureTaskMetadataStore().load(scope, taskId) : null
    await (await ensureTaskCoordinator()).retryTask(taskId, { conversation: metadata?.kind === 'conversation' })
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:get', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    return { success: true, task }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:get-all', async () => {
  try {
    const manager = await ensureTaskManager()
    return { success: true, tasks: await manager.getAllTasks() }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:list-runs', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    const manager = await ensureTaskManager()
    if (!await manager.getTask(taskId)) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    const runs = await ensureTaskRunStore().list(scope, taskId)
    return { success: true, runs: runs.map(toClientTaskRun) }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:get-run', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.runId !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task and run ID are required.' } }
    }
    const manager = await ensureTaskManager()
    if (!await manager.getTask(input.taskId)) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    const run = await ensureTaskRunStore().get(scope, input.taskId, input.runId)
    if (!run) return { success: false, error: { code: 'NOT_FOUND', message: 'Run not found.' } }
    return { success: true, run: toClientTaskRun(run) }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:get-timeline', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.runId !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task and run ID are required.' } }
    }
    const manager = await ensureTaskManager()
    if (!await manager.getTask(input.taskId)) return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.' } }
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    const run = await ensureTaskRunStore().get(scope, input.taskId, input.runId)
    if (!run) return { success: false, error: { code: 'NOT_FOUND', message: 'Run not found.' } }
    return { success: true, events: await ensureTaskRunStore().getTimeline(scope, input.taskId, input.runId) }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:pause', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    }
    await (await ensureTaskCoordinator()).pauseTask(taskId)
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:cancel', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    }
    await (await ensureTaskCoordinator()).cancelTask(taskId)
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:delete', async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    }
    const manager = await ensureTaskManager()
    if (!await manager.deleteTask(taskId)) {
      return { success: false, error: { code: 'INVALID_STATE', message: 'Cannot delete active task.' } }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:get-stats', async () => {
  try {
    const manager = await ensureTaskManager()
    return { success: true, stats: await manager.getTaskStats() }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.on('pi:tool-approval-response', (_event, response: { requestId?: string; approved?: unknown; reason?: unknown }) => {
  if (!taskCoordinator || typeof response?.approved !== 'boolean') return
  taskCoordinator.respondToApproval({
    requestId: typeof response.requestId === 'string' ? response.requestId : undefined,
    approved: response.approved,
    reason: typeof response.reason === 'string' ? response.reason : undefined,
  })
})

// 鈹€鈹€ Utility: Directory Selector 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

ipcMain.handle('util:select-directory', async () => {
  if (!mainWindow) {
    return { success: false, error: { message: 'Main window not available' } };
  }

  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '閫夋嫨宸ヤ綔鐩綍',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, path: null };
    }

    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
});

// 鈹€鈹€ 4. App lifecycle 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.whenReady().then(async () => {
  ensureTaskManager()
  // 寤惰繜鍒伴娆′换鍔℃墽琛屾椂鍒濆鍖栦换鍔″崗璋冨櫒
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', async () => {
  if (taskCoordinator) {
    await taskCoordinator.stopAll()
  }
});
