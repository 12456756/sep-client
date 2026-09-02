/**
 * electron/main.ts — Electron 主进程入口
 *
 * 职责:
 *   - 创建 BrowserWindow + preload 注入
 *   - 管理 pi session 生命周期（通过 TaskExecutionCoordinator）
 *   - 处理经过校验的 renderer <-> main IPC 通信
 *   - 应用生命周期管理（ready, quit, 等）
 */

import { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu } from 'electron';
import { join } from 'node:path';
import './infrastructure/undici-polyfill'; // Pi SDK 使用的网络兼容层。
import type { TaskExecutionCoordinator } from './tasks/task-execution-coordinator';
import { TaskManager } from './tasks/task-manager';
import { TaskRunStore, type TaskRunRecord } from './tasks/task-run-store';
import { getDeviceFingerprint } from './auth/device-fingerprint';
import { login, getInstances, AuthApiError, type ClientInstance } from './auth/auth-api';
import { AuthSessionManager } from './auth/auth-session-manager';
import { AuthenticationRequiredError } from './auth/authentication-required-error';
import { InstanceDirectory } from './auth/instance-directory';
import { config } from './infrastructure/config';
import { settleWithTimeout } from './common/with-timeout';
import { describeError } from './common/redact';
import { logger } from './common/logger';

const log = logger.child('main');
import { authFailure, failure, type IpcFailure } from './errors/error-mapper';
import {
  installProcessHandlers,
  reportAuthFailure,
  reportFailure,
  reportFatal,
  setFatalPresenter,
} from './errors/error-reporter';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from './controller/channels';
import type {
  ForgetAccountResult,
  LoginResult,
  LogoutResult,
  PasswordAvailabilityResult,
  RememberedAccountsResult,
} from '../src/shared/types';
import { createWorkflowGraph } from './tasks/domain/workflow-graph';
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
/** 平台订阅目录：TTL 缓存 + 单飞，避免一个 run 打多次 /client/subscriptions（C4）。 */
const instanceDirectory = new InstanceDirectory(getInstances);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
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
  activeInstances = await instanceDirectory.list(accessToken)
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

/** 认证失效清理的预算。stopAll 内部要等 worker.abort() 与在途事件落盘（C7）。 */
const AUTH_CLEANUP_BUDGET_MS = 5_000

function invalidateAuthentication(): void {
  if (authenticationCleanupPromise) return
  authenticationCleanupPromise = (async () => {
    // C7：必须有界。stopAll 会等每个 active run 的 abort 与 completion，
    // 无界等待会让"重新登录"这件事永远卡住，且清理只做了一半（scope 还在，token 已废）。
    const stopped = await settleWithTimeout(
      taskCoordinator ? taskCoordinator.stopAll() : Promise.resolve(),
      AUTH_CLEANUP_BUDGET_MS,
      'authentication-cleanup-stop-all',
    )
    if (!stopped.ok) {
      log.error('failed to stop Pi during authentication cleanup', {
        timedOut: stopped.timedOut,
        budgetMs: AUTH_CLEANUP_BUDGET_MS,
        cause: stopped.timedOut ? undefined : describeError(stopped.error),
      })
    }
    try {
      const manager = await ensureTaskManager()
      manager.clearCurrentUser()
    } catch (error) {
      log.error('failed to clear task scope during authentication cleanup', {
        cause: describeError(error),
      })
    } finally {
      activeInstances = []
      instanceDirectory.invalidate()
      subscriptionRuntime?.invalidate()
      authSession.clear()
      mainWindow?.webContents.send(EVENT_CHANNELS.AUTH_REQUIRED)
      authenticationCleanupPromise = null
    }
  })()
}

/**
 * 认证失效清理进行中。此时 token 已经作废、scope 还没清掉，是个半清理状态；
 * 任何任务操作都必须直接拒掉，不能在这个状态上继续写数据（C7）。
 */
function authenticationInvalidating(): boolean {
  return authenticationCleanupPromise !== null
}

