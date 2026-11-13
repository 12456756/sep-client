import { randomUUID } from 'node:crypto'
import type { ConnectorState } from '../../src/shared/connectors'
import type { WecomWorkspaceStore } from '../data/wecom-workspace-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorBinding, ConnectorCommandResult, ConnectorRuntimePort } from '../domain/connectors'
import { runWecom, validateWecomArgs, wecomAuthorizationUrl, wecomSchemaArgs, type WecomRunner } from './wecom-command'
import { WecomSuccessPage } from './wecom-success-page'

const key = (scope: TaskOwnerScope): string => JSON.stringify([scope.enterpriseId, scope.memberId])
interface Attempt { controller: AbortController; done: Promise<void>; state: ConnectorState }
const notice = '消息读取和发送范围取决于企业策略与本次授权；员工消息与机器人消息身份不同。授权失效后需重新扫码。'
const guide = `WeCom CLI 1.3.4 is managed by CSEP. Never use shell or auth/config commands.
Use wecom_schema with chat, message, identity or contact to discover services. Then inspect the exact method before calling wecom_execute.
Pass argv without wecom-cli. Supply a JSON object using --json; pagination uses --page-count (1-10), preserving every page and cursor.
Read only the conversations the user requested. Account authorization does not imply access to all conversations.
Before sending, verify the actual sending identity, exact recipient, content, and official method schema. Never invent IDs or switch from employee to bot identity after failure.
message aibot sends as a bot; it is NOT sending as the employee. For bot sends, identity whoami identifies the authorizer; other recipients must be matched against a fresh message aibot sessions list. No match or multiple matches requires clarification.
All execute calls require CSEP approval. Preserve policy error 853006; it does not mean logout. Auth expiry 853004 requires reconnect.
Do not retry uncertain writes. First release supports text messaging, conversation queries, identity and contacts; local attachments and downloads are not exposed.`

