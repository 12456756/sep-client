/**
 * electron/common/with-timeout.ts — 有界等待
 *
 * 后端所有"等外部资源"的地方都必须有上限：停机、认证失效清理、平台请求。
 * 无界等待的后果是进程挂在退出路径上，或者用户点了操作却永远没有反馈。
 */

export class TimeoutError extends Error {
  readonly operation: string
  readonly timeoutMs: number

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} did not finish within ${timeoutMs}ms.`)
    this.name = 'TimeoutError'
    this.operation = operation
    this.timeoutMs = timeoutMs
  }
}

/**
 * 等待 `work`，超过 `timeoutMs` 即以 TimeoutError 拒绝。
 *
 * 底层操作**不会**被取消——JS 没有这个能力；超时只是让调用方不再等下去。
 * 因此调用方必须自己决定超时后怎么办（记 error、放弃、强制退出）。
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(operation, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 与 withTimeout 相同，但超时和失败都不抛，只回报结果，便于停机路径使用。 */
export async function settleWithTimeout(
  work: Promise<unknown>,
  timeoutMs: number,
  operation: string,
): Promise<{ ok: true } | { ok: false; timedOut: boolean; error: unknown }> {
  try {
    await withTimeout(work, timeoutMs, operation)
    return { ok: true }
  } catch (error) {
    return { ok: false, timedOut: error instanceof TimeoutError, error }
  }
}


