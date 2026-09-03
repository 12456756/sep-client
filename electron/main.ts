/**
 * electron/main.ts — Electron 主进程入口
 *
 * 只做四件事，一个业务判断都没有：
 *   兼容层 → 组装后端 → 注册路由表 → 窗口与生命周期
 *
 * 没有模块级可变状态：后端由 bootstrap/composition-root.ts 装配，窗口引用归
 * bootstrap/renderer-bridge.ts，IPC 注册归 controller/router.ts。
 */
import './common/undici-polyfill'; // Pi SDK 使用的网络兼容层，必须是第一个副作用 import。
import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { createBackend } from './bootstrap/composition-root';
import { createMainWindow } from './bootstrap/main-window';
import { RendererBridge } from './bootstrap/renderer-bridge';
import { installShutdownHandler } from './bootstrap/shutdown';
import { logger } from './common/logger';
import { createRequestContext } from './controller/context';
import { registerRoutes } from './controller/router';
import { listeners, routes } from './controller/routes';
import {
  installProcessHandlers,
  reportFatal,
  setFatalPresenter,
} from './errors/error-reporter';

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

function openMainWindow(): void {
  const window = createMainWindow({ onClosed: () => bridge.attach(null) });
  bridge.attach(window);
}

app.whenReady().then(async () => {
  // 报错模块的两件兜底：进程级异常有痕迹，致命错误用户看得见（第 4.3 节）。
  setFatalPresenter((title, message) => dialog.showErrorBox(title, message));
  installProcessHandlers({ onFatal: presentFatalOnce });
  log.info('application ready', { version: app.getVersion(), platform: process.platform });

  // 组装必须先成功再开窗。失败就弹中文错误框并退出——留一个"能打开但坏掉"的窗口
  // 比直接退出更糟：用户会以为应用还能用（第 4.3 节、C3）。
  try {
    const backend = await createBackend({
      userDataDir: app.getPath('userData'),
      renderer: bridge,
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    });

    registerRoutes(createRequestContext(backend, () => bridge.currentWindow()), { routes, listeners });
    installShutdownHandler({
      stop: () => backend.stopAll(),
      describeState: () => ({ coordinatorLoaded: backend.peekTaskCoordinator() !== null }),
    });
  } catch (error) {
    reportFatal('无法启动任务运行时', error, { stage: 'compose-backend' });
    app.exit(1);
    return;
  }

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
