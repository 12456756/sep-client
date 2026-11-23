import type { BrowserWindow } from 'electron'
import type { WindowCloseBehavior, WindowCloseCommand } from '../../src/shared/window-close'
import type { WindowCloseSettings } from '../data/window-close-settings'
import { appError } from '../errors/app-error'

interface WindowCloseOptions {
  settings: Pick<WindowCloseSettings, 'write'>
  initialBehavior: WindowCloseBehavior
  publish: (requestId: number) => void
  quit: () => void
  isUpdateInstallPrepared: () => boolean
}

export class WindowCloseController {
  private behavior: WindowCloseBehavior
  private requestId = 0
  private pending: { windowId: number; id: number; resolving: boolean } | undefined
  private quitting = false

  constructor(private readonly options: WindowCloseOptions) {
    this.behavior = options.initialBehavior
  }

  attach(window: BrowserWindow): void {
    const clear = () => { if (this.pending?.windowId === window.id) this.pending = undefined }
    const contents = window.webContents
    let ready = false
    let responsive = true
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) { ready = false; clear() }
    })
    contents.on('did-finish-load', () => { ready = true })
    contents.on('render-process-gone', () => { ready = false; clear() })
    window.on('unresponsive', () => { responsive = false })
    window.on('responsive', () => { responsive = true })
    window.once('closed', clear)
    window.on('close', event => {
      // The updater may close windows before it emits before-quit.
      if (this.options.isUpdateInstallPrepared()) return
      event.preventDefault()
      if (this.quitting) return
      if (this.behavior !== 'ask') { this.apply(window, this.behavior); return }
      // The app must still be closable if its UI did not load or crashed.
      if (!ready || !responsive || contents.isDestroyed() || contents.isCrashed()) { this.apply(window, 'quit'); return }
      if (window.isMinimized()) window.restore()
      if (this.pending?.windowId === window.id) return
      const id = ++this.requestId
      this.pending = { windowId: window.id, id, resolving: false }
      this.options.publish(id)
    })
  }

  beginShutdown(): void {
    this.quitting = true
    this.pending = undefined
  }

  async command(window: BrowserWindow, input: WindowCloseCommand): Promise<WindowCloseBehavior> {
    if (input.type === 'set') await this.save(input.behavior)
    if (input.type !== 'resolve') return this.behavior

    const pending = this.pending
    if (!pending || pending.id !== input.requestId || pending.windowId !== window.id || pending.resolving) {
      if (input.action === 'cancel') return this.behavior
      throw appError('INVALID_STATE', { message: '关闭请求已失效，请重新点击关闭。' })
    }
    if (input.action === 'cancel') {
      this.pending = undefined
      return this.behavior
    }

    pending.resolving = true
    try {
      if (input.remember) await this.save(input.action)
      if (this.pending === pending && !window.isDestroyed() && !this.options.isUpdateInstallPrepared()) {
        this.apply(window, input.action)
      }
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
    return this.behavior
  }

  private async save(behavior: WindowCloseBehavior): Promise<void> {
    await this.options.settings.write(behavior)
    this.behavior = behavior
  }

  private apply(window: BrowserWindow, action: Exclude<WindowCloseBehavior, 'ask'>): void {
    if (action === 'minimize') { window.minimize(); return }
    this.beginShutdown()
    // Leave the native close event before requesting application shutdown.
    queueMicrotask(this.options.quit)
  }
}
