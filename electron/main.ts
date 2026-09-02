/**
 * electron/main.ts — Electron 主进程入口
 *
 * 职责:
 *   - 兼容层 → 组装后端 → 注册 IPC → 窗口与生命周期
 *   - 处理经过校验的 renderer <-> main IPC 通信
 *
 * 这里不再有模块级可变状态：后端由 bootstrap/composition-root.ts 装配，
 * 窗口引用归 bootstrap/renderer-bridge.ts。IPC 处理器在 createBackend() 成功之后
 * 才注册，所以它们拿到的 backend 一定是就绪的（Phase 6 会把它们搬进 controller/routes/）。
 */
import './common/undici-polyfill'; // Pi SDK 使用的网络兼容层，必须是第一个副作用 import。
import { app, BrowserWindow, ipcMain, safeStorage, dialog } from 'electron';
import { createBackend, type Backend } from './bootstrap/composition-root';
import { createMainWindow } from './bootstrap/main-window';
import { RendererBridge } from './bootstrap/renderer-bridge';
import { installShutdownHandler } from './bootstrap/shutdown';
import { getDeviceFingerprint } from './common/platform/device-fingerprint';
import { login, AuthApiError } from './common/platform/platform-api';
import { AuthenticationRequiredError } from './common/platform/authentication-required-error';
import { logger } from './common/logger';
import { authFailure, failure, type IpcFailure } from './errors/error-mapper';
import {
  installProcessHandlers,
  reportAuthFailure,
  reportFailure,
  reportFatal,
  setFatalPresenter,
} from './errors/error-reporter';
import { INVOKE_CHANNELS, SEND_CHANNELS } from './controller/channels';
import type {
  ForgetAccountResult,
  LoginResult,
  LogoutResult,
  PasswordAvailabilityResult,
  RememberedAccountsResult,
} from '../src/shared/types';
import { createWorkflowGraph } from './domain/workflow-graph';
import type { TaskOwnerScope } from './data/task-store';
import type { TaskRunRecord } from './data/task-run-store';
import {
  forgetRememberedAccount,
  getRememberedPassword,
  listRememberedAccounts,
  saveRememberedAccount,
} from './common/platform/credential-vault';

const log = logger.child('main');

/** main -> renderer 的唯一出口，同时持有当前窗口。 */
const bridge = new RendererBridge();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
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
  };
}

/**
 * 取当前 scope，取不到就返回统一的错误信封。main.ts 里原有 12 处逐字复制的守卫，
 * 收成这一个入口；`backend.currentScope()` 里已经含了"认证失效清理进行中"的判断（C7）。
 * 正式落成 service/scope-guard.ts 在 Phase 5。
 */