/**
 * 取当前 scope，取不到就返回统一的错误信封。
 * main.ts 里原有 12 处逐字复制的 scope 守卫，这里先收成一个入口；
 * 正式落成 service/scope-guard.ts 在 Phase 5。
 */
function requireScope(manager: TaskManager):
  | { ok: true; scope: NonNullable<ReturnType<TaskManager['getCurrentUserScope']>> }
  | { ok: false; failure: IpcFailure } {
  // 清理进行中时 scope 还没清掉但已经不可信，必须先拒（C7）。
  if (authenticationInvalidating()) return { ok: false, failure: failure('AUTH_REQUIRED') }
  const scope = manager.getCurrentUserScope()
  if (!scope) return { ok: false, failure: failure('AUTH_REQUIRED') }
  return { ok: true, scope }
}

async function ensureTaskCoordinator(): Promise<TaskExecutionCoordinator> {
  if (taskCoordinator) return taskCoordinator
  if (taskCoordinatorInitialization) { await taskCoordinatorInitialization; return taskCoordinator! }
  taskCoordinatorInitialization = (async () => {
    if (!safeStorage.isEncryptionAvailable()) log.warn('safeStorage encryption is not available on this platform')
    const manager = await ensureTaskManager()
    // 将 Pi SDK 放在异步边界之后加载：其内置 undici 依赖的 Node API，
    // 只有先加载上面的兼容层后，Electron 33 才能提供。
    const { TaskExecutionCoordinator } = await import('./tasks/task-execution-coordinator')
    taskCoordinator = new TaskExecutionCoordinator({
      taskManager: manager,
      getRefreshToken: () => authSession.getRefreshToken(),
      onAuthenticationRequired: invalidateAuthentication,
      onEvent: event => mainWindow?.webContents.send(EVENT_CHANNELS.PI_EVENT, event),
      onApprovalRequest: request => mainWindow?.webContents.send(EVENT_CHANNELS.TOOL_APPROVAL_REQUEST, request),
      resolveEmployee,
      authorizeEmployee,
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

  // 加载渲染进程。
  if (process.env['ELECTRON_RENDERER_URL']) {
    log.debug('loading renderer from dev server');
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    log.debug('loading renderer from bundled file');
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('renderer failed to load', { errorCode, errorDescription });
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('renderer loaded');
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

  log.info('main window created');
}

// 2. TaskExecutionCoordinator 和 Pi 运行时。

// ── 3. IPC handlers ───────────────────────────────────────────────────────────

// ── Auth: Login ──────────────────────────────────────────────────────────────

ipcMain.handle(INVOKE_CHANNELS.AUTH_LOGIN, async (_event, input: unknown): Promise<LoginResult> => {
  try {
    if (!isRecord(input)) {
      return authFailure('INVALID_ARGUMENT', '登录请求参数不合法。');
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
      return authFailure('INVALID_ARGUMENT', '登录请求参数不合法。');
    }
    if (rememberPassword && !safeStorage.isEncryptionAvailable()) {
      return authFailure('STORAGE_UNAVAILABLE');
    }
    const password = useSavedPassword ? getRememberedPassword(email) : input.password as string;
    if (!password) {
      return authFailure('INVALID_ARGUMENT', '请重新输入密码。');
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
      return authFailure('SERVICE_UNAVAILABLE', '服务返回了无法识别的响应。');
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
    return reportAuthFailure(INVOKE_CHANNELS.AUTH_LOGIN, error);
  }
});

ipcMain.handle(INVOKE_CHANNELS.AUTH_LIST_REMEMBERED_ACCOUNTS, async (): Promise<RememberedAccountsResult> => ({
  accounts: listRememberedAccounts(),
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
}));

ipcMain.handle(INVOKE_CHANNELS.AUTH_GET_REMEMBERED_PASSWORD, async (_event, email: unknown): Promise<PasswordAvailabilityResult> => {
  const normalized = normalizeEmail(email);
  return { passwordAvailable: normalized ? Boolean(getRememberedPassword(normalized)) : false };
});

ipcMain.handle(INVOKE_CHANNELS.AUTH_FORGET_ACCOUNT, async (_event, email: unknown): Promise<ForgetAccountResult> => {
  const normalized = normalizeEmail(email);
  if (!normalized) return authFailure('INVALID_ARGUMENT', '请输入有效的邮箱地址。');
  try {
    forgetRememberedAccount(normalized);
    return { success: true, data: null };
  } catch (error) {
    return reportAuthFailure(INVOKE_CHANNELS.AUTH_FORGET_ACCOUNT, error);
  }
});

ipcMain.handle(INVOKE_CHANNELS.AUTH_LOGOUT, async (): Promise<LogoutResult> => {
  try {
    if (taskCoordinator) await taskCoordinator.stopAll()
    const manager = await ensureTaskManager()
    manager.clearCurrentUser()
    activeInstances = []
    subscriptionRuntime?.invalidate()
    authSession.clear()
    return { success: true, data: null }
  } catch (error) {
    return reportAuthFailure(INVOKE_CHANNELS.AUTH_LOGOUT, error)
  }
})

// ── Auth: Get instances ──────────────────────────────────────────────────────

ipcMain.handle(INVOKE_CHANNELS.AUTH_GET_INSTANCES, async () => {
  try {
    // 用户显式刷新：绕过 TTL，但仍与在途请求合并（C4）。只保留 ACTIVE 实例。
    activeInstances = await instanceDirectory.refresh(await authSession.getValidAccessToken());

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

ipcMain.handle(INVOKE_CHANNELS.TASK_CREATE, async (_event, data: unknown) => {
  try {
    if (!isRecord(data) || typeof data.title !== 'string' || !data.title.trim() || typeof data.prompt !== 'string' || !data.prompt.trim()) {
      return failure('INVALID_ARGUMENT', '任务请求参数不合法。')
    }
    if (typeof data.workDir !== 'undefined' && (typeof data.workDir !== 'string' || !data.workDir.trim())) {
      return failure('INVALID_ARGUMENT', '工作目录不合法。')
    }
    if (typeof data.subscriptionId !== 'string') {
      return failure('INVALID_ARGUMENT', '所选硅基员工不合法。')
    }
    const subscriptionId = data.subscriptionId
    if (!await authorizeEmployee(subscriptionId)) {
      return failure('INVALID_ARGUMENT')
    }
    const manager = await ensureTaskManager()
    const task = await manager.createTask(data.title.trim(), data.prompt.trim(), data.workDir?.trim(), subscriptionId)
  // 当前 renderer 的对话编辑器使用 task:create。
  // 在 task:create 边界完成初始化，确保首轮运行被识别为对话任务，
  // 并使用任务级共享 Pi 会话。
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
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
    return reportFailure(INVOKE_CHANNELS.TASK_CREATE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_EXECUTE, async (_event, input: unknown) => {
  try {
    const taskId = typeof input === 'string'
      ? input
      : isRecord(input) && typeof input.taskId === 'string'
        ? input.taskId
        : null
    if (!taskId) {
      return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    }
    const manager = await ensureTaskManager()
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const metadata = await ensureTaskMetadataStore().load(guard.scope, taskId)
    await (await ensureTaskCoordinator()).executeTask(taskId, { conversation: metadata?.kind === 'conversation' })
    return { success: true }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_EXECUTE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_CONTINUE, async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.prompt !== 'string' || !input.prompt.trim()) {
      return failure('INVALID_ARGUMENT', '需要有效的任务与消息内容。')
    }
    const validRecoveryModes = new Set(['strict', 'confirm_rebuild', 'auto_rebuild_from_task_history'])
    if (typeof input.recoveryMode !== 'undefined' && (typeof input.recoveryMode !== 'string' || !validRecoveryModes.has(input.recoveryMode))) {
      return failure('INVALID_ARGUMENT', '会话恢复模式不合法。')
    }
    if (typeof input.confirmRecovery !== 'undefined' && typeof input.confirmRecovery !== 'boolean') {
      return failure('INVALID_ARGUMENT', '会话恢复确认参数不合法。')
    }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(input.taskId)
    if (!task || !task.subscriptionId) {
      return failure('NOT_FOUND', '未找到任务或其硅基员工绑定。')
    }
    if (!await authorizeEmployee(task.subscriptionId)) {
      return failure('INVALID_ARGUMENT')
    }
    await (await ensureTaskCoordinator()).continueConversation(input.taskId, input.prompt, {
      mode: input.recoveryMode === 'strict' || input.recoveryMode === 'auto_rebuild_from_task_history' ? input.recoveryMode : 'confirm_rebuild',
      confirmed: input.confirmRecovery === true,
    })
    return { success: true }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_CONTINUE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_SWITCH_EMPLOYEE, async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.subscriptionId !== 'string') {
      return failure('INVALID_ARGUMENT', '需要有效的任务与硅基员工。')
    }
    if (!await authorizeEmployee(input.subscriptionId)) {
      return failure('INVALID_ARGUMENT')
    }
    await (await ensureTaskCoordinator()).switchConversationEmployee(input.taskId, input.subscriptionId)
    const manager = await ensureTaskManager()
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const metadata = await ensureTaskMetadataStore().load(guard.scope, input.taskId)
    if (metadata?.kind === 'conversation') {
      metadata.currentSubscriptionId = input.subscriptionId
      if (!metadata.participantSubscriptionIds.includes(input.subscriptionId)) metadata.participantSubscriptionIds.push(input.subscriptionId)
      await ensureTaskMetadataStore().save(guard.scope, metadata)
    }
    return { success: true }
  } catch (error) { return reportFailure(INVOKE_CHANNELS.TASK_SWITCH_EMPLOYEE, error, { authenticated: true }) }
})

ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_VALIDATE, async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || !Array.isArray(input.nodes)) {
      return failure('INVALID_ARGUMENT', '需要提供工作流节点。')
    }
    return { success: true, graph: createWorkflowGraph(input.nodes as never) }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.WORKFLOW_VALIDATE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_CREATE, async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || !Array.isArray(input.nodes)) {
      return failure('INVALID_ARGUMENT', '需要提供标题与工作流节点。')
    }
    const graph = createWorkflowGraph(input.nodes as never)
    const employee = graph.nodes[0]?.subscriptionId
    if (!employee || !await authorizeEmployee(employee)) return failure('INVALID_ARGUMENT')
    const manager = await ensureTaskManager()
    const task = await manager.createTask(input.title.trim(), typeof input.prompt === 'string' ? input.prompt : input.title.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, employee)
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
    await ensureWorkflowStore().save(scope, task.id, graph)
    await ensureTaskMetadataStore().save(scope, {
      version: 1, taskId: task.id, kind: 'workflow', participantSubscriptionIds: [...new Set(graph.nodes.map(node => node.subscriptionId))],
      currentSubscriptionId: employee, createdAt: Date.now(),
    })
    return { success: true, task, graph }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.WORKFLOW_CREATE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.CONVERSATION_CREATE, async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || typeof input.prompt !== 'string' || !input.prompt.trim() || typeof input.subscriptionId !== 'string') {
      return failure('INVALID_ARGUMENT', '需要提供标题、任务描述与硅基员工。')
    }
    if (!await authorizeEmployee(input.subscriptionId)) return failure('INVALID_ARGUMENT')
    const manager = await ensureTaskManager()
    const task = await manager.createTask(input.title.trim(), input.prompt.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, input.subscriptionId)
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
    await ensureTaskMetadataStore().save(scope, {
      version: 1, taskId: task.id, kind: 'conversation', participantSubscriptionIds: [input.subscriptionId],
      currentSubscriptionId: input.subscriptionId, createdAt: Date.now(),
    })
    return { success: true, task }
  } catch (error) { return reportFailure(INVOKE_CHANNELS.CONVERSATION_CREATE, error, { authenticated: true }) }
})

ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_GET, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    const manager = await ensureTaskManager()
    if (!await manager.getTask(taskId)) return failure('NOT_FOUND', '未找到该任务。')
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
    const graph = await ensureWorkflowStore().load(scope, taskId)
    if (!graph) return failure('NOT_FOUND', '未找到该工作流。')
    return { success: true, graph }
  } catch (error) { return reportFailure(INVOKE_CHANNELS.WORKFLOW_GET, error, { authenticated: true }) }
})

ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_START, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return failure('NOT_FOUND', '未找到该任务。')
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    if (!await ensureWorkflowStore().load(guard.scope, taskId)) return failure('INVALID_STATE', '需要有效的工作流定义。')
    await (await ensureTaskCoordinator()).executeTask(taskId)
    return { success: true }
  } catch (error) { return reportFailure(INVOKE_CHANNELS.WORKFLOW_START, error, { authenticated: true }) }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_GET_MESSAGES, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return failure('NOT_FOUND', '未找到该任务。')
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
    return { success: true, messages: await ensureTaskRunStore().getMessages(scope, taskId, task.prompt) }
  } catch (error) { return reportFailure(INVOKE_CHANNELS.TASK_GET_MESSAGES, error, { authenticated: true }) }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_RETRY, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return failure('NOT_FOUND', '未找到该任务。')
    if (!task.subscriptionId || !await authorizeEmployee(task.subscriptionId)) {
      return failure('INVALID_ARGUMENT')
    }
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const metadata = await ensureTaskMetadataStore().load(guard.scope, taskId)
    await (await ensureTaskCoordinator()).retryTask(taskId, { conversation: metadata?.kind === 'conversation' })
    return { success: true }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_RETRY, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_GET, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    }
    const manager = await ensureTaskManager()
    const task = await manager.getTask(taskId)
    if (!task) return failure('NOT_FOUND', '未找到该任务。')
    return { success: true, task }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_GET, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_GET_ALL, async () => {
  try {
    const manager = await ensureTaskManager()
    return { success: true, tasks: await manager.getAllTasks() }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_GET_ALL, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_LIST_RUNS, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    const manager = await ensureTaskManager()
    if (!await manager.getTask(taskId)) return failure('NOT_FOUND', '未找到该任务。')
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
    const runs = await ensureTaskRunStore().list(scope, taskId)
    return { success: true, runs: runs.map(toClientTaskRun) }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_LIST_RUNS, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_GET_RUN, async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.runId !== 'string') {
      return failure('INVALID_ARGUMENT', '需要有效的任务与执行记录 ID。')
    }
    const manager = await ensureTaskManager()
    if (!await manager.getTask(input.taskId)) return failure('NOT_FOUND', '未找到该任务。')
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
    const run = await ensureTaskRunStore().get(scope, input.taskId, input.runId)
    if (!run) return failure('NOT_FOUND', '未找到该执行记录。')
    return { success: true, run: toClientTaskRun(run) }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_GET_RUN, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_GET_TIMELINE, async (_event, input: unknown) => {
  try {
    if (!isRecord(input) || typeof input.taskId !== 'string' || typeof input.runId !== 'string') {
      return failure('INVALID_ARGUMENT', '需要有效的任务与执行记录 ID。')
    }
    const manager = await ensureTaskManager()
    if (!await manager.getTask(input.taskId)) return failure('NOT_FOUND', '未找到该任务。')
    const guard = requireScope(manager)
    if (!guard.ok) return guard.failure
    const scope = guard.scope
    const run = await ensureTaskRunStore().get(scope, input.taskId, input.runId)
    if (!run) return failure('NOT_FOUND', '未找到该执行记录。')
    return { success: true, events: await ensureTaskRunStore().getTimeline(scope, input.taskId, input.runId) }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_GET_TIMELINE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_PAUSE, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    }
    await (await ensureTaskCoordinator()).pauseTask(taskId)
    return { success: true }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_PAUSE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_CANCEL, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    }
    await (await ensureTaskCoordinator()).cancelTask(taskId)
    return { success: true }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_CANCEL, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_DELETE, async (_event, taskId: unknown) => {
  try {
    if (typeof taskId !== 'string' || !taskId) {
      return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
    }
    const manager = await ensureTaskManager()
    if (!await manager.deleteTask(taskId)) {
      return failure('INVALID_STATE', '任务正在执行，无法删除。')
    }
    return { success: true }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_DELETE, error, { authenticated: true })
  }
})

