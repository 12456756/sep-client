/**
 * electron/bootstrap/shutdown.ts — 有序停机（C3）
 *
 * Electron 不 await 生命周期监听器的返回值，所以原来挂在 `will-quit` 上的 async
 * `stopAll()` 在第一个 await 处就被丢下，进程继续退出：in-flight 副作用工具的
 * `SIDE_EFFECT_UNKNOWN` 不落盘、worker 不 dispose、pi 会话文件可能半写。
 *
 * 改成两阶段：`before-quit` 先 `preventDefault()` 拦住退出，在有界预算内收干净，
 * 再 `app.exit(0)` 强制退出。预算必须有界（C7）——`stopAll` 内部会等每个 active run
 * 的 abort 与 completion，慢磁盘上事件落盘链也没有上限。
 */
import { app } from 'electron'
import { logger, type LogFields } from '../common/logger'
import { describeError } from '../common/redact'
import { settleWithTimeout } from '../common/with-timeout'

const log = logger.child('shutdown')

/** 停机预算。必须有界：worker.abort() 与事件落盘都可能卡住（C3/C7）。 */
export const SHUTDOWN_BUDGET_MS = 5_000

export interface ShutdownOptions {
  /** 收干净所有在跑的 run。停机唯一要做的事。 */
  stop: () => Promise<void>
  /** 进日志的停机现场，例如协调器是否加载过、还有几个 run 在跑。 */
  describeState?: () => LogFields
}

export function installShutdownHandler({ stop, describeState }: ShutdownOptions): void {
  let shuttingDown = false

  app.on('before-quit', event => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true

    const startedAt = Date.now()
    log.info('shutdown started', describeState?.())

    void settleWithTimeout(stop(), SHUTDOWN_BUDGET_MS, 'shutdown')
      .then(result => {
        if (result.ok) {
          log.info('shutdown complete', { elapsedMs: Date.now() - startedAt })
          return
        }
        // 超时说明有 run 没收干净：SIDE_EFFECT_UNKNOWN 可能没落盘，
        // 下次启动只能靠 markActiveRunsInterrupted 兜底，精度更低。
        log.error('shutdown did not finish within budget', {
          elapsedMs: Date.now() - startedAt,
          budgetMs: SHUTDOWN_BUDGET_MS,
          timedOut: result.timedOut,
          cause: result.timedOut ? undefined : describeError(result.error),
        })
      })
      .finally(() => app.exit(0))
  })
}
