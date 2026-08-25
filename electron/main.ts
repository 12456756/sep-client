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
import {
  login,
  getSubscriptions,
  getPackageInfo,
  getEmployeeSkills,
  getSkillPreview,
  getKnowledgeBaseGrants,
  searchKnowledgeBases,
  refreshAccessToken,
  AuthApiError,
  type SubscriptionSnapshot,
  type KnowledgeBaseSearchRequest,
} from './auth/auth-api';
import { AuthSessionManager, AuthenticationRequiredError } from './auth/auth-session-manager';
import { config } from './infrastructure/config';
import { SubscriptionRuntimeManager, type PreparedSubscriptionRuntime } from './runtime/subscription-runtime';
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
  clearCredentials,
  getAuthMeta,
  getRefreshToken,
  getRememberedPassword,
  listRememberedAccounts,
  saveRememberedAccount,
  saveAuthMeta,
  saveRefreshToken,
} from './auth/credentials';

let mainWindow: BrowserWindow | null = null;
let piHost: PiHost | null = null;
let piHostInitialization: Promise<void> | null = null;
let taskManager: TaskManager | null = null;
let taskRunStore: TaskRunStore | null = null;
let activeSubscriptions: SubscriptionSnapshot[] = [];
let activeSubscriptionId: string | null = null;
const preparedRuntimes = new Map<string, PreparedSubscriptionRuntime>();
let authenticationCleanupPromise: Promise<void> | null = null;
const authSession = new AuthSessionManager({
  refreshAccessToken,
  storage: {
    getRefreshToken,
    getAuthMeta,
    saveRefreshToken,
    saveAuthMeta,
    clearCredentials,
  },
});
let subscriptionRuntime: SubscriptionRuntimeManager | null = null;

function ensureSubscriptionRuntime(): SubscriptionRuntimeManager {
  if (!subscriptionRuntime) subscriptionRuntime = new SubscriptionRuntimeManager(app.getPath('userData'), app.getVersion())
  return subscriptionRuntime
}

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
  if (error instanceof TaskScopeError) return { code: 'AUTH_REQUIRED', message: error.message }
  if (error instanceof TaskPersistenceError) return { code: 'PERSISTENCE_ERROR', message: 'Task history could not be saved.' }
  return { code: 'INTERNAL_ERROR', message: 'The task operation could not be completed.' }
}

function resolveEmployee(subscriptionId: string, requestedModelId?: string | null) {
  const subscription = activeSubscriptions.find(item => item.subscriptionId === subscriptionId)
  const modelId = requestedModelId || subscription?.allowedModels?.[0]
  if (!subscription || !modelId || !subscription.allowedModels.includes(modelId)) return null
  const runtime = preparedRuntimes.get(subscriptionId)
  return {
    subscriptionId,
    modelId,
    gatewayUrl: config.SEP_GATEWAY_URL,
    skillPaths: runtime?.skillPaths,
    agentsFiles: runtime?.agentsFiles,
    systemPrompt: runtime?.systemPrompt,
  }
}

async function prepareSubscription(subscriptionId: string): Promise<void> {
  const subscription = activeSubscriptions.find(item => item.subscriptionId === subscriptionId)
  if (!subscription) throw new AuthApiError({ statusCode: 403, message: 'The selected subscription is no longer available.', error: 'Forbidden' })
  const accessToken = await authSession.getValidAccessToken()
  const meta = authSession.getMeta()
  if (!meta) throw new AuthenticationRequiredError()
  const runtime = await ensureSubscriptionRuntime().prepare(subscription, accessToken, meta.enterpriseId)
  preparedRuntimes.set(subscriptionId, runtime)
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
      activeSubscriptions = []
      activeSubscriptionId = null
      preparedRuntimes.clear()
      authSession.clear()
      mainWindow?.webContents.send('auth:required')
      authenticationCleanupPromise = null
    }
  })()
}

function invalidateSubscriptionAuthorization(subscriptionId: string, status: 403 | 404): void {
  activeSubscriptions = activeSubscriptions.filter(item => item.subscriptionId !== subscriptionId)
  preparedRuntimes.delete(subscriptionId)
  if (activeSubscriptionId === subscriptionId) activeSubscriptionId = null
  mainWindow?.webContents.send('subscription:authorization-rejected', { subscriptionId, status })
  void refreshSubscriptionDirectory(true).catch(error => {
    console.warn('[main] Failed to refresh subscriptions after gateway rejection:', error instanceof Error ? error.name : 'unknown')
  })
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
      color: '#00000000',
      symbolColor: '#6f6567',
      height: 40,
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
    onSubscriptionAuthorizationRejected: invalidateSubscriptionAuthorization,
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
    activeSubscriptions = []
    activeSubscriptionId = null
    preparedRuntimes.clear()
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
    activeSubscriptions = []
    activeSubscriptionId = null
    preparedRuntimes.clear()
    authSession.clear()
    return { success: true, data: null }
  } catch (error) {
    return { success: false, error: mapAuthError(error) }
  }
})

