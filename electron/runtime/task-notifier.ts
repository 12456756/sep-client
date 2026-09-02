/**
 * electron/runtime/task-notifier.ts — 任务状态推送出口（只有接口）
 *
 * `TaskManager` 原来自己持有 `BrowserWindow` 并直接 `webContents.send`
 * （方案 1.2 节），于是一个执行层的类知道渲染进程的存在，也就没法脱离 Electron 单测。
 *
 * 这里只声明"通知"这件事。实现由 `bootstrap/renderer-bridge.ts` 注入——
 * 本文件不认识 Electron，也不认识通道名，这是 B1 允许的唯一例外（方案 3.3 节）。
 */
import type { ClientTask, TaskExecutionEvent, ToolAuthorizationRequest } from '../../src/shared/types'

export interface TaskNotifier {
  /** 单个任务发生变化。 */
  taskUpdated(task: ClientTask): void
  /** 任务列表整体发生变化（新增、删除、scope 切换）。 */
  taskListUpdated(tasks: ClientTask[]): void
}

/**
 * 后端推给渲染进程的全部内容。`TaskManager` 只需要 `TaskNotifier` 那两个方法，
 * 所以两个接口分开声明——按最小需要注入，而不是把整个出口塞给每个使用者。
 */
export interface RendererPort extends TaskNotifier {
  /** run 的执行事件流。 */
  taskEvent(event: TaskExecutionEvent): void
  /** 高危工具调用等待用户批准。 */
  approvalRequest(request: ToolAuthorizationRequest): void
  /** 令牌已失效，需要重新登录。 */
  authenticationRequired(): void
}

/**
 * 没有接收方时的空实现：测试、以及窗口还没建好或已经关掉的时刻。
 * 有了它，`TaskManager` 内部就不必到处判空。
 */
export const silentTaskNotifier: TaskNotifier = {
  taskUpdated() {},
  taskListUpdated() {},
}