function requireScope(backend: Backend):
  | { ok: true; scope: TaskOwnerScope }
  | { ok: false; failure: IpcFailure } {
  const scope = backend.currentScope();
  if (!scope) return { ok: false, failure: failure('AUTH_REQUIRED') };
  return { ok: true, scope };
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIpcHandlers(backend: Backend): void {
  // ── Auth: Login ────────────────────────────────────────────────────────────

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

      await backend.stopAll();
      backend.authSession.setLogin(response);
      await backend.taskManager.setCurrentUser(response.user.id, response.enterprise.id);
      backend.employees.clear();
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
      backend.authSession.clear();
      backend.taskManager.clearCurrentUser();
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
      await backend.signOut();
      return { success: true, data: null };
    } catch (error) {
      return reportAuthFailure(INVOKE_CHANNELS.AUTH_LOGOUT, error);
    }
  });

  // ── Auth: Get instances ────────────────────────────────────────────────────

  ipcMain.handle(INVOKE_CHANNELS.AUTH_GET_INSTANCES, async () => {
    try {
      return { success: true, data: await backend.employees.refresh() };
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        backend.invalidateAuthentication();
        return { success: false, error: { message: error.message, statusCode: 401 } };
      }
      if (error instanceof AuthApiError) {
        if (error.isUnauthorized) backend.invalidateAuthentication();
        return { success: false, error: { message: error.message, statusCode: error.statusCode } };
      }
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error', statusCode: 0 },
      };
    }
  });

  // ── Task Management ────────────────────────────────────────────────────────

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
      if (!await backend.employees.authorize(subscriptionId)) {
        return failure('INVALID_ARGUMENT')
      }
      const task = await backend.taskManager.createTask(data.title.trim(), data.prompt.trim(), data.workDir?.trim(), subscriptionId)
      // 当前 renderer 的对话编辑器使用 task:create。
      // 在 task:create 边界完成初始化，确保首轮运行被识别为对话任务，
      // 并使用任务级共享 Pi 会话。
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      await backend.taskMetadataStore.save(guard.scope, {
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
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const metadata = await backend.taskMetadataStore.load(guard.scope, taskId)
      await (await backend.getTaskCoordinator()).executeTask(taskId, { conversation: metadata?.kind === 'conversation' })
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
      const task = await backend.taskManager.getTask(input.taskId)
      if (!task || !task.subscriptionId) {
        return failure('NOT_FOUND', '未找到任务或其硅基员工绑定。')
      }
      if (!await backend.employees.authorize(task.subscriptionId)) {
        return failure('INVALID_ARGUMENT')
      }
      await (await backend.getTaskCoordinator()).continueConversation(input.taskId, input.prompt, {
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
      if (!await backend.employees.authorize(input.subscriptionId)) {
        return failure('INVALID_ARGUMENT')
      }
      await (await backend.getTaskCoordinator()).switchConversationEmployee(input.taskId, input.subscriptionId)
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const metadata = await backend.taskMetadataStore.load(guard.scope, input.taskId)
      if (metadata?.kind === 'conversation') {
        metadata.currentSubscriptionId = input.subscriptionId
        if (!metadata.participantSubscriptionIds.includes(input.subscriptionId)) metadata.participantSubscriptionIds.push(input.subscriptionId)
        await backend.taskMetadataStore.save(guard.scope, metadata)
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
      if (!employee || !await backend.employees.authorize(employee)) return failure('INVALID_ARGUMENT')
      const task = await backend.taskManager.createTask(input.title.trim(), typeof input.prompt === 'string' ? input.prompt : input.title.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, employee)
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const scope = guard.scope
      await backend.workflowStore.save(scope, task.id, graph)
      await backend.taskMetadataStore.save(scope, {
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
      if (!await backend.employees.authorize(input.subscriptionId)) return failure('INVALID_ARGUMENT')
      const task = await backend.taskManager.createTask(input.title.trim(), input.prompt.trim(), typeof input.workDir === 'string' ? input.workDir : undefined, input.subscriptionId)
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      await backend.taskMetadataStore.save(guard.scope, {
        version: 1, taskId: task.id, kind: 'conversation', participantSubscriptionIds: [input.subscriptionId],
        currentSubscriptionId: input.subscriptionId, createdAt: Date.now(),
      })
      return { success: true, task }
    } catch (error) { return reportFailure(INVOKE_CHANNELS.CONVERSATION_CREATE, error, { authenticated: true }) }
  })

  ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_GET, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      if (!await backend.taskManager.getTask(taskId)) return failure('NOT_FOUND', '未找到该任务。')
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const graph = await backend.workflowStore.load(guard.scope, taskId)
      if (!graph) return failure('NOT_FOUND', '未找到该工作流。')
      return { success: true, graph }
    } catch (error) { return reportFailure(INVOKE_CHANNELS.WORKFLOW_GET, error, { authenticated: true }) }
  })

  ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_START, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      if (!await backend.taskManager.getTask(taskId)) return failure('NOT_FOUND', '未找到该任务。')
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      if (!await backend.workflowStore.load(guard.scope, taskId)) return failure('INVALID_STATE', '需要有效的工作流定义。')
      await (await backend.getTaskCoordinator()).executeTask(taskId)
      return { success: true }
    } catch (error) { return reportFailure(INVOKE_CHANNELS.WORKFLOW_START, error, { authenticated: true }) }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_MESSAGES, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      const task = await backend.taskManager.getTask(taskId)
      if (!task) return failure('NOT_FOUND', '未找到该任务。')
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      return { success: true, messages: await backend.taskRunStore.getMessages(guard.scope, taskId, task.prompt) }
    } catch (error) { return reportFailure(INVOKE_CHANNELS.TASK_GET_MESSAGES, error, { authenticated: true }) }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_RETRY, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) {
        return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      }
      const task = await backend.taskManager.getTask(taskId)
      if (!task) return failure('NOT_FOUND', '未找到该任务。')
      if (!task.subscriptionId || !await backend.employees.authorize(task.subscriptionId)) {
        return failure('INVALID_ARGUMENT')
      }
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const metadata = await backend.taskMetadataStore.load(guard.scope, taskId)
      await (await backend.getTaskCoordinator()).retryTask(taskId, { conversation: metadata?.kind === 'conversation' })
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
      const task = await backend.taskManager.getTask(taskId)
      if (!task) return failure('NOT_FOUND', '未找到该任务。')
      return { success: true, task }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_ALL, async () => {
    try {
      return { success: true, tasks: await backend.taskManager.getAllTasks() }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_ALL, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_LIST_RUNS, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      if (!await backend.taskManager.getTask(taskId)) return failure('NOT_FOUND', '未找到该任务。')
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const runs = await backend.taskRunStore.list(guard.scope, taskId)
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
      if (!await backend.taskManager.getTask(input.taskId)) return failure('NOT_FOUND', '未找到该任务。')
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const run = await backend.taskRunStore.get(guard.scope, input.taskId, input.runId)
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
      if (!await backend.taskManager.getTask(input.taskId)) return failure('NOT_FOUND', '未找到该任务。')
      const guard = requireScope(backend)
      if (!guard.ok) return guard.failure
      const scope = guard.scope
      const run = await backend.taskRunStore.get(scope, input.taskId, input.runId)
      if (!run) return failure('NOT_FOUND', '未找到该执行记录。')
      return { success: true, events: await backend.taskRunStore.getTimeline(scope, input.taskId, input.runId) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_TIMELINE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_PAUSE, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) {
        return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      }
      await (await backend.getTaskCoordinator()).pauseTask(taskId)
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
      await (await backend.getTaskCoordinator()).cancelTask(taskId)
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
      if (!await backend.taskManager.deleteTask(taskId)) {
        return failure('INVALID_STATE', '任务正在执行，无法删除。')
      }
      return { success: true }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_DELETE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_STATS, async () => {
    try {
      return { success: true, stats: await backend.taskManager.getTaskStats() }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_STATS, error, { authenticated: true })
    }
  })

  ipcMain.on(SEND_CHANNELS.TOOL_APPROVAL_RESPONSE, (_event, response: unknown) => {
    const coordinator = backend.peekTaskCoordinator()
    if (!coordinator || !isRecord(response)) return
    // 渲染进程送来的参数一律先校验。requestId 必填（C5）：缺了就不批，不做任何推断。
    if (typeof response['requestId'] !== 'string' || !response['requestId'] || typeof response['approved'] !== 'boolean') {
      log.warn('discarded malformed tool approval response')
      return
    }
    coordinator.respondToApproval({
      requestId: response['requestId'],
      approved: response['approved'],
      reason: typeof response['reason'] === 'string' ? response['reason'] : undefined,
    })
  })

  // ── Utility: Directory Selector ────────────────────────────────────────────

  ipcMain.handle(INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY, async () => {
    const window = bridge.currentWindow();
    if (!window) {
      return { success: false, error: { message: 'Main window not available' } };
    }

    try {
      const result = await dialog.showOpenDialog(window, {
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

  log.info('ipc handlers registered', { invoke: Object.keys(INVOKE_CHANNELS).length });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

function openMainWindow(): void {
  const window = createMainWindow({ onClosed: () => bridge.attach(null) });
  bridge.attach(window);
}

app.whenReady().then(async () => {
  // 报错模块的两件兜底：进程级异常有痕迹，致命错误用户看得见（第 4.3 节）。
  setFatalPresenter((title, message) => dialog.showErrorBox(title, message));
  installProcessHandlers();
  log.info('application ready', { version: app.getVersion(), platform: process.platform });

  // 组装必须先成功再开窗。失败就弹中文错误框并退出——留一个"能打开但坏掉"的窗口
  // 比直接退出更糟：用户会以为应用还能用（第 4.3 节、C3）。
  let backend: Backend;
  try {
    backend = await createBackend({
      userDataDir: app.getPath('userData'),
      renderer: bridge,
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    });
  } catch (error) {
    reportFatal('无法启动任务运行时', error, { stage: 'compose-backend' });
    app.exit(1);
    return;
  }

  registerIpcHandlers(backend);
  installShutdownHandler({
    stop: () => backend.stopAll(),
    describeState: () => ({ coordinatorLoaded: backend.peekTaskCoordinator() !== null }),
  });

  // 任务协调器延迟到首次任务执行时初始化（SDK 加载边界，见 CLAUDE.md）。
  openMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
