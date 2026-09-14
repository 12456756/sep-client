/**
 * electron/runtime/run-queue.ts — 准入队列，按 runId 寻址（C1）
 *
 * C1 是一个严重缺陷：`pump()` 原来对 `this.queue` 按**下标**迭代并 `splice(index, 1)`，
 * 而循环里有两个挂起点（`getTask` 与授权）。`pauseTask` / `cancelTask` 调用的
 * `removeQueuedTask()` 是**同步** splice，正好能在挂起期间插进来，于是恢复执行后
 * `splice(index, 1)` 删掉的是**另一个**条目。被误删的 run 仍持有 `activeRunId`，
 * 却永远不会被启动、也永远不会被清理——用户看到一个永久卡死、无法操作的任务。
 *
 * 所以这个类只暴露按 runId 的操作，**没有任何按下标的接口**：调用方拿不到下标，
 * 也就写不出那个 bug。`take()` 返回布尔值同样是必要的——"我以为我取到了"和
 * "我确实取到了"必须能区分，否则同一个 run 会被启动两次。
 */
import type { QueuedRun } from './run-types'

export class RunQueue {
  private readonly entries: QueuedRun[] = []

  push(entry: QueuedRun): void {
    this.entries.push(entry)
  }

  /**
   * 迭代用的快照。**必须基于快照迭代**：迭代期间队列会被同步移除条目，
   * 直接遍历活数组就回到了 C1。
   */
  snapshot(): readonly QueuedRun[] {
    return [...this.entries]
  }

  /** 按 runId 重新定位条目。快照里的对象可能已经被移走了，用它确认还在。 */
  find(runId: string): QueuedRun | undefined {
    return this.entries.find(entry => entry.runId === runId)
  }

  /** 取出条目。返回是否**真的**由本次调用取到——别人先取走了就返回 false（C1）。 */
  take(runId: string): boolean {
    const index = this.entries.findIndex(entry => entry.runId === runId)
    if (index === -1) return false
    this.entries.splice(index, 1)
    return true
  }

  /** 某个 task 当前排队的全部 runId。用于暂停/取消时逐条取出。 */
  runIdsFor(taskId: string): string[] {
    return this.entries.filter(entry => entry.taskId === taskId).map(entry => entry.runId)
  }

  get size(): number {
    return this.entries.length
  }
}


