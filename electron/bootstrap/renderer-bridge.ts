/**
 * electron/bootstrap/renderer-bridge.ts — main -> renderer 的唯一推送出口
 *
 * 全后端只有这一个文件调用 `webContents.send`，由 `check:boundaries` 的
 * `B1a:renderer-push-single-exit` 强制（方案 3.3 节 B1）。
 *
 * 它同时是当前窗口的唯一持有者。窗口在组装之后才创建、可能被关闭后重建，
 * 所以引用必须可变；把这份可变状态收在一个对象里，替掉 main.ts 原来的模块级
 * `mainWindow` 全局，也就不需要 `TaskManager.setMainWindow()` 这类回填接口了。
 */
import type { BrowserWindow } from 'electron'
import type { ClientTask, TaskExecutionEvent, ToolAuthorizationRequest } from '../../src/shared/types'
import { EVENT_CHANNELS, type EventChannel } from '../controller/channels'
import type { RendererPort } from '../runtime/task-notifier'

export class RendererBridge implements RendererPort {
  private window: BrowserWindow | null = null

  /** 窗口创建后接上，关闭后传 null 断开。 */
  attach(window: BrowserWindow | null): void {
    this.window = window
  }

  /** 需要父窗口的原生弹框（目录选择）用它，避免第二处窗口引用。 */
  currentWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  taskUpdated(task: ClientTask): void {
    this.send(EVENT_CHANNELS.TASK_UPDATED, task)
  }

  taskListUpdated(tasks: ClientTask[]): void {
    this.send(EVENT_CHANNELS.TASK_LIST_UPDATED, tasks)
  }

  taskEvent(event: TaskExecutionEvent): void {
    this.send(EVENT_CHANNELS.PI_EVENT, event)
  }

  approvalRequest(request: ToolAuthorizationRequest): void {
    this.send(EVENT_CHANNELS.TOOL_APPROVAL_REQUEST, request)
  }

  /** 认证失效：渲染进程的监听器不接参数，所以这里也不带载荷。 */
  authenticationRequired(): void {
    this.send(EVENT_CHANNELS.AUTH_REQUIRED)
  }

  /**
   * 销毁判定不能省：停机与登出路径上窗口可能已经销毁，
   * 对销毁后的 webContents 调 send 会抛，而这些调用点都在 finally 里。
   */
  private send(channel: EventChannel, ...payload: [unknown] | []): void {
    const window = this.currentWindow()
    if (!window) return
    window.webContents.send(channel, ...payload)
  }
}
