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
import './infrastructure/undici-polyfill'; // 必须在 pi-host 加载前注入
import type { PiHost } from './pi/pi-host';
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
import {
  forgetRememberedAccount,
  getRememberedPassword,
  listRememberedAccounts,
  saveRememberedAccount,
} from './auth/credentials';

let mainWindow: BrowserWindow | null = null;
let piHost: PiHost | null = null;
let piHostInitialization: Promise<void> | null = null;
let taskManager: TaskManager | null = null;
let taskRunStore: TaskRunStore | null = null;
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
      if (piHost) await piHost.stopAllSessions()
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

// 延迟加载 PiHost，避免启动时加载 pi-coding-agent
async function loadPiHost(): Promise<typeof import('./pi/pi-host')> {
  return await import('./pi/pi-host');
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
      sandbox: false, // pi-host runs in main, renderer is sandboxed via contextBridge
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

async function initPiHost(): Promise<void> {
  if (piHost) return
  if (piHostInitialization) return piHostInitialization

  piHostInitialization = (async () => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[main] safeStorage encryption NOT available on this platform');
  }

  // Task storage and the Pi SDK are independent startup work.
  const [manager, { PiHost }] = await Promise.all([
    ensureTaskManager(),
    loadPiHost(),
  ])
  console.log('[main] task-manager initialized');

  piHost = new PiHost({
    onEvent: (event) => {
      // Forward pi events to renderer
      mainWindow?.webContents.send('pi:event', event);
    },
    onToolApprovalRequest: request => {
      mainWindow?.webContents.send('pi:tool-approval-request', request)
    },
    taskManager: manager,
    getRefreshToken: () => authSession.getRefreshToken(),
    onAuthenticationRequired: invalidateAuthentication,
    resolveEmployee,
    userDataDir: app.getPath('userData'),
  });

  console.log('[main] pi-host initialized');
  })()

  try {
    await piHostInitialization
  } catch (error) {
    piHostInitialization = null
    throw error
  }
}

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

    if (piHost) await piHost.stopAllSessions()
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
    if (piHost) await piHost.stopAllSessions()
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
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    await piHost.executeTask(taskId)
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
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    await piHost.continueTask(input.taskId, input.prompt)
    return { success: true }
  } catch (error) {
    return { success: false, error: taskError(error) }
  }
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
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    await piHost.retryTask(taskId)
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
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    await piHost.pauseTask(taskId)
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
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    await piHost.cancelTask(taskId)
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
  if (!piHost || typeof response?.approved !== 'boolean') return
  piHost.respondToApproval({
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
  // 不在启动时初始化 PiHost，延迟到用户选择实例后
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
  if (piHost) {
    await piHost.stopAllSessions()
  }
});
