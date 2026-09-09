/**
 * electron/common/load-once.ts — 只加载一次的异步惰性值
 *
 * 存在的理由是一个具体缺陷：手写的"惰性单例 + 初始化 promise"两字段写法在**失败**路径上
 * 会骗人。原来的形态是
 *
 *   if (value) return value
 *   if (loading) { await loading; return value! }      // <- 这里
 *   loading = (async () => { value = await build() })()
 *   try { await loading } catch { loading = null; throw }
 *
 * 加载失败时，第一个调用方把 `loading` 置回 null 并抛出，而已经挂在 `await loading`
 * 上的并发等待者看到的是一个已 settle 的 promise 加一个仍未赋值的 `value`，
 * `value!` 骗过类型检查后在运行时交出 undefined。
 *
 * 这里把"共享同一个 promise 的结果值"变成唯一实现，并且有测试盯着。
 */

export interface LazyAsync<T> {
  /** 取值。并发调用共享同一次加载；失败时每个等待者都收到同一个拒绝。 */
  get(): Promise<T>
  /** 已解析的值。没加载过、正在加载、或加载失败都返回 null。 */
  peek(): T | null
}

export function loadOnce<T>(load: () => Promise<T>): LazyAsync<T> {
  let pending: Promise<T> | null = null
  let resolved: T | null = null

  return {
    get(): Promise<T> {
      if (!pending) {
        pending = load().then(
          value => {
            resolved = value
            return value
          },
          (error: unknown) => {
            pending = null // 失败不缓存，下一次调用可以重试
            throw error
          },
        )
      }
      return pending
    },
    peek(): T | null {
      return resolved
    },
  }
}
