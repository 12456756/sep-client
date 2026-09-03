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
import { appError } from './errors/app-error';
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
import type { TaskRunRecord } from './data/task-run-store';
import type { CreateTaskInput, SessionRecoveryMode } from './service/task-service';
import {
  forgetRememberedAccount,
  getRememberedPassword,
  listRememberedAccounts,
  saveRememberedAccount,
} from './common/platform/credential-vault';

const log = logger.child('main');

/** main -> renderer 的唯一出口，同时持有当前窗口。 */
const bridge = new RendererBridge();

/**
 * 致命错误只弹第一次。`uncaughtException` 可能来自定时器或事件监听器而反复触发，
 * `dialog.showErrorBox` 是模态的，弹第二次起只会让应用彻底没法操作。
 * 后续异常仍然由 error-reporter 记进日志，不丢。
 */
let fatalPresented = false;

function presentFatalOnce(error: unknown): void {
  if (fatalPresented) return;
  fatalPresented = true;
  reportFatal('应用遇到未预期的错误', error, { stage: 'uncaught-exception' });
}

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
 * 以下三个是**参数校验**，属控制层：把渲染进程送来的 unknown 收成服务层的入参类型，
 * 不合法就直接给出 INVALID_ARGUMENT。Phase 6 换成 zod 表驱动之后它们会消失
 * ——那时"不填 schema 就注册不了"，校验从"靠人记得"变成结构强制。
 */
const RECOVERY_MODES = new Set(['strict', 'confirm_rebuild', 'auto_rebuild_from_task_history'])

function isRecoveryMode(value: unknown): value is SessionRecoveryMode {
  return typeof value === 'string' && RECOVERY_MODES.has(value)
}

function readCreateTaskInput(value: unknown): { value: CreateTaskInput } | { failure: IpcFailure } {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title.trim() ||
      typeof value.prompt !== 'string' || !value.prompt.trim()) {
    return { failure: failure('INVALID_ARGUMENT', '任务请求参数不合法。') }
  }
  if (typeof value.workDir !== 'undefined' && (typeof value.workDir !== 'string' || !value.workDir.trim())) {
    return { failure: failure('INVALID_ARGUMENT', '工作目录不合法。') }
  }
  if (typeof value.subscriptionId !== 'string') {
    return { failure: failure('INVALID_ARGUMENT', '所选硅基员工不合法。') }
  }
  return {
    value: {
      title: value.title.trim(),
      prompt: value.prompt.trim(),
      workDir: typeof value.workDir === 'string' ? value.workDir.trim() : undefined,
      subscriptionId: value.subscriptionId,
    },
  }
}

