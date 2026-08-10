/**
 * electron/main.ts — Electron 主进程入口
 *
 * 职责:
 *   - 创建 BrowserWindow + preload 注入
 *   - 管理 pi session 生命周期（通过 pi-host.ts）
 *   - 处理 IPC 通信（renderer ↔ main ↔ pi-host）
 *   - 应用生命周期管理（ready, quit, 等）
 */

import { app, BrowserWindow, ipcMain, safeStorage, dialog } from 'electron';
import { join } from 'node:path';
import './undici-polyfill'; // 必须在 pi-host 加载前注入
import type { PiHost } from './pi-host';
import { TaskManager } from './task-manager';
import { getDeviceFingerprint } from './device-fingerprint';
import { login, getInstances, getInstanceToken, AuthApiError } from './auth-api';
import { saveRefreshToken, getRefreshToken, saveAuthMeta, getAuthMeta, clearCredentials } from './credentials';

let mainWindow: BrowserWindow | null = null;
let piHost: PiHost | null = null;
let taskManager: TaskManager | null = null;

// 延迟加载 PiHost，避免启动时加载 pi-coding-agent
async function loadPiHost(): Promise<typeof import('./pi-host')> {
  return await import('./pi-host');
}

// ── 1. 创建主窗口 ─────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[main] renderer failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] renderer loaded successfully');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  console.log('[main] window created');
}

// ── 2. Pi Host 初始化 ─────────────────────────────────────────────────────────

async function initPiHost(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[main] safeStorage encryption NOT available on this platform');
  }

  // 初始化 TaskManager
  taskManager = new TaskManager(mainWindow);
  console.log('[main] task-manager initialized');

  // 动态加载 PiHost，避免启动时加载 pi-coding-agent
  const { PiHost } = await loadPiHost();

  piHost = new PiHost({
    onEvent: (event) => {
      // Forward pi events to renderer
      mainWindow?.webContents.send('pi:event', event);
    },
    onToolApprovalRequest: async (request) => {
      // Forward approval request to renderer, await response
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Tool approval timeout after 60s'));
        }, 60_000);

        ipcMain.once('pi:tool-approval-response', (_event, response: { approved: boolean; reason?: string }) => {
          clearTimeout(timeoutId);
          resolve(response.approved);
        });

        mainWindow?.webContents.send('pi:tool-approval-request', request);
      });
    },
    taskManager: taskManager,
  });

  console.log('[main] pi-host initialized');
}

// ── 3. IPC handlers ───────────────────────────────────────────────────────────

// ── Auth: Login ──────────────────────────────────────────────────────────────