ipcMain.handle('auth:get-current-session', async (): Promise<LoginResult> => {
  try {
    const meta = await authSession.restore()
    if (!meta) return { success: false, error: authError('AUTH_REQUIRED', 'Please sign in.', 401) }
    const manager = await ensureTaskManager()
    await manager.setCurrentUser(meta.memberId, meta.enterpriseId)
    return {
      success: true,
      data: {
        user: { id: meta.memberId, email: meta.email, name: meta.displayName },
        enterprise: { id: meta.enterpriseId, name: meta.enterpriseName },
      },
    }
  } catch (error) {
    return { success: false, error: mapAuthError(error) }
  }
})

// ── Auth: Get subscriptions ─────────────────────────────────────────────────

async function refreshSubscriptionDirectory(notifyRenderer = false): Promise<SubscriptionSnapshot[]> {
  const subscriptions = await getSubscriptions(await authSession.getValidAccessToken())
  activeSubscriptions = subscriptions.filter(subscription => subscription.status === 'ACTIVE')
  if (activeSubscriptionId && !activeSubscriptions.some(subscription => subscription.subscriptionId === activeSubscriptionId)) {
    preparedRuntimes.delete(activeSubscriptionId)
    activeSubscriptionId = null
  }
  if (notifyRenderer) mainWindow?.webContents.send('subscription:directory-updated', activeSubscriptions)
  return activeSubscriptions
}

async function loadSubscriptions() {
  try {
    return {
      success: true,
      data: await refreshSubscriptionDirectory(),
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
}

ipcMain.handle('auth:get-subscriptions', loadSubscriptions)
// Compatibility channel for older renderer builds during the endpoint migration.
ipcMain.handle('auth:get-instances', loadSubscriptions)

ipcMain.handle('subscription:get-package', async (_event, subscriptionId: unknown) => {
  try {
    if (typeof subscriptionId !== 'string' || !subscriptionId) return { success: false, error: { message: 'A valid subscription ID is required.', statusCode: 400 } }
    return { success: true, data: await getPackageInfo(await authSession.getValidAccessToken(), subscriptionId) }
  } catch (error) {
    if (error instanceof AuthApiError && error.isUnauthorized) invalidateAuthentication()
    return { success: false, error: { message: error instanceof Error ? error.message : 'Package lookup failed.', statusCode: error instanceof AuthApiError ? error.statusCode : 0 } }
  }
})

ipcMain.handle('subscription:get-skills', async (_event, employeeId: unknown) => {
  try {
    if (typeof employeeId !== 'string' || !employeeId) return { success: false, error: { message: 'A valid employee ID is required.', statusCode: 400 } }
    return { success: true, data: await getEmployeeSkills(await authSession.getValidAccessToken(), employeeId) }
  } catch (error) {
    if (error instanceof AuthApiError && error.isUnauthorized) invalidateAuthentication()
    return { success: false, error: { message: error instanceof Error ? error.message : 'Skill lookup failed.', statusCode: error instanceof AuthApiError ? error.statusCode : 0 } }
  }
})

ipcMain.handle('subscription:get-skill-preview', async (_event, versionId: unknown) => {
  try {
    if (typeof versionId !== 'string' || !versionId) return { success: false, error: { message: 'A valid skill version ID is required.', statusCode: 400 } }
    return { success: true, data: await getSkillPreview(await authSession.getValidAccessToken(), versionId) }
  } catch (error) {
    if (error instanceof AuthApiError && error.isUnauthorized) invalidateAuthentication()
    return { success: false, error: { message: error instanceof Error ? error.message : 'Skill preview failed.', statusCode: error instanceof AuthApiError ? error.statusCode : 0 } }
  }
})

ipcMain.handle('subscription:get-knowledge-base-grants', async (_event, subscriptionId: unknown) => {
  try {
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      return { success: false, error: { message: 'A valid subscription ID is required.', statusCode: 400 } }
    }
    return { success: true, data: await getKnowledgeBaseGrants(await authSession.getValidAccessToken(), subscriptionId) }
  } catch (error) {
    if (error instanceof AuthApiError && error.isUnauthorized) invalidateAuthentication()
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Knowledge base grants lookup failed.',
        statusCode: error instanceof AuthApiError ? error.statusCode : 0,
      },
    }
  }
})

ipcMain.handle('subscription:search-knowledge-bases', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.query !== 'string' || typeof input.subscriptionId !== 'string') {
      return { success: false, error: { message: 'A query and subscription ID are required.', statusCode: 400 } }
    }
    const strategy = isKnowledgeBaseSearchStrategy(input.strategy) ? input.strategy : undefined
    const request: KnowledgeBaseSearchRequest = {
      query: input.query,
      subscriptionId: input.subscriptionId,
      ...(typeof input.topK === 'number' ? { topK: input.topK } : {}),
      ...(typeof input.scoreThreshold === 'number' ? { scoreThreshold: input.scoreThreshold } : {}),
      ...(strategy ? { strategy } : {}),
    }
    return { success: true, data: await searchKnowledgeBases(await authSession.getValidAccessToken(), request) }
  } catch (error) {
    if (error instanceof AuthApiError && error.isUnauthorized) invalidateAuthentication()
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Knowledge base search failed.',
        statusCode: error instanceof AuthApiError ? error.statusCode : 0,
      },
    }
  }
})

