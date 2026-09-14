/**
 * electron/service/employee-directory.ts — 平台订阅目录的读取入口
 *
 * `GET /client/subscriptions` 是授权和运行时共同依赖的目录入口。这里用 TTL 缓存和单飞
 * 去重，避免同一轮准入重复请求平台：
 *   - TTL 内直接给快照，不发请求；
 *   - TTL 外的并发请求合并成一次往返，避免惊群。
 *
 * 失败不写缓存也不供陈旧数据，保持原有的失败语义：调用方照旧看到错误。
 *
 * 这里是**全后端唯一的平台目录读取点**。`snapshot()` 是唯一的目录快照，
 * 不允许任何调用方再自己存一份副本——C10 就是"两份副本其中一份忘了清"造成的。
 * 身份变化时必须 `invalidate()`：缓存不按身份分键。
 */
import type { Subscription } from '../common/platform/platform-api'

const DEFAULT_TTL_MS = 15_000

export class EmployeeDirectory {
  private cached: { instances: Subscription[]; fetchedAt: number } | null = null
  private inFlight: Promise<Subscription[]> | null = null

  constructor(
    private readonly fetchInstances: (accessToken: string) => Promise<Subscription[]>,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** ACTIVE 订阅列表。命中 TTL 走缓存，未命中则合并并发请求。 */
  async list(accessToken: string): Promise<Subscription[]> {
    const cached = this.cached
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.instances
    return this.refresh(accessToken)
  }

  /** 绕过 TTL 强制刷新，仍然与在途请求合并。用户显式刷新时用。 */
  async refresh(accessToken: string): Promise<Subscription[]> {
    const existing = this.inFlight
    if (existing) return existing
    const operation = (async () => {
      const instances = await this.fetchInstances(accessToken)
      const active = instances.filter(instance => instance.status === 'ACTIVE')
      this.cached = { instances: active, fetchedAt: this.now() }
      return active
    })()
    this.inFlight = operation
    try {
      return await operation
    } finally {
      if (this.inFlight === operation) this.inFlight = null
    }
  }

  /** 最近一次成功读取的快照，不发请求。调度循环里只能用这个。 */
  snapshot(): Subscription[] {
    return this.cached?.instances ?? []
  }

  invalidate(): void {
    this.cached = null
  }
}

