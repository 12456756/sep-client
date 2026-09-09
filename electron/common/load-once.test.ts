/**
 * loadOnce 的回归测试。
 *
 * 重点是**失败路径**：Phase 4 之前 main.ts 的 `ensureTaskCoordinator()` 在初始化失败时
 * 会让并发等待者拿到 undefined 而不是拒绝。下面第三个用例专门盯这件事——
 * 把旧写法放回去它立刻变红。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { loadOnce } from './load-once'

/** 手动控制的 promise，用来精确安排"并发等待者已经挂上去了"这个时刻。 */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('loadOnce', () => {
  it('loads once no matter how many callers race', async () => {
    let loads = 0
    const lazy = loadOnce(async () => {
      loads += 1
      return { id: loads }
    })

    const results = await Promise.all([lazy.get(), lazy.get(), lazy.get()])

    assert.equal(loads, 1)
    assert.equal(results[0], results[1])
    assert.equal(results[1], results[2])
  })

  it('exposes the resolved value to peek, but only after it resolves', async () => {
    const barrier = gate<string>()
    const lazy = loadOnce(() => barrier.promise)

    assert.equal(lazy.peek(), null, '还没加载完就不该有值')
    const inFlight = lazy.get()
    assert.equal(lazy.peek(), null, '加载中也不该有值')

    barrier.resolve('ready')
    assert.equal(await inFlight, 'ready')
    assert.equal(lazy.peek(), 'ready')
  })

  it('rejects every concurrent waiter instead of handing out undefined', async () => {
    const barrier = gate<string>()
    const lazy = loadOnce(() => barrier.promise)
    const failure = new Error('load failed')

    // 两个等待者必须在失败发生之前就挂上去，才复现原来的时序。
    const first = lazy.get()
    const second = lazy.get()
    barrier.reject(failure)

    await assert.rejects(first, failure)
    await assert.rejects(second, failure)
    assert.equal(lazy.peek(), null, '失败后不能留下半成品')
  })

  it('retries on the next call after a failure', async () => {
    let attempts = 0
    const lazy = loadOnce(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return 'second attempt'
    })

    await assert.rejects(lazy.get(), /transient/)
    assert.equal(await lazy.get(), 'second attempt')
    assert.equal(attempts, 2)
    assert.equal(lazy.peek(), 'second attempt')
  })
})
