import type { ConnectorState, QQMailCredentials } from '../../src/shared/connectors'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorDependencyPort, DependencyProgress } from '../domain/connector-dependencies'
import type { ConnectorBinding, ConnectorRuntimePort } from '../domain/connectors'
import { ConnectorInputError } from '../domain/connectors'

const key = (scope: TaskOwnerScope): string => JSON.stringify([scope.enterpriseId, scope.memberId])
interface Attempt { controller: AbortController; done: Promise<void>; preparing: boolean; progress?: DependencyProgress; error?: string }

/** Account state and tool discovery never prepare executable dependencies. */
export class ManagedConnector implements ConnectorRuntimePort {
  private readonly attempts = new Map<string, Attempt>()
  private lifetime = new AbortController()
  private readonly leases = new Map<string, AbortController>()
  constructor(private readonly runtime: ConnectorRuntimePort, private readonly dependency: ConnectorDependencyPort,
    private readonly currentScope: () => TaskOwnerScope | null) {}
  private current(scope: TaskOwnerScope): boolean { const current = this.currentScope(); return !!current && key(current) === key(scope) }
  async state(scope: TaskOwnerScope): Promise<ConnectorState> {
    const state = await this.runtime.state(scope)
    const attempt = this.attempts.get(key(scope))
    if (!attempt || !this.current(scope)) return state
    if (attempt.error) return { ...state, status: state.status === 'connected' ? 'connected' : 'error', error: attempt.error }
    return attempt.preparing ? { ...state, status: 'preparing', dependency: attempt.progress } : state
  }
  async connect(scope: TaskOwnerScope, credentials?: QQMailCredentials): Promise<void> {
    if (!this.current(scope)) throw new Error('Connector account changed')
    const owner = key(scope)
    if (this.attempts.has(owner) && !this.attempts.get(owner)?.error) return
    const attempt: Attempt = { controller: new AbortController(), done: Promise.resolve(), preparing: true }
    this.attempts.set(owner, attempt)
    const valid = (): boolean => this.current(scope) && !attempt.controller.signal.aborted && this.attempts.get(owner) === attempt
    attempt.done = (async () => {
      await this.dependency.ensure(attempt.controller.signal, progress => { if (valid()) attempt.progress = progress })
      if (!valid()) return
      attempt.preparing = false
      attempt.progress = undefined
      await this.runtime.connect(scope, credentials)
      if (valid()) this.attempts.delete(owner)
    })().catch(() => {
      if (valid()) attempt.error = attempt.preparing ? '连接器组件下载或校验失败，请检查网络和磁盘空间后重试。' : '无法启动连接器，请检查网络和系统安全存储后重试。'
    })
  }
  async disconnect(scope: TaskOwnerScope): Promise<void> {
    const owner = key(scope)
    this.leases.get(owner)?.abort()
    this.leases.delete(owner)
    const attempt = this.attempts.get(owner)
    if (attempt) {
      attempt.controller.abort()
      this.attempts.delete(owner)
      // Canceling preparation preserves a previously authorized account.
      if (attempt.preparing) { await attempt.done; return }
      await this.runtime.disconnect(scope)
      await attempt.done
      return
    }
    await this.runtime.disconnect(scope)
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    const attempt = this.attempts.get(key(scope))
    if (attempt && !attempt.error) return undefined
    const binding = await this.runtime.binding(scope)
    if (!binding) return undefined
    const owner = key(scope)
    let lease = this.leases.get(owner)
    if (!lease) { lease = new AbortController(); this.leases.set(owner, lease) }
    const signal = AbortSignal.any([this.lifetime.signal, lease.signal])
    const ensure = async (source?: AbortSignal): Promise<void> => {
      const combined = source ? AbortSignal.any([signal, source]) : signal
      if (!this.current(scope)) throw new Error('Connector account changed')
      try { await this.dependency.ensure(combined, () => {}) }
      catch { throw new ConnectorInputError('连接器组件尚未准备完成，请检查网络后重试。') }
      combined.throwIfAborted()
      if (!this.current(scope)) throw new Error('Connector account changed')
    }
    return { ...binding, commands: binding.commands?.map(command => ({ ...command,
      reference: async (path, source) => { await ensure(source); return command.reference(path, source) },
      schema: async (path, source) => { await ensure(source); return command.schema(path, source) },
      execute: async (args, workspace, source) => { await ensure(source); return command.execute(args, workspace, source) },
    })) }
  }
  cancel(): void {
    this.lifetime.abort(); this.lifetime = new AbortController()
    this.leases.clear()
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    this.attempts.clear()
    this.runtime.cancel()
  }
}