function isKnowledgeBaseSearchStrategy(value: unknown): value is NonNullable<KnowledgeBaseSearchRequest['strategy']> {
  return value === 'auto' || value === 'lexical' || value === 'vector' || value === 'hybrid'

}

// ── Pi Session ───────────────────────────────────────────────────────────────

ipcMain.handle('pi:start-session', async (_event, session: { subscriptionId: string }) => {
  try {
    if (typeof session?.subscriptionId !== 'string' || !session.subscriptionId) {
      return {
        success: false,
        error: { message: 'A valid employee ID is required', statusCode: 400 },
      };
    }
    if (!resolveEmployee(session.subscriptionId)) {
      return {
        success: false,
        error: { message: 'The selected subscription is no longer available.', statusCode: 403 },
      };
    }

    // 按需初始化 PiHost（首次使用时）
    if (!piHost) {
      await initPiHost();
    }
    if (!piHost) throw new Error('Failed to initialize piHost');
    await prepareSubscription(session.subscriptionId)
    await piHost.startSession({ subscriptionId: session.subscriptionId })
    activeSubscriptionId = session.subscriptionId
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Failed to start session',
        statusCode: error instanceof AuthApiError ? error.statusCode : 0,
      },
    };
  }
});

ipcMain.handle('pi:send-prompt', async (_event, text: string) => {
  if (!piHost) throw new Error('piHost not initialized');
  await piHost.sendPrompt(text);
  return { ok: true };
});

ipcMain.handle('pi:stop-session', async (_event, subscriptionId?: unknown) => {
  if (!piHost) throw new Error('piHost not initialized')
  if (typeof subscriptionId !== 'undefined' && (typeof subscriptionId !== 'string' || !subscriptionId)) {
    return { ok: false }
  }
  await piHost.stopSession(subscriptionId)
  return { ok: true }
})

// ── Task Management ──────────────────────────────────────────────────────────

ipcMain.handle('task:create', async (_event, data: { title: string; prompt: string; workDir?: string; subscriptionId?: string; modelId?: string }) => {
  try {
    if (!data || typeof data.title !== 'string' || typeof data.prompt !== 'string') {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'Invalid task request.' } }
    }
    const subscriptionId = data.subscriptionId ?? activeSubscriptionId
    const employee = subscriptionId ? resolveEmployee(subscriptionId, data.modelId) : null
    if (subscriptionId && !employee) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected employee or model is unavailable.' } }
    }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(data.title, data.prompt, data.workDir, subscriptionId, employee?.modelId ?? null)
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
    const subscriptionId = isRecord(input) && typeof input.subscriptionId === 'string'
      ? input.subscriptionId
      : activeSubscriptionId
    if (!taskId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task ID is required.' } }
    }
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    if (subscriptionId) {
      await prepareSubscription(subscriptionId)
      await piHost.startSession({ subscriptionId })
    }
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
    if (!task || !task.subscriptionId) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Task or employee binding not found.' } }
    }
    const subscriptionId = typeof input.subscriptionId === 'string' ? input.subscriptionId : task.subscriptionId
    if (subscriptionId !== task.subscriptionId || !resolveEmployee(subscriptionId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The task employee is unavailable.' } }
    }
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    await prepareSubscription(subscriptionId)
    await piHost.startSession({ subscriptionId })
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
    const subscriptionId = task.subscriptionId ?? activeSubscriptionId
    if (!subscriptionId || !resolveEmployee(subscriptionId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The task employee is unavailable.' } }
    }
    if (!piHost) await initPiHost()
    if (!piHost) throw new Error('Pi host is unavailable.')
    await prepareSubscription(subscriptionId)
    await piHost.startSession({ subscriptionId })
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

ipcMain.handle('task:set-model', async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.modelId !== 'string' || !input.taskId || !input.modelId) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'A valid task and model are required.' } }
    }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(input.taskId)
    if (!task || !task.subscriptionId) return { success: false, error: { code: 'NOT_FOUND', message: 'Task or subscription binding not found.' } }
    if (!resolveEmployee(task.subscriptionId, input.modelId)) {
      return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'The selected model is unavailable.' } }
    }
    await manager.setTaskModel(input.taskId, input.modelId)
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

  app.on('browser-window-focus', () => {
    if (!authSession.getMeta()) return
    void refreshSubscriptionDirectory(true).catch(error => {
      if (error instanceof AuthenticationRequiredError || error instanceof AuthApiError && error.isUnauthorized) {
        invalidateAuthentication()
      }
    })
  })
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
