/**
 * electron/main.ts — Electron 主进程入口
 *
 * 职责:
 *   - 创建 BrowserWindow + preload 注入
 *   - 管理 pi session 生命周期（通过 pi-host.ts）
 *   - 处理 IPC 通信（renderer ↔ main ↔ pi-host）
 *   - 应用生命周期管理（ready, quit, 等）
 */

import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { join } from 'node:path';
import { PiHost } from './pi-host';

let mainWindow: BrowserWindow | null = null;
let piHost: PiHost | null = null;

// ── 1. 创建主窗口 ─────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // pi-host runs in main, renderer is sandboxed via contextBridge
    },
  });

  // Load renderer
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

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
  });

  console.log('[main] pi-host initialized');
}

// ── 3. IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('pi:start-session', async (_event, config: { employeeId: string; gatewayUrl: string; refreshToken: string }) => {
  if (!piHost) throw new Error('piHost not initialized');
  await piHost.startSession(config);
  return { ok: true };
});

ipcMain.handle('pi:send-prompt', async (_event, text: string) => {
  if (!piHost) throw new Error('piHost not initialized');
  piHost.sendPrompt(text);
  return { ok: true };
});

ipcMain.handle('pi:stop-session', async () => {
  if (!piHost) throw new Error('piHost not initialized');
  await piHost.stopSession();
  return { ok: true };
});

ipcMain.handle('credentials:save-refresh-token', async (_event, token: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available');
  }
  const encrypted = safeStorage.encryptString(token);
  // TODO: persist encrypted buffer to disk (e.g., app.getPath('userData') + '/creds.enc')
  console.log('[main] refresh token saved (encrypted)');
  return { ok: true };
});

ipcMain.handle('credentials:get-refresh-token', async () => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available');
  }
  // TODO: load encrypted buffer from disk, decrypt
  // const encrypted = await fs.readFile(...);
  // const token = safeStorage.decryptString(encrypted);
  // return { token };
  console.log('[main] refresh token retrieved (placeholder)');
  return { token: null };
});

// ── 4. App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initPiHost();
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