export class WecomWorkspaceRuntime implements ConnectorRuntimePort {
  private readonly attempts = new Map<string, Attempt>()
  private readonly leases = new Map<string, AbortController>()
  private readonly versions = new Map<string, string>()
  private readonly expired = new Set<string>()
  constructor(private readonly options: {
    store: WecomWorkspaceStore; binary: string
    currentScope(): TaskOwnerScope | null
    open(url: string): Promise<void>
    runner?: WecomRunner
  }) {}
  private current(scope: TaskOwnerScope): boolean {
    const current = this.options.currentScope()
    return !!current && key(current) === key(scope)
  }
  private runner: WecomRunner = options => (this.options.runner ?? runWecom)(options)
  private invalidate(scope: TaskOwnerScope): void {
    this.leases.get(key(scope))?.abort()
    this.leases.delete(key(scope))
    this.versions.set(key(scope), randomUUID())
  }
  async state(scope: TaskOwnerScope): Promise<ConnectorState> {
    if (!this.current(scope)) return { id: 'wecom', status: 'disconnected' }
    const attempt = this.attempts.get(key(scope))
    if (attempt) return attempt.state
    if (this.expired.has(key(scope))) return { id: 'wecom', status: 'error', error: '企业微信授权已失效，请重新扫码连接。' }
    try {
      const record = await this.options.store.read(scope)
      return record ? { id: 'wecom', status: 'connected', coverage: 'messaging', connectedAt: record.connectedAt, accountLabel: `CLI 绑定：${record.botId}`, notice } : { id: 'wecom', status: 'disconnected' }
    } catch { return { id: 'wecom', status: 'error', error: '无法读取企业微信授权，请检查系统安全存储。' } }
  }
  async connect(scope: TaskOwnerScope): Promise<void> {
    if (!this.current(scope)) throw new Error('WeCom account changed.')
    if (this.attempts.get(key(scope))?.state.status === 'authorizing') return
    this.invalidate(scope)
    this.expired.delete(key(scope))
    const attempt: Attempt = { controller: new AbortController(), done: Promise.resolve(), state: { id: 'wecom', status: 'authorizing', phase: 'authorization', notice: '请在浏览器中使用企业微信扫码并确认授权。' } }
    this.attempts.set(key(scope), attempt)
    const valid = (): boolean => !attempt.controller.signal.aborted && this.current(scope) && this.attempts.get(key(scope)) === attempt
    let started = false
    let resolveStart!: () => void
    let rejectStart!: (error: Error) => void
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
    attempt.done = this.options.store.authorize(scope, valid, async ({ config, workspace }) => {
      let opening: Promise<void> | undefined
      const result = await this.runner({ binary: this.options.binary, directory: config, cwd: workspace,
        args: ['auth', 'init', '--noninteractive', '--no-browser'], signal: attempt.controller.signal, timeoutMs: 330000,
        onOutput: output => {
          if (opening || !valid()) return
          const url = wecomAuthorizationUrl(output)
          if (!url) return
          opening = this.options.open(url).then(() => {
            if (!valid()) throw new Error('WeCom authorization cancelled.')
            started = true; resolveStart()
          })
          void opening.catch(() => attempt.controller.abort())
        },
      })
      await opening
      if (!opening || result.isError || !valid()) throw new Error('WeCom authorization incomplete.')
      const status = await this.runner({ binary: this.options.binary, directory: config, cwd: workspace, args: ['auth', 'show', '--status'], signal: attempt.controller.signal })
      if (status.isError || status.text.trim() !== 'authorized') throw new Error('WeCom authorization incomplete.')
    }).then(async record => {
      if (!valid()) return
      this.versions.set(key(scope), record.revision)
      this.attempts.delete(key(scope))
      const connected = (): boolean => !attempt.controller.signal.aborted && this.current(scope) && this.versions.get(key(scope)) === record.revision
      let page: WecomSuccessPage | undefined
      try {
        page = await WecomSuccessPage.start(connected)
        if (!connected()) { page.close(); return }
        await this.options.open(page.url)
      } catch { page?.close() /* Browser display failure does not undo a completed connection. */ }
    }).catch(() => {
      if (!started) rejectStart(new Error('无法启动企业微信扫码授权，请检查网络或连接器运行组件。'))
      if (this.current(scope) && this.attempts.get(key(scope)) === attempt) attempt.state = { id: 'wecom', status: 'error', error: '企业微信扫码授权未完成或已超时，请重新连接。' }
    })
    return start
  }
  async disconnect(scope: TaskOwnerScope): Promise<void> {
    const attempt = this.attempts.get(key(scope))
    attempt?.controller.abort()
    this.attempts.delete(key(scope))
    this.invalidate(scope)
    this.expired.delete(key(scope))
    await attempt?.done
    await this.options.store.clear(scope)
  }
  cancel(): void {
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    for (const lease of this.leases.values()) lease.abort()
    this.attempts.clear(); this.leases.clear(); this.versions.clear()
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    if (!this.current(scope) || this.attempts.has(key(scope)) || this.expired.has(key(scope))) return undefined
    const record = await this.options.store.read(scope)
    if (!record) return undefined
    if (!this.versions.has(key(scope))) this.versions.set(key(scope), record.revision)
    if (this.versions.get(key(scope)) !== record.revision) return undefined
    let lease = this.leases.get(key(scope))
    if (!lease) { lease = new AbortController(); this.leases.set(key(scope), lease) }
    const signal = lease.signal
    const valid = (): boolean => !signal.aborted && this.current(scope) && this.versions.get(key(scope)) === record.revision
    const invoke = async (args: string[], source?: AbortSignal): Promise<ConnectorCommandResult> => {
      const combined = source ? AbortSignal.any([source, signal]) : signal
      try {
        if (!valid() || combined.aborted) throw new Error('WeCom account changed.')
        const fresh = await this.options.store.read(scope)
        if (!fresh || fresh.revision !== record.revision || !valid()) throw new Error('WeCom account changed.')
        const result = await this.options.store.run(scope, async ({ config, workspace }) => {
          if (!valid() || combined.aborted) throw new Error('WeCom account changed.')
          return this.runner({ binary: this.options.binary, directory: config, cwd: workspace, token: fresh.token, args, signal: combined })
        })
        if (!valid() || combined.aborted) throw new Error('WeCom account changed.')
        if (result.isError && !result.executionUncertain) {
          try {
            const value = JSON.parse(result.text) as { errcode?: number; error?: { code?: number } }
            if (value.errcode === 853004 || value.error?.code === 853004) { this.expired.add(key(scope)); this.invalidate(scope) }
          } catch { /* Preserve non-JSON errors; never infer expiry from error prose. */ }
        }
        return result
      } catch { return { text: '企业微信调用未完成；若已提交发送，请先核实结果，勿自动重发。', isError: true, executionUncertain: true } }
    }
    return { revision: record.revision, servers: [], fetch, commands: [{ id: 'wecom', name: '企业微信', instructions: {
      reference: 'Read CSEP WeCom integration instructions at SKILL.md. Authentication is managed by the client; do not use shell or auth/config commands.',
      schema: 'Inspect live official WeCom CLI contracts. Use a service or space-separated method for help, or a dotted method path for schema get. Services: chat, message, identity, contact. Do not guess commands or permissions.',
      execute: 'Execute an authorized WeCom business method. Read wecom_reference and the exact wecom_schema first. args is argv without wecom-cli; use --json for the request object. Sending identity and recipient must be verified: employee and bot messages are different. No automatic fallback, auth/config flags, filesystem operations, or retry of uncertain sends. Enterprise policy restrictions must be preserved.',
    }, reference: async path => {
      if (!valid() || path !== 'SKILL.md') throw new Error('WeCom reference unavailable.')
      return guide
    }, schema: (path, source) => invoke(wecomSchemaArgs(path), source),
    execute: (args, _workspace, source) => invoke(validateWecomArgs(args), source),
    }] }
  }
}
