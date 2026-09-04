/**
 * electron/runtime/run-workers.ts — 在跑的 run 及其完成信号（C2）
 *
 * 不变式 I1：同一 taskId 最多一个 active run。这个类是它的唯一实现点。
 *
 * C2 是一个严重缺陷：工作区锁由 `pump()` 取得后传给 `startRun`，但建仓步骤
 * （`getPaths()`、`createWorker()`）此前在 `try` **之外**，任一处抛出就再也走不到
 * `finally`，`releaseWorkspace()` 永不调用——该工作目录被永久锁死，之后所有落在同一
 * 目录（含父子关系，`pathsOverlap` 判定重叠）的任务在 `pump` 里静默滞留，没有任何日志。
 *
 * 这里承担 C2 的两半：`createRunCompletion()` 保证完成信号在建仓之前就存在，
 * `forget()` 保证"移出注册表"只在仍是当前 run 时发生。锁的获取与释放留在 `startRun`
 * 的同一个 try/finally 词法块内——那是 C2 修法的关键形状，不能再拆开。
 */
import type { ActiveRun } from './run-types'

export interface RunCompletion {
  /** 等这条 run 收干净。pauseTask / cancelTask / stopAll 都 await 它。 */
  readonly promise: Promise<void>
  /** 在 `finally` 里调一次。重复调用无副作用。 */
  readonly settle: () => void
}

/**
 * 在 try 之前就建好，保证 finally 里一定有可调用的 settle（C2）。
 * 原来的 `let resolveCompletion!: () => void` 在建仓阶段抛出时还是 undefined，
 * 于是等 `completion` 的人永远等不到。
 */
export function createRunCompletion(): RunCompletion {
  let settle!: () => void
  const promise = new Promise<void>(resolve => { settle = resolve })
  return { promise, settle }
}

export class WorkerRegistry {
  private readonly activeByTask = new Map<string, ActiveRun>()

  /** 登记一条建仓成功的 run。同一 task 只会有一条（不变式 I1）。 */
  register(active: ActiveRun): void {
    this.activeByTask.set(active.taskId, active)
  }

  active(taskId: string): ActiveRun | undefined {
    return this.activeByTask.get(taskId)
  }

  /** 该 run 是否仍是这个 task 的当前 run。换过一轮就不是了。 */
  isCurrent(active: ActiveRun): boolean {
    return this.activeByTask.get(active.taskId) === active
  }

  list(): ActiveRun[] {
    return Array.from(this.activeByTask.values())
  }

  /** 移出注册表。**只在仍是当前 run 时**移除，否则会把后来者踢掉。 */
  forget(active: ActiveRun): void {
    if (this.activeByTask.get(active.taskId) === active) this.activeByTask.delete(active.taskId)
  }

  get size(): number {
    return this.activeByTask.size
  }
}
