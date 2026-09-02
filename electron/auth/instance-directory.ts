/**
 * electron/auth/instance-directory.ts — 平台订阅目录的读取入口
 *
 * `GET /client/subscriptions` 此前每次授权都打一次，一个 run 至少 3 次往返
 * （IPC handler、coordinator.executeTask、pump 各一次）。这里加 TTL 缓存与单飞去重：
 *   - TTL 内直接给快照，不发请求；
 *   - TTL 外的并发请求合并成一次往返，避免惊群。
 *
 * 失败不写缓存也不供陈旧数据，保持原有的失败语义：调用方照旧看到错误。
 * 方案第 2 章 C4；Phase 5 会正式落成 service/employee-directory.ts。
 */
import type { ClientInstance } from './auth-api'

const DEFAULT_TTL_MS = 15_000

export class InstanceDirectory {
  private cached: { instances: ClientInstance[]; fetchedAt: number } | null = null
  private inFlight: Promise<ClientInstance[]> | null = null

  constructor(
    private readonly fetchInstances: (accessToken: string) => Promise<ClientInstance[]>,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** ACTIVE 订阅列表。命中 TTL 走缓存，未命中则合并并发请求。 */
  async list(accessToken: string): Promise<ClientInstance[]> {
    const cached = this.cached
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.instances
    return this.refresh(accessToken)
  }

  /** 绕过 TTL 强制刷新，仍然与在途请求合并。用户显式刷新时用。 */
  async refresh(accessToken: string): Promise<ClientInstance[]> {
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
  snapshot(): ClientInstance[] {
    return this.cached?.instances ?? []
  }

  invalidate(): void {
    this.cached = null
  }
}