ipcMain.handle('auth:login', async (_event, credentials: { email: string; password: string }) => {
  try {
    const fingerprint = getDeviceFingerprint();

    const response = await login({
      email: credentials.email,
      password: credentials.password,
      fingerprint,
      platform: process.platform,
      clientVersion: app.getVersion(),
    });

    // Save refresh token securely
    saveRefreshToken(response.refreshToken);

    // Save auth metadata (non-sensitive)
    if (response.enterprise) {
      saveAuthMeta({
        memberId: response.user.id,
        enterpriseId: response.enterprise.id,
        displayName: response.user.name,
        enterpriseName: response.enterprise.name,
      });
    }

    return {
      success: true,
      data: {
        accessToken: response.accessToken,
        expiresIn: response.expiresIn,
        user: response.user,
        enterprise: response.enterprise,
      },
    };
  } catch (error) {
    if (error instanceof AuthApiError) {
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

// ── Auth: Check stored credentials ──────────────────────────────────────────

ipcMain.handle('auth:check-stored-credentials', async () => {
  const refreshToken = getRefreshToken();
  const authMeta = getAuthMeta();

  if (refreshToken && authMeta) {
    return {
      hasCredentials: true,
      user: {
        name: authMeta.displayName,
        email: '', // Not stored in metadata
      },
      enterprise: {
        name: authMeta.enterpriseName,
      },
    };
  }

  return {
    hasCredentials: false,
  };
});

// ── Auth: Get refresh token (for session startup) ────────────────────────────

ipcMain.handle('auth:get-refresh-token', async () => {
  const refreshToken = getRefreshToken();

  if (!refreshToken) {
    return {
      success: false,
      error: { message: 'No refresh token available' },
    };
  }

  return {
    success: true,
    data: { refreshToken },
  };
});

// ── Auth: Logout ─────────────────────────────────────────────────────────────

ipcMain.handle('auth:logout', async () => {
  try {
    clearCredentials();

    // Stop pi session if active
    if (piHost) {
      await piHost.stopSession();
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
});

// ── Auth: Get instances ──────────────────────────────────────────────────────

ipcMain.handle('auth:get-instances', async (_event, accessToken: string) => {
  try {
    const instances = await getInstances(accessToken);

    // Filter only ACTIVE instances
    const activeInstances = instances.filter(inst => inst.status === 'ACTIVE');

    return {
      success: true,
      data: activeInstances,
    };
  } catch (error) {
    if (error instanceof AuthApiError) {
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

// ── Auth: Get instance token ─────────────────────────────────────────────────

ipcMain.handle('auth:get-instance-token', async (_event, instanceId: string) => {
  try {
    const refreshToken = getRefreshToken();

    if (!refreshToken) {
      return {
        success: false,
        error: {
          message: 'No refresh token available. Please login again.',
          statusCode: 401,
        },
      };
    }

    const response = await getInstanceToken({
      refreshToken,
      instanceId,
    });

    return {
      success: true,
      data: {
        instanceToken: response.instanceToken,
        expiresIn: response.expiresIn,
        instance: response.instance,
      },
    };
  } catch (error) {
    if (error instanceof AuthApiError) {
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

// ── Pi Session ───────────────────────────────────────────────────────────────

ipcMain.handle('pi:start-session', async (_event, config: { employeeId: string; gatewayUrl: string; refreshToken: string }) => {
  // 按需初始化 PiHost（首次使用时）
  if (!piHost) {
    await initPiHost();
  }
  if (!piHost) throw new Error('Failed to initialize piHost');
  await piHost.startSession(config);
  return { ok: true };
});

ipcMain.handle('pi:send-prompt', async (_event, text: string) => {
  if (!piHost) throw new Error('piHost not initialized');
  await piHost.sendPrompt(text);
  return { ok: true };
});

ipcMain.handle('pi:stop-session', async () => {
  if (!piHost) throw new Error('piHost not initialized');
  await piHost.stopSession();
  return { ok: true };
});

// ── Task Management ──────────────────────────────────────────────────────────

ipcMain.handle('task:create', async (_event, data: { title: string; prompt: string; workDir?: string }) => {
  if (!taskManager) throw new Error('taskManager not initialized');

  try {
    const task = taskManager.createTask(data.title, data.prompt, data.workDir);
    return { success: true, task };
  } catch (error) {
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
});

ipcMain.handle('task:execute', async (_event, taskId: string) => {
  if (!piHost) throw new Error('piHost not initialized');
  if (!taskManager) throw new Error('taskManager not initialized');

  try {
    await piHost.executeTask(taskId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
});

ipcMain.handle('task:get', async (_event, taskId: string) => {
  if (!taskManager) throw new Error('taskManager not initialized');

  const task = taskManager.getTask(taskId);
  if (!task) {
    return {
      success: false,
      error: { message: 'Task not found' },
    };
  }

  return { success: true, task };
});

ipcMain.handle('task:get-all', async () => {
  if (!taskManager) throw new Error('taskManager not initialized');

  const tasks = taskManager.getAllTasks();
  return { success: true, tasks };
});

ipcMain.handle('task:pause', async (_event, taskId: string) => {
  if (!taskManager) throw new Error('taskManager not initialized');

  try {
    taskManager.pauseTask(taskId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
});

ipcMain.handle('task:cancel', async (_event, taskId: string) => {
  if (!taskManager) throw new Error('taskManager not initialized');

  try {
    taskManager.cancelTask(taskId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
});

ipcMain.handle('task:delete', async (_event, taskId: string) => {
  if (!taskManager) throw new Error('taskManager not initialized');

  const deleted = taskManager.deleteTask(taskId);
  if (!deleted) {
    return {
      success: false,
      error: { message: 'Cannot delete active task' },
    };
  }

  return { success: true };
});

ipcMain.handle('task:get-stats', async () => {
  if (!taskManager) throw new Error('taskManager not initialized');

  const stats = taskManager.getTaskStats();
  return { success: true, stats };
});

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
    await piHost.stopSession();
  }
});
