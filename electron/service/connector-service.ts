import { qqMailCredentialsSchema, type ConnectorId, type ConnectorState, type QQMailCredentials } from '../../src/shared/connectors'
import { ConnectorInputError } from '../domain/connectors'
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
  async connectQQMail(credentials: QQMailCredentials): Promise<void> {
    const owner = requireScope(this.scope)
    const parsed = qqMailCredentialsSchema.safeParse(credentials)
    if (!parsed.success) throw appError('INVALID_ARGUMENT', { message: '请输入 QQ 邮箱地址和 16 位授权码。' })
    try { await (await (await this.runtime()).provider('qqmail')).connect(owner, parsed.data) }
    catch (error) { throw appError('INVALID_ARGUMENT', { message: error instanceof ConnectorInputError ? error.message : '无法保存邮箱连接，请检查系统安全存储后重试。' }) }
  }
  async binding(owner: TaskOwnerScope): Promise<ConnectorBinding | undefined> { return (await this.runtime()).binding(owner) }
}