function readRunIds(value: unknown): { taskId: string; runId: string } | { failure: IpcFailure } {
  if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.runId !== 'string') {
    return { failure: failure('INVALID_ARGUMENT', '需要有效的任务与执行记录 ID。') }
  }
  return { taskId: value.taskId, runId: value.runId }
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
      // 401 必须触发失效清理，否则用户停在一个令牌已作废的界面上。
      // 403 不算——那是权限不足，重新登录也不会变（保持 C7 之前就有的判定）。
      if (
        error instanceof AuthenticationRequiredError ||
        (error instanceof AuthApiError && error.isUnauthorized)
      ) {
        backend.invalidateAuthentication();
      }
      // C11：这里原有三处手写信封，把 AuthApiError 的英文 message 直接送进 IPC，
      // 而 App.tsx 会原样显示；且三条分支都不记日志，平台请求失败在日志里毫无痕迹。
      return reportFailure(INVOKE_CHANNELS.AUTH_GET_INSTANCES, error, { authenticated: true });
    }
  });

  // ── Task Management ────────────────────────────────────────────────────────
  //
  // 每个 handler 只剩三步：校验参数 → 调服务 → 转信封（方案 Phase 5）。
  // scope 校验、员工授权、元数据读写、NOT_FOUND / INVALID_STATE 的判定
  // 全部下沉到 service/，这里一处都不再重复。

  ipcMain.handle(INVOKE_CHANNELS.TASK_CREATE, async (_event, data: unknown) => {
    try {
      const input = readCreateTaskInput(data)
      if ('failure' in input) return input.failure
      // 渲染进程的对话编辑器用的是 task:create，所以这里也按对话任务初始化，
      // 首轮运行才会走任务级共享 Pi 会话。两个 channel 都是同一个服务方法的薄入口。
      return { success: true, task: await backend.conversations.create(input.value) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_CREATE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.CONVERSATION_CREATE, async (_event, input: unknown) => {
    try {
      const parsed = readCreateTaskInput(input)
      if ('failure' in parsed) return parsed.failure
      return { success: true, task: await backend.conversations.create(parsed.value) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.CONVERSATION_CREATE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_EXECUTE, async (_event, input: unknown) => {
    try {
      const taskId = typeof input === 'string'
        ? input
        : isRecord(input) && typeof input.taskId === 'string'
          ? input.taskId
          : null
      if (!taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      await backend.tasks.execute(taskId)
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
      if (typeof input.recoveryMode !== 'undefined' && !isRecoveryMode(input.recoveryMode)) {
        return failure('INVALID_ARGUMENT', '会话恢复模式不合法。')
      }
      if (typeof input.confirmRecovery !== 'undefined' && typeof input.confirmRecovery !== 'boolean') {
        return failure('INVALID_ARGUMENT', '会话恢复确认参数不合法。')
      }
      await backend.conversations.continue({
        taskId: input.taskId,
        prompt: input.prompt,
        recoveryMode: isRecoveryMode(input.recoveryMode) ? input.recoveryMode : undefined,
        confirmRecovery: input.confirmRecovery === true,
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
      await backend.conversations.switchEmployee(input.taskId, input.subscriptionId)
      return { success: true }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_SWITCH_EMPLOYEE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_RETRY, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      await backend.tasks.retry(taskId)
      return { success: true }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_RETRY, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_PAUSE, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      await backend.tasks.pause(taskId)
      return { success: true }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_PAUSE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_CANCEL, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      await backend.tasks.cancel(taskId)
      return { success: true }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_CANCEL, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_DELETE, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      await backend.tasks.delete(taskId)
      return { success: true }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_DELETE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      return { success: true, task: await backend.tasks.get(taskId) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_ALL, async () => {
    try {
      return { success: true, tasks: await backend.tasks.list() }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_ALL, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_STATS, async () => {
    try {
      return { success: true, stats: await backend.tasks.stats() }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_STATS, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_MESSAGES, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      return { success: true, messages: await backend.tasks.messages(taskId) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_MESSAGES, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_LIST_RUNS, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      const runs = await backend.tasks.listRuns(taskId)
      return { success: true, runs: runs.map(toClientTaskRun) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_LIST_RUNS, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_RUN, async (_event, input: unknown) => {
    try {
      const ids = readRunIds(input)
      if ('failure' in ids) return ids.failure
      const run = await backend.tasks.getRun(ids.taskId, ids.runId)
      return { success: true, run: toClientTaskRun(run) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_RUN, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.TASK_GET_TIMELINE, async (_event, input: unknown) => {
    try {
      const ids = readRunIds(input)
      if ('failure' in ids) return ids.failure
      return { success: true, events: await backend.tasks.timeline(ids.taskId, ids.runId) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.TASK_GET_TIMELINE, error, { authenticated: true })
    }
  })

  // ── Workflow ───────────────────────────────────────────────────────────────

  ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_VALIDATE, async (_event, input: unknown) => {
    try {
      if (!isRecord(input) || !Array.isArray(input.nodes)) {
        return failure('INVALID_ARGUMENT', '需要提供工作流节点。')
      }
      return { success: true, graph: backend.workflows.validate(input.nodes) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.WORKFLOW_VALIDATE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_CREATE, async (_event, input: unknown) => {
    try {
      if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || !Array.isArray(input.nodes)) {
        return failure('INVALID_ARGUMENT', '需要提供标题与工作流节点。')
      }
      return {
        success: true,
        ...await backend.workflows.create({
          title: input.title.trim(),
          nodes: input.nodes,
          prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          workDir: typeof input.workDir === 'string' ? input.workDir : undefined,
        }),
      }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.WORKFLOW_CREATE, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_GET, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      return { success: true, graph: await backend.workflows.get(taskId) }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.WORKFLOW_GET, error, { authenticated: true })
    }
  })

  ipcMain.handle(INVOKE_CHANNELS.WORKFLOW_START, async (_event, taskId: unknown) => {
    try {
      if (typeof taskId !== 'string' || !taskId) return failure('INVALID_ARGUMENT', '需要有效的任务 ID。')
      await backend.workflows.start(taskId)
      return { success: true }
    } catch (error) {
      return reportFailure(INVOKE_CHANNELS.WORKFLOW_START, error, { authenticated: true })
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
      // 渲染进程跑在窗口里，所以这条分支意味着窗口在调用途中被销毁了——
      // 属于不变式被破坏，走 error 级日志（第 5.2 节），不是静默失败。
      return reportFailure(
        INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY,
        appError('INTERNAL_ERROR', { details: { reason: 'main window unavailable' } }),
      );
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
      return reportFailure(INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY, error);
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
  // onFatal 必须传：不传的话 uncaughtException 只留一条日志，用户面对的是一个
  // 状态已不可信却毫无提示的应用——正是第 4.3 节要避免的情形。
  setFatalPresenter((title, message) => dialog.showErrorBox(title, message));
  installProcessHandlers({ onFatal: presentFatalOnce });
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
