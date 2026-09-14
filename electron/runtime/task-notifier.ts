/**
 * electron/runtime/task-notifier.ts — 任务状态推送出口（只有接口）
 *
 * 这里只声明通知能力。实现由 `bootstrap/renderer-bridge.ts` 注入，运行时和任务管理器
 * 不需要认识 Electron 或 IPC 通道名。
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


