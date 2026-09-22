/**
 * electron/bootstrap/main-window.ts — 主窗口的创建与显示
 *
 * 只管窗口本身：尺寸、preload 注入、加载渲染进程、可见性兜底。
 * 不认识任何业务对象，也不持有窗口引用——引用归 renderer-bridge。
 */
import { BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { logger } from '../common/logger'
import { externalWebLink } from '../common/external-web-link'

const log = logger.child('main-window')

export interface MainWindowOptions {
  /** 窗口关闭时通知调用方断开推送。 */
  onClosed: () => void
}

export function createMainWindow({ onClosed }: MainWindowOptions): BrowserWindow {
  Menu.setApplicationMenu(null)

  const window = new BrowserWindow({
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
  })

  // 回答中的网页链接交给系统浏览器，禁止创建继承 preload 的子窗口。
  window.webContents.setWindowOpenHandler(({ url }) => {
    const link = externalWebLink(url)
    if (link) {
      void shell.openExternal(link).catch(error => {
        log.warn('could not open external webpage', { error })
      })
    }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    log.debug('loading renderer from dev server')
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    log.debug('loading renderer from bundled file')
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('renderer failed to load', { errorCode, errorDescription })
  })

  window.webContents.on('did-finish-load', () => {
    log.info('renderer loaded')
    // 某些 Windows/Electron 组合在从 Vite 开发服务器加载渲染进程时，
    // 不会触发 ready-to-show。加载成功后不要让窗口一直隐藏。
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  })

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })

  window.on('closed', onClosed)

  log.info('main window created')
  return window
}


