/**
 * electron/data/write-chain.ts — 按 key 串行化的写链
 *
 * 所有需要顺序写入的数据存储共用这一条泛型写链，避免不同 store 各自维护串行逻辑。
 *
 * 语义（对应不变式 I3 / I4 / I5）：
 *   - 同一 key 上的操作严格按提交顺序执行，不并发；
 *   - 前一个失败**不影响**后一个排队——错误交回各自的调用方，不串给邻居；
 *   - 链本身永远不是未处理拒绝源。这一条是 C6 修复的一部分：`tracked` 是 `result`
 *     的分支，如果不自带 catch，一旦这批之后没有后续操作来接它，它就是一条
 *     无人处理的 rejection。
 */
export class WriteChain {
  private readonly chains = new Map<string, Promise<void>>()

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve()
    const result = prior.then(operation)
    const tracked = result.then(() => undefined, () => undefined)
    this.chains.set(key, tracked)
    return result.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key)
    })
  }

  /** 未完成的链条数。测试用来确认链不会无限积累。 */
  get pending(): number {
    return this.chains.size
  }
}


