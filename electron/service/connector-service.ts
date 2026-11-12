import type { ConnectorId, ConnectorState } from '../../src/shared/connectors'
import type { ConnectorBinding, ConnectorRegistryPort } from '../domain/connectors'
import type { TaskOwnerScope } from '../data/scope-path'
import { appError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

export class ConnectorService {
  constructor(private readonly scope: ScopeSource, private readonly runtime: () => Promise<ConnectorRegistryPort>) {}
  async state(id: ConnectorId): Promise<ConnectorState> { const owner = requireScope(this.scope); return (await (await this.runtime()).provider(id)).state(owner) }
  async connect(id: ConnectorId): Promise<void> {
    const owner = requireScope(this.scope)
    try { await (await (await this.runtime()).provider(id)).connect(owner) }
    catch { throw appError('INVALID_ARGUMENT', { message: '无法发起连接器授权，请检查网络和系统安全存储后重试。' }) }
  }
  async disconnect(id: ConnectorId): Promise<void> { const owner = requireScope(this.scope); await (await (await this.runtime()).provider(id)).disconnect(owner) }
  async binding(owner: TaskOwnerScope): Promise<ConnectorBinding | undefined> { return (await this.runtime()).binding(owner) }
}
