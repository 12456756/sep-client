/**
 * electron/main.ts — Electron 主进程入口
 *
 * 职责:
 *   - 创建 BrowserWindow + preload 注入
 *   - 管理 pi session 生命周期（通过 pi-host.ts）
 *   - 处理 IPC 通信（renderer ↔ main ↔ pi-host）
 *   - 应用生命周期管理（ready, quit, 等）
 */

import { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu } from 'electron';
import { join } from 'node:path';
import './infrastructure/undici-polyfill'; // Pi SDK 使用的网络兼容层
import { TaskExecutionCoordinator } from './tasks/task-execution-coordinator';
import { TaskManager, TaskPersistenceError, TaskScopeError } from './tasks/task-manager';
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
    employeeInstanceId: record.employeeInstanceId,
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
  if (error instanceof TaskScopeError) return { code: 'AUTH_REQUIRED', message: error.message }
  if (error instanceof TaskPersistenceError) return { code: 'PERSISTENCE_ERROR', message: 'Task history could not be saved.' }
  return { code: 'INTERNAL_ERROR', message: 'The task operation could not be completed.' }
}

function resolveEmployee(employeeInstanceId: string) {
  const instance = activeInstances.find(item => item.id === employeeInstanceId)
  const modelId = instance?.allowedModels?.[0]
  if (!instance || !modelId) return null
  return {
    employeeInstanceId,
    modelId,
    gatewayUrl: config.SEP_GATEWAY_URL,
  }
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
    taskCoordinator = new TaskExecutionCoordinator({
      taskManager: manager,
      getRefreshToken: () => authSession.getRefreshToken(),
      onAuthenticationRequired: invalidateAuthentication,
      onEvent: event => mainWindow?.webContents.send('pi:event', event),
      onApprovalRequest: request => mainWindow?.webContents.send('pi:tool-approval-request', request),
      resolveEmployee,
      userDataDir: app.getPath('userData'),
    })
  })()
  try { await taskCoordinatorInitialization } catch (error) { taskCoordinatorInitialization = null; throw error }
  return taskCoordinator!
}

// ── 1. 创建主窗口 ─────────────────────────────────────────────────────────────

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

  // Load renderer
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
    // Some Windows/Electron combinations do not emit ready-to-show when the
    // renderer is loaded from the Vite dev server. Do not leave the window
    // permanently hidden after a successful load.
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

// ── 2. Pi Host 初始化 ─────────────────────────────────────────────────────────

// ── 3. IPC handlers ───────────────────────────────────────────────────────────

// ── Auth: Login ──────────────────────────────────────────────────────────────

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
    authSession.clear()
    return { success: true, data: null }
  } catch (error) {
    return { success: false, error: mapAuthError(error) }
  }
})

// ── Auth: Get instances ──────────────────────────────────────────────────────

ipcMain.handle('auth:get-instances', async () => {
  try {
    const instances = await getInstances(authSession.getAccessToken());

    // Filter only ACTIVE instances
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

// ── Task Management ──────────────────────────────────────────────────────────

ipcMain.handle('task:create', async (_event, data: { title: string; prompt: string; workDir?: string; employeeInstanceId?: string }) => {
  try {
    if (!data || typeof data.title !== 'string' || typeof data.prompt !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'Invalid task request.' } }
    }
    const employeeInstanceId = data.employeeInstanceId
    if (typeof employeeInstanceId !== 'string' || !resolveEmployee(employeeInstanceId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee is unavailable.' } }
    }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(data.title, data.prompt, data.workDir, employeeInstanceId)
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
    const manager = await ensureTaskManager()
    const task = await manager.getTask(input.taskId)
    if (!task || !task.employeeInstanceId) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Task or employee binding not found.' } }
    }
    if (!resolveEmployee(task.employeeInstanceId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The task employee is unavailable.' } }
    }
    await (await ensureTaskCoordinator()).continueConversation(input.taskId, input.prompt)
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('task:switch-employee', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.employeeInstanceId !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task and employee are required.' } }
    }
    if (!resolveEmployee(input.employeeInstanceId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee is unavailable.' } }
    }
    await (await ensureTaskCoordinator()).switchConversationEmployee(input.taskId, input.employeeInstanceId)
    const manager = await ensureTaskManager()
    const scope = manager.getCurrentUserScope()
    if (scope) {
      const metadata = await ensureTaskMetadataStore().load(scope, input.taskId)
      if (metadata?.kind === 'conversation') {
        metadata.currentEmployeeId = input.employeeInstanceId
        if (!metadata.participantEmployeeIds.includes(input.employeeInstanceId)) metadata.participantEmployeeIds.push(input.employeeInstanceId)
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
    const employee = graph.nodes[0]?.employeeInstanceId
    if (!employee || !resolveEmployee(employee)) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The workflow employee is unavailable.' } }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(input.title.trim(), typeof input.prompt === 'string' ? input.prompt : input.title.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, employee)
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    await ensureWorkflowStore().save(scope, task.id, graph)
    await ensureTaskMetadataStore().save(scope, {
      version: 1, taskId: task.id, kind: 'workflow', participantEmployeeIds: [...new Set(graph.nodes.map(node => node.employeeInstanceId))],
      currentEmployeeId: employee, createdAt: Date.now(),
    })
    return { success: true, task, graph }
  } catch (error) {
    if (error instanceof WorkflowGraphError) return { success: false, error: { code: 'INVALID_ARGUMENT', message: error.message } }
    return { success: false, error: taskError(error) }
  }
})

ipcMain.handle('conversation:create', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || typeof input.prompt !== 'string' || !input.prompt.trim() || typeof input.employeeInstanceId !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A title, prompt, and employee are required.' } }
    }
    if (!resolveEmployee(input.employeeInstanceId)) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee is unavailable.' } }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(input.title.trim(), input.prompt.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, input.employeeInstanceId)
    const scope = manager.getCurrentUserScope()
    if (!scope) return { success: false, error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } }
    await ensureTaskMetadataStore().save(scope, {
      version: 1, taskId: task.id, kind: 'conversation', participantEmployeeIds: [input.employeeInstanceId],
      currentEmployeeId: input.employeeInstanceId, createdAt: Date.now(),
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
    if (!task.employeeInstanceId || !resolveEmployee(task.employeeInstanceId)) {
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

// ── Utility: Directory Selector ───────────────────────────────────────────────

ipcMain.handle('util:select-directory', async () => {
  if (!mainWindow) {
    return { success: false, error: { message: 'Main window not available' } };
  }

  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录',
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

// ── 4. App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  ensureTaskManager()
  // 延迟到首次任务执行时初始化任务协调器
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
