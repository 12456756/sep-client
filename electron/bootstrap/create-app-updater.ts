import { createRequire } from 'node:module'
import { app } from 'electron'
import { logger } from '../common/logger'
import { supportsAppUpdates } from '../common/update-config'
import { withTimeout } from '../common/with-timeout'
import type { Backend } from './build-backend'
import { AppUpdater } from './app-updater'
import type { RendererBridge } from './renderer-bridge'
import { SHUTDOWN_BUDGET_MS } from './shutdown'

/** 不支持的平台不构造 SDK updater，避免开发环境意外请求或安装。 */
export function createAppUpdater(backend: Backend, bridge: RendererBridge): AppUpdater {
  const supported = supportsAppUpdates(app.isPackaged, process.platform, process.arch)
  // electron-updater 是 CommonJS，autoUpdater 为 getter，须经原生 require 保留它。
  let sdk: typeof import('electron-updater') | null = null
  let driver: import('electron-updater').AppUpdater | null = null
  try {
    sdk = supported ? createRequire(import.meta.url)('electron-updater') as typeof import('electron-updater') : null
    driver = sdk?.autoUpdater ?? null
    if (driver) {
      driver.autoDownload = false
      driver.autoInstallOnAppQuit = false
      driver.autoRunAppAfterInstall = true
      driver.allowPrerelease = app.getVersion().includes('-')
      // 必须放在 allowPrerelease 后：部分 SDK 版本设置预发布选项会放开降级。
      driver.allowDowngrade = false
      driver.disableWebInstaller = true
      driver.requestHeaders = {}
      const log = logger.child('update-sdk')
      // SDK 日志可能包含远程 URL / 本地路径，只记录级别与固定文案。
      driver.logger = {
        info: () => log.info('updater activity'), warn: () => log.warn('updater warning'),
        error: () => log.error('updater failure'), debug: () => log.debug('updater diagnostic'),
      }
    }
  } catch {
    // 更新器初始化失败不能阻塞业务窗口与登录。
    logger.child('app-updater').warn('updater initialization failed')
    driver = null
  }
  return new AppUpdater({
    currentVersion: app.getVersion(), driver,
    createToken: () => {
      if (!sdk) throw new Error('Updater unavailable')
      return new sdk.CancellationToken()
    },
    isNewerVersion: version => driver !== null && driver.currentVersion.compare(version) < 0,
    taskStats: () => backend.tasks.stats(),
    prepareInstall: () => withTimeout(backend.stopAll(), SHUTDOWN_BUDGET_MS, 'update-install-cleanup'),
    restoreAfterInstallFailure: async () => {
      bridge.notificationUpdated({ type: 'resync' })
      await withTimeout(backend.resumeClientMonitor(), SHUTDOWN_BUDGET_MS, 'update-install-recovery')
    },
    publish: state => bridge.updateStateChanged(state),
  })
}
