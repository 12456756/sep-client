import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { gitHubCredentialsSchema, type ConnectorCredentials, type ConnectorState } from '../../src/shared/connectors'
import type { ConnectorStore } from '../data/connector-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { WriteChain } from '../data/write-chain'
import { ConnectorInputError, type ConnectorBinding, type ConnectorRuntimePort } from '../domain/connectors'
import { GITHUB_ENDPOINT, GITHUB_READ_TOOLS, gitHubHttpFailure, gitHubMcpFetch, gitHubTools, verifyGitHub } from './github-api'

const recordSchema = z.object({ revision: z.uuid(), connectedAt: z.number(), credentials: gitHubCredentialsSchema, login: z.string().min(1).max(39).regex(/^[A-Za-z0-9-]+$/), tools: z.array(z.string()).max(32) })
const key = (scope: TaskOwnerScope): string => JSON.stringify([scope.enterpriseId, scope.memberId])

export class GitHubWorkspaceRuntime implements ConnectorRuntimePort {
  private readonly attempts = new Map<string, AbortController>()
  private readonly versions = new Map<string, string>()
  private readonly leases = new Map<string, AbortController>()
  private readonly writes = new WriteChain()
  private epoch = 0
  constructor(private readonly options: { store: Pick<ConnectorStore, 'read' | 'write'>; currentScope(): TaskOwnerScope | null; request?: typeof fetch }) {}
  private current(scope: TaskOwnerScope): boolean { const owner = this.options.currentScope(); return !!owner && key(owner) === key(scope) }
  private async read(scope: TaskOwnerScope) { const value = await this.options.store.read(scope); return value == null ? undefined : recordSchema.parse(value) }
  private invalidate(scope: TaskOwnerScope): void { this.leases.get(key(scope))?.abort(); this.leases.delete(key(scope)); this.versions.set(key(scope), randomUUID()) }
  async state(scope: TaskOwnerScope): Promise<ConnectorState> {
    const epoch = this.epoch
    if (!this.current(scope)) return { id: 'github', status: 'disconnected' }
    if (this.attempts.has(key(scope))) return { id: 'github', status: 'authorizing', phase: 'authorization' }
    try {
      const record = await this.read(scope)
      if (!record || !this.current(scope) || epoch !== this.epoch) return { id: 'github', status: 'disconnected' }
      if (this.versions.has(key(scope)) && this.versions.get(key(scope)) !== record.revision) return { id: 'github', status: 'error', error: 'GitHub 连接已失效，请重新连接。' }
      return { id: 'github', status: 'connected', coverage: 'development', connectedAt: record.connectedAt, accountLabel: record.login, readOnly: record.credentials.readOnly }
    } catch { return { id: 'github', status: 'error', error: '无法读取 GitHub 连接，请检查系统安全存储。' } }
  }
  async connect(scope: TaskOwnerScope, credentials?: ConnectorCredentials): Promise<void> {
    const parsed = gitHubCredentialsSchema.safeParse(credentials)
    if (!parsed.success) throw new ConnectorInputError('请输入有效的 GitHub 个人访问令牌并选择访问模式。')
    if (!this.current(scope)) throw new ConnectorInputError('登录身份已变化，请重新连接 GitHub。')
    if (this.attempts.has(key(scope))) throw new ConnectorInputError('正在验证 GitHub，请稍候。')
    const controller = new AbortController()
    const epoch = this.epoch
    this.attempts.set(key(scope), controller)
    const valid = (): boolean => !controller.signal.aborted && epoch === this.epoch && this.current(scope) && this.attempts.get(key(scope)) === controller
    try {
      await this.writes.run(key(scope), async () => {
        if (!valid()) throw new ConnectorInputError('GitHub 连接已取消。')
        const previous = await this.read(scope)
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
        const verified = await verifyGitHub(parsed.data, signal, async (input, init) => {
          if (!valid()) throw new ConnectorInputError('GitHub 连接已取消。')
          return (this.options.request ?? fetch)(input, init)
        })
        signal.throwIfAborted()
        if (!valid()) throw new ConnectorInputError('GitHub 连接已取消。')
        const revision = randomUUID()
        await this.options.store.write(scope, { revision, connectedAt: Date.now(), credentials: parsed.data, ...verified })
        if (!valid()) { await this.options.store.write(scope, previous ?? null); throw new ConnectorInputError('GitHub 连接已取消。') }
        this.invalidate(scope); this.versions.set(key(scope), revision)
      })
    } catch (error) { throw error instanceof ConnectorInputError ? error : new ConnectorInputError('GitHub 连接未完成，请检查网络和系统安全存储后重试。') }
    finally { if (this.attempts.get(key(scope)) === controller) this.attempts.delete(key(scope)) }
  }
  async disconnect(scope: TaskOwnerScope): Promise<void> {
    this.attempts.get(key(scope))?.abort(); this.attempts.delete(key(scope)); this.invalidate(scope)
    await this.writes.run(key(scope), () => this.options.store.write(scope, null))
  }
  cancel(): void {
    this.epoch++
    for (const controller of this.attempts.values()) controller.abort()
    for (const controller of this.leases.values()) controller.abort()
    this.attempts.clear(); this.leases.clear(); this.versions.clear()
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    const epoch = this.epoch
    if (!this.current(scope)) return undefined
    const record = await this.read(scope)
    if (!record || epoch !== this.epoch || !this.current(scope) || this.attempts.has(key(scope))) return undefined
    if (!this.versions.has(key(scope))) this.versions.set(key(scope), record.revision)
    if (this.versions.get(key(scope)) !== record.revision) return undefined
    let lease = this.leases.get(key(scope))
    if (!lease) { lease = new AbortController(); this.leases.set(key(scope), lease) }
    const signal = lease.signal
    const valid = (): boolean => !signal.aborted && epoch === this.epoch && this.current(scope) && this.versions.get(key(scope)) === record.revision && !this.attempts.has(key(scope))
    const request = gitHubMcpFetch(record.credentials, signal, this.options.request ?? fetch)
    return {
      revision: record.revision,
      servers: [{ name: 'github', transport: { type: 'streamable-http', url: GITHUB_ENDPOINT },
        enabledTools: gitHubTools(record.credentials.readOnly).filter(name => record.tools.includes(name)) }],
      remoteReadOnlyTools: { github: GITHUB_READ_TOOLS },
      fetch: async (input, init) => {
        if (!valid()) throw new ConnectorInputError('GitHub 连接不可用，请重新连接。')
        const response = await request(input, init)
        if (!valid()) { await response.body?.cancel(); throw new ConnectorInputError('GitHub 连接不可用，请重新连接。') }
        if (response.status === 401) {
          this.invalidate(scope)
          await this.writes.run(key(scope), async () => { if ((await this.read(scope))?.revision === record.revision) await this.options.store.write(scope, null) }).catch(() => undefined)
        }
        if (!response.ok && response.status !== 405) { await response.body?.cancel(); throw gitHubHttpFailure(response.status) }
        return response
      },
    }
  }
}
