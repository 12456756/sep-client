import { gitHubCredentialsSchema, qqMailCredentialsSchema, type ConnectorId, type ConnectorState, type GitHubCredentials, type QQMailCredentials } from '../../src/shared/connectors'
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
    if (id === 'github') throw appError('INVALID_ARGUMENT', { message: '请填写 GitHub 个人访问令牌后连接。' })
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
  async connectGitHub(credentials: GitHubCredentials): Promise<void> {
    const owner = requireScope(this.scope)
    const parsed = gitHubCredentialsSchema.safeParse(credentials)
    if (!parsed.success) throw appError('INVALID_ARGUMENT', { message: '请输入有效的 GitHub 个人访问令牌并选择访问模式。' })
    try { await (await (await this.runtime()).provider('github')).connect(owner, parsed.data) }
    catch (error) { throw appError('INVALID_ARGUMENT', { message: error instanceof ConnectorInputError ? error.message : 'GitHub 连接失败，请检查网络和系统安全存储后重试。' }) }
  }
}