ipcMain.handle(INVOKE_CHANNELS.TASK_GET_STATS, async () => {
  try {
    const manager = await ensureTaskManager()
    return { success: true, stats: await manager.getTaskStats() }
  } catch (error) {
    return reportFailure(INVOKE_CHANNELS.TASK_GET_STATS, error, { authenticated: true })
  }
})

ipcMain.on(SEND_CHANNELS.TOOL_APPROVAL_RESPONSE, (_event, response: unknown) => {
  if (!taskCoordinator || !isRecord(response)) return
  // 渲染进程送来的参数一律先校验。requestId 必填（C5）：缺了就不批，不做任何推断。
  if (typeof response['requestId'] !== 'string' || !response['requestId'] || typeof response['approved'] !== 'boolean') {
    log.warn('discarded malformed tool approval response')
    return
  }
  taskCoordinator.respondToApproval({
    requestId: response['requestId'],
    approved: response['approved'],
    reason: typeof response['reason'] === 'string' ? response['reason'] : undefined,
  })
})

// ── Utility: Directory Selector ───────────────────────────────────────────────

ipcMain.handle(INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY, async () => {
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

/** 停机预算。必须有界：worker.abort() 与事件落盘都可能卡住（C3/C7）。 */
const SHUTDOWN_BUDGET_MS = 5_000

let shuttingDown = false

async function stopAllAndDispose(): Promise<void> {
  if (!taskCoordinator) return
  await taskCoordinator.stopAll()
}

app.whenReady().then(async () => {
  // 报错模块的两件兜底：进程级异常有痕迹，致命错误用户看得见（第 4.3 节）。
  setFatalPresenter((title, message) => dialog.showErrorBox(title, message));
  installProcessHandlers();
  log.info('application ready', { version: app.getVersion(), platform: process.platform });

  // 必须 await：不 await 的话初始化失败会变成无人处理的 rejection，
  // 而窗口已经打开，用户看到的是一个"能打开但坏掉"的应用（C3）。
  try {
    await ensureTaskManager()
  } catch (error) {
    reportFatal('无法启动任务运行时', error, { stage: 'task-manager-init' })
  }
  // 任务协调器延迟到首次任务执行时初始化（SDK 加载边界，见 CLAUDE.md）。
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

// C3：Electron 不 await 生命周期监听器的返回值，原来挂在 will-quit 上的 async
// stopAll() 在第一个 await 处就被丢下，进程继续退出。改成两阶段：先拦住退出，
// 在有界预算内收干净，再强制 exit。
app.on('before-quit', event => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  const startedAt = Date.now()
  log.info('shutdown started', { coordinatorLoaded: taskCoordinator !== null })
  void settleWithTimeout(stopAllAndDispose(), SHUTDOWN_BUDGET_MS, 'shutdown')
    .then(result => {
      if (result.ok) {
        log.info('shutdown complete', { elapsedMs: Date.now() - startedAt })
        return
      }
      // 超时说明有 run 没收干净：SIDE_EFFECT_UNKNOWN 可能没落盘，
      // 下次启动只能靠 markActiveRunsInterrupted 兜底，精度更低。
      log.error('shutdown did not finish within budget', {
        elapsedMs: Date.now() - startedAt,
        budgetMs: SHUTDOWN_BUDGET_MS,
        timedOut: result.timedOut,
        cause: result.timedOut ? undefined : describeError(result.error),
      })
    })
    .finally(() => app.exit(0))
});
