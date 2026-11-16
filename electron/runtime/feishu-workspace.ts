import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ConnectorState } from '../../src/shared/connectors'
import type { ConnectorStore } from '../data/connector-store'
import type { ConnectorProcessDirectories } from '../data/connector-process-directories'
import type { TaskOwnerScope } from '../data/scope-path'
import { WriteChain } from '../data/write-chain'
import type { ConnectorBinding, ConnectorRuntimePort, ConnectorCommandResult, ConnectorCommandBinding } from '../domain/connectors'
import { FeishuOAuth, feishuAppSchema, feishuTokenSchema } from './feishu-oauth'
import { feishuSchemaArgs, runFeishu, validateFeishuArgs, type FeishuRunner } from './feishu-command'

const recordSchema = z.object({ revision: z.string(), connectedAt: z.number().optional(), app: feishuAppSchema, token: feishuTokenSchema.optional() })
const key = (scope: TaskOwnerScope): string => JSON.stringify([scope.enterpriseId, scope.memberId])
interface Attempt { controller: AbortController; done: Promise<void>; state: ConnectorState }
export class FeishuWorkspaceRuntime implements ConnectorRuntimePort {
  private readonly attempts = new Map<string, Attempt>()
  private readonly leases = new Map<string, AbortController>()
  private readonly versions = new Map<string, string>()
  private readonly writes = new WriteChain()
  private readonly oauth: Pick<FeishuOAuth, 'register' | 'login' | 'refresh' | 'revoke'>
  constructor(private readonly options: {
    store: ConnectorStore; directories: ConnectorProcessDirectories; binary: string
    currentScope(): TaskOwnerScope | null
    open(url: string): Promise<void>
    oauth?: Pick<FeishuOAuth, 'register' | 'login' | 'refresh' | 'revoke'>
    runner?: FeishuRunner
  }) { this.oauth = options.oauth ?? new FeishuOAuth() }
  private current(scope: TaskOwnerScope): boolean { const owner = this.options.currentScope(); return !!owner && key(owner) === key(scope) }
  private async read(scope: TaskOwnerScope): Promise<z.infer<typeof recordSchema> | undefined> {
    const value = await this.options.store.read(scope)
    return value == null ? undefined : recordSchema.parse(value)
  }
  async state(scope: TaskOwnerScope): Promise<ConnectorState> {
    if (!this.current(scope)) return { id: 'feishu', status: 'disconnected' }
    const attempt = this.attempts.get(key(scope))
    if (attempt) return attempt.state
    try {
      const record = await this.read(scope)
      if (!record?.token) return { id: 'feishu', status: 'disconnected' }
      if (this.versions.has(key(scope)) && this.versions.get(key(scope)) !== record.revision || Math.max(record.token.expiresAt, record.token.refreshToken ? record.token.refreshExpiresAt : 0) <= Date.now()) return { id: 'feishu', status: 'error', error: '飞书授权已失效，请重新连接。' }
      return { id: 'feishu', status: 'connected', coverage: 'workspace', connectedAt: record.connectedAt,
        ...(!record.token.refreshToken ? { notice: `当前授权无法自动续期，将于 ${new Date(record.token.expiresAt).toLocaleString('zh-CN')} 到期。应用管理员需启用“刷新 user_access_token”并发布后重新授权。` } : {}),
      }
    } catch { return { id: 'feishu', status: 'error', error: '无法读取飞书授权，请检查系统安全存储。' } }
  }
  private invalidate(scope: TaskOwnerScope): void {
    this.leases.get(key(scope))?.abort(); this.leases.delete(key(scope)); this.versions.set(key(scope), randomUUID())
  }
  async connect(scope: TaskOwnerScope): Promise<void> {
    if (!this.current(scope)) throw new Error('Connector account changed.')
    if (this.attempts.get(key(scope))?.state.status === 'authorizing') return
    this.invalidate(scope)
    const attempt: Attempt = { controller: new AbortController(), done: Promise.resolve(), state: { id: 'feishu', status: 'authorizing', phase: 'setup' } }
    this.attempts.set(key(scope), attempt)
    const valid = (): boolean => !attempt.controller.signal.aborted && this.current(scope) && this.attempts.get(key(scope)) === attempt
    let started = false
    let resolveStart!: () => void
    let rejectStart!: (error: Error) => void
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
    const open = async (url: string): Promise<void> => {
      if (!valid()) throw new Error('Connector authorization cancelled.')
      await this.options.open(url)
      if (!valid()) throw new Error('Connector authorization cancelled.')
      started = true; resolveStart()
    }
    attempt.done = this.writes.run(key(scope), async () => {
      if (!valid()) throw new Error('Connector account changed.')
      // Explicit connection always lets the user choose the app and organization again.
      const app = await this.oauth.register(open, attempt.controller.signal)
      if (!valid()) throw new Error('Connector account changed.')
      // Never persist a user token before the selected application's OAuth completes.
      await this.options.store.write(scope, { revision: randomUUID(), app })
      attempt.state = { id: 'feishu', status: 'authorizing', phase: 'authorization' }
      const token = await this.oauth.login(app, open, attempt.controller.signal)
      if (!valid()) throw new Error('Connector account changed.')
      const revision = randomUUID()
      await this.options.store.write(scope, { revision, connectedAt: Date.now(), app, token })
      if (!valid()) { await this.options.store.write(scope, { revision: randomUUID(), app }); return }
      this.versions.set(key(scope), revision)
      this.attempts.delete(key(scope))
    }).catch(() => {
      if (!started) rejectStart(new Error('无法启动飞书授权。'))
      if (valid()) attempt.state = { id: 'feishu', status: 'error', error: '飞书授权未完成，请重试；首次连接需要先在飞书完成应用配置。' }
    })
    return start
  }
  async disconnect(scope: TaskOwnerScope): Promise<void> {
    const attempt = this.attempts.get(key(scope))
    attempt?.controller.abort(); this.attempts.delete(key(scope)); this.invalidate(scope)
    await attempt?.done
    await this.writes.run(key(scope), async () => {
      const record = await this.read(scope)
      // Local access ends immediately, including when remote revocation is offline.
      await this.options.store.write(scope, record ? { revision: randomUUID(), app: record.app } : null)
      if (record?.token) await this.oauth.revoke(record.app, record.token)
    })
  }
  cancel(): void {
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    for (const lease of this.leases.values()) lease.abort()
    this.attempts.clear(); this.leases.clear(); this.versions.clear()
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    if (!this.current(scope) || this.attempts.has(key(scope)) || (await this.state(scope)).status !== 'connected') return undefined
    const record = await this.read(scope)
    if (!record?.token) return undefined
    if (!this.versions.has(key(scope))) this.versions.set(key(scope), record.revision)
    let lease = this.leases.get(key(scope))
    if (!lease) { lease = new AbortController(); this.leases.set(key(scope), lease) }
    const signal = lease.signal
    const valid = (): boolean => !signal.aborted && this.current(scope) && this.versions.get(key(scope)) === record.revision
    const invoke = async (args: string[], workspace?: string, source?: AbortSignal): Promise<ConnectorCommandResult> => {
      const combined = source ? AbortSignal.any([signal, source]) : signal
      try {
        const identity = await this.writes.run(key(scope), async () => {
          if (!valid() || combined.aborted) throw new Error('Connector account changed.')
          const fresh = await this.read(scope)
          if (!fresh?.token || fresh.revision !== record.revision) throw new Error('Connector account changed.')
          if (fresh.token.expiresAt <= Date.now() + 120000) {
            if (!fresh.token.refreshToken || fresh.token.refreshExpiresAt <= Date.now()) { this.invalidate(scope); throw new Error('Reconnect required.') }
            try {
              // Rotating refresh tokens are persisted before any business command is launched.
              const token = await this.oauth.refresh(fresh.app, fresh.token, signal)
              if (!valid()) throw new Error('Connector account changed.')
              fresh.token = token
              await this.options.store.write(scope, fresh)
              if (!valid()) { await this.options.store.write(scope, { revision: randomUUID(), app: fresh.app }); throw new Error('Connector account changed.') }
            } catch { this.invalidate(scope); throw new Error('Reconnect required.') }
          }
          return { clientId: fresh.app.clientId, token: fresh.token }
        })
        if (!valid() || combined.aborted) throw new Error('Connector account changed.')
        const result = await this.options.directories.run(scope, directory => (this.options.runner ?? runFeishu)({ binary: this.options.binary, directory, cwd: workspace ?? directory, args, signal: combined, identity }))
        if (result.isError) {
          try {
            const value: unknown = JSON.parse(result.text)
            const error = z.object({ error: z.object({ type: z.string().optional(), code: z.number().optional() }) }).safeParse(value)
            if (valid() && error.success && (error.data.error.type === 'authentication' || [99991663, 99991664, 99991668, 99991669].includes(error.data.error.code ?? 0))) this.invalidate(scope)
          } catch { /* Preserve a CLI error without interpreting free text. */ }
        }
        return result
      } catch { return { text: '飞书调用未完成，请检查连接状态；有副作用的操作请先核实结果。', isError: true, executionUncertain: true } }
    }
    const command: ConnectorCommandBinding = { id: 'feishu', name: '飞书', instructions: {
      reference: 'Read official embedded Feishu CLI instructions. Start with lark-shared/SKILL.md and use lark-<product>/SKILL.md or lark-<product>/references/*.md. Use feishu_execute instead of bash; auth and identity are managed by the client.',
      schema: 'Inspect the exact Feishu CLI command contract. Use a space-separated command path for --help, e.g. calendar +agenda, or a dotted API schema such as calendar.events.instance_view. Do not guess arguments.',
      execute: 'Execute a Feishu business command as the connected personal user. args is argv without lark-cli. Read the relevant official reference and command schema first. Client fixes user identity and JSON output. No auth/config/profile/token/identity override flags. Writes need approval; high-risk confirmation flags require explicit user approval for the concrete action. Never retry uncertain writes. Preserve pagination and verify writes with a read. Granted scopes and account permissions determine availability.',
    },
      reference: async (path, source) => {
        if (!/^lark-[a-z-]+\/(?:SKILL\.md|(?:references|routes|scenes)\/[\w/.-]+\.md)$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid Feishu reference.')
        const result = await invoke(['skills', 'read', path, '--json'], undefined, source)
        if (result.isError) throw new Error('Feishu reference unavailable.')
        return z.object({ content: z.string() }).parse(JSON.parse(result.text)).content
      },
      schema: (path, source) => invoke(feishuSchemaArgs(path), undefined, source),
      execute: (args, workspace, source) => invoke(validateFeishuArgs(args), workspace, source),
    }
    return { revision: record.revision, servers: [], fetch, commands: [command] }
  }
}
