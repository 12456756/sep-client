/**
 * electron/runtime/run-types.ts — 执行层的共享类型
 *
 * Phase 8 把协调器拆成"编排者 + 五个协作者"，于是队列、worker 注册表、事件管道都要说
 * 同一套词汇。这些类型此前散在 `task-execution-coordinator.ts` 里，谁想用就得 import
 * 那个文件——而它静态 import 了 pi SDK，服务层因此只能靠 `import type` 侥幸躲过
 * （类型擦除）。放在这里之后依赖关系是干净的：所有人向下 import 一个零依赖的类型模块。
 */

/** 一个员工在某次运行里的完整配置。授权在入队前算好，随队列条目携带（C4）。 */
export interface EmployeeRuntimeConfig {
  subscriptionId: string
  modelId: string
  gatewayUrl: string
  /** 技能包路径。**入队时必须带上**——排队过的 run 不会再重算一次授权。 */
  additionalSkillPaths?: string[]
}

/**
 * 会话文件损坏时的恢复策略。
 *   - `strict`                     不重建，直接失败
 *   - `confirm_rebuild`            要用户确认后才依据任务历史重建（默认）
 *   - `auto_rebuild_from_task_history` 直接重建
 */
export type SessionRecoveryMode = 'strict' | 'confirm_rebuild' | 'auto_rebuild_from_task_history'

/** 外部对一个在跑的 run 下达的意图。终态由它决定，而不是由"有没有异常"决定。 */
export type ControlIntent = 'none' | 'pause' | 'cancel' | 'interrupt'

/** 协调器需要 worker 的三件事。真实实现是 `pi/sdk/pi-task-worker.ts`。 */
export interface TaskWorkerPort {
  run(prompt: string): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void>
}

/** 已准入、等待工作区锁的 run。 */
export interface QueuedRun {
  taskId: string
  runId: string
  subscriptionId: string
  /** 入队前授权一次的结果，随条目携带（C4）。调度循环内只读，不再发网络请求。 */
  employee: EmployeeRuntimeConfig
  prompt: string
  conversation: boolean
  resumeSessionFile?: string
  /** 会话重建时喂给 worker 的替代提示（含历史转写）。 */
  workerPrompt?: string
  degradedRecovery?: { originalSessionFile: string; mode: SessionRecoveryMode }
}

/** 正在跑的 run。`completion` 在 `finally` 里 resolve，所以一定会 settle（C2）。 */
export interface ActiveRun {
  taskId: string
  runId: string
  subscriptionId: string
  releaseWorkspace: () => void
  worker: TaskWorkerPort
  control: ControlIntent
  completion: Promise<void>
}
