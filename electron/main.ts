/**
 * electron/main.ts — Electron 主进程入口
 *
 * 只做四件事，一个业务判断都没有：
 *   兼容层 → 组装后端 → 注册路由表 → 窗口与生命周期
 *
 * 没有模块级可变状态：后端由 bootstrap/build-backend.ts 装配，窗口引用归
 * bootstrap/renderer-bridge.ts，IPC 注册归 controller/router.ts。
 */
import './common/undici-polyfill'; // Pi SDK 使用的网络兼容层，必须是第一个副作用 import。
import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { createBackend } from './bootstrap/build-backend';
import { createAppUpdater } from './bootstrap/create-app-updater';
import { createMainWindow } from './bootstrap/main-window';
import { createSkillImport } from './bootstrap/create-skill-import';
import { installSkillImportDeepLinks } from './bootstrap/skill-import-deep-link';
import { resolveSkillImportInstances } from './common/runtime-config';
import type { SkillImportService } from './service/skill-import-service';
import { registerResultFileScheme, installResultFileProtocol } from './bootstrap/result-file-protocol';
import { RendererBridge } from './bootstrap/renderer-bridge';
import { installShutdownHandler } from './bootstrap/shutdown';
import type { SpeechPermissionGate } from './bootstrap/speech-permissions';
import { logger } from './common/logger';
import { createRequestContext } from './controller/request-context';
import { registerRoutes } from './controller/router';
import { listeners, routes } from './controller/routes';
import {
  installProcessHandlers,
  reportFatal,
  setFatalPresenter,
} from './errors/error-reporter';

const log = logger.child('main');
registerResultFileScheme();

/** main -> renderer 的唯一出口，同时持有当前窗口。 */
const bridge = new RendererBridge();
function focusMainWindow(): void {
  const window = bridge.currentWindow();
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
}
const deepLinks = installSkillImportDeepLinks(app, {
  argv: process.argv,
  trustedInstances: new Set(resolveSkillImportInstances(process.env['SEP_SKILL_IMPORT_INSTANCES']).map(instance => instance.instanceId)),
  focus: focusMainWindow,
});

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

function openMainWindow(speech: SpeechPermissionGate, skillImport: SkillImportService, showOnReady = true): void {
  const window = createMainWindow({ speech, showOnReady, onClosed: () => {
    bridge.attach(null);
    void skillImport.cancelActive();
  } });
  bridge.attach(window);
}

if (deepLinks.primary) app.whenReady().then(async () => {
  // 报错模块的两件兜底：进程级异常有痕迹，致命错误用户看得见（第 4.3 节）。
  setFatalPresenter((title, message) => dialog.showErrorBox(title, message));
  installProcessHandlers({ onFatal: presentFatalOnce });
  log.info('application ready', { version: app.getVersion(), platform: process.platform });

  // 组装必须先成功再开窗。失败就弹中文错误框并退出——留一个"能打开但坏掉"的窗口
  // 比直接退出更糟：用户会以为应用还能用（第 4.3 节、C3）。
  try {
    if (app.isPackaged) app.setAsDefaultProtocolClient('sep-import');
    let importVisible = false;
    const skillImport = await createSkillImport({ userDataDir: app.getPath('userData'), clientVersion: app.getVersion(),
      publish: state => {
        bridge.skillImportStateChanged(state);
        if (state.visible && !importVisible) focusMainWindow();
        importVisible = state.visible;
      } });
    const backend = await createBackend({
      userDataDir: app.getPath('userData'),
      renderer: bridge,
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      skillImport,
    });

    const updater = createAppUpdater(backend, bridge);
    const uninstallResultFiles = installResultFileProtocol(backend.resultFiles);
    app.once('will-quit', uninstallResultFiles);
    registerRoutes(createRequestContext(backend, () => bridge.currentWindow(), updater), { routes, listeners });
    app.once('before-quit', () => updater.dispose());
    installShutdownHandler({
      stop: () => backend.stopForApp(),
      isUpdateInstallPrepared: () => updater.isInstallPrepared(),
      describeState: () => ({ runtimeLoaded: backend.peekTaskRuntime() !== null }),
    });
    if (deepLinks.hasPendingLinks()) openMainWindow(backend.speech, skillImport, false);
    else openMainWindow(backend.speech, skillImport);
    deepLinks.attach(async link => {
      if (!bridge.currentWindow()) openMainWindow(backend.speech, skillImport, false);
      await skillImport.open(link);
      const state = await skillImport.getState();
      if (state.visible && state.phase === 'awaiting-local-consent' && state.sessionId === link.sessionId && state.instanceId === link.instanceId) focusMainWindow();
    });
    app.once('will-quit', () => deepLinks.dispose());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow(backend.speech, skillImport);
      else focusMainWindow();
    });
    updater.startAutomaticCheck();
  } catch (error) {
    reportFatal('无法启动任务运行时', error, { stage: 'compose-backend' });
    app.exit(1);
    return;
  }

  // 任务运行时延迟到首次任务执行时初始化（SDK 加载边界，见 AGENTS.md）。
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});


