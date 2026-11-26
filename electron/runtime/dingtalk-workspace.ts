import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import type { ConnectorState } from '../../src/shared/connectors'
import type { DingTalkWorkspaceStore } from '../data/dingtalk-workspace-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { ConnectorInputError, type ConnectorBinding, type ConnectorRuntimePort, type ConnectorCommandResult, type ConnectorCommandBinding } from '../domain/connectors'
import { runDingTalk, validateDingTalkArgs, evaluateDingTalkCommand, isScheduledDingTalkReadOnly, describeScheduledDingTalkOperation, dingTalkFailureReason, dingTalkSchemaArgs, DINGTALK_PRODUCTS, type DingTalkRunner } from './dingtalk-command'

const key = (scope: TaskOwnerScope): string => JSON.stringify([scope.enterpriseId, scope.memberId])
interface Attempt { controller: AbortController; done: Promise<void>; state: ConnectorState }
export class DingTalkWorkspaceRuntime implements ConnectorRuntimePort {
  private readonly attempts = new Map<string, Attempt>()
  private readonly leases = new Map<string, AbortController>()
  private readonly versions = new Map<string, string>()
  private readonly needsReconnect = new Set<string>()
  private references?: Record<string, Uint8Array>
  constructor(private readonly options: {
    store: DingTalkWorkspaceStore
    legacy: ConnectorRuntimePort
    binary: string
    skillsArchive: string
    currentScope(): TaskOwnerScope | null
    open(url: string): Promise<void>
    runner?: DingTalkRunner
  }) {}
  private current(scope: TaskOwnerScope): boolean { const owner = this.options.currentScope(); return !!owner && key(owner) === key(scope) }
  private runner: DingTalkRunner = options => (this.options.runner ?? runDingTalk)(options)
  async state(scope: TaskOwnerScope): Promise<ConnectorState> {
    const attempt = this.attempts.get(key(scope))
    if (attempt) return attempt.state
    if (this.needsReconnect.has(key(scope))) return { id: 'dingtalk', status: 'error', coverage: 'workspace', error: '钉钉登录已失效，请重新连接。' }
    try {
      const record = await this.options.store.read(scope)
      if (record) return { id: 'dingtalk', status: 'connected', coverage: 'workspace', connectedAt: record.connectedAt }
      const legacy = await this.options.legacy.state(scope)
      return { ...legacy, coverage: 'documents' }
    } catch { return { id: 'dingtalk', status: 'error', error: '无法读取钉钉授权，请检查系统安全存储。' } }
  }
  async connect(scope: TaskOwnerScope): Promise<void> {
    if (!this.current(scope)) throw new Error('DingTalk account changed.')
    if (this.attempts.get(key(scope))?.state.status === 'authorizing') return
    const controller = new AbortController()
    this.needsReconnect.delete(key(scope))
    this.options.legacy.cancel()
    this.leases.get(key(scope))?.abort()
    this.versions.set(key(scope), randomUUID())
    const attempt: Attempt = { controller, done: Promise.resolve(), state: { id: 'dingtalk', status: 'authorizing', coverage: 'workspace' } }
    this.attempts.set(key(scope), attempt)
    const valid = (): boolean => !controller.signal.aborted && this.current(scope) && this.attempts.get(key(scope)) === attempt
    let started = false
    let resolveStart!: () => void
    let rejectStart!: (error: Error) => void
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
    attempt.done = (async () => {
      await this.options.store.clear(scope)
      await this.options.store.run(scope, valid, async (directory, _snapshot, keychainDirectory) => {
        let opened = false
        let opening: Promise<void> | undefined
        const login = await this.runner({ binary: this.options.binary, directory, keychainDirectory, cwd: directory,
          args: ['auth', 'login', '--no-browser', '--format', 'json'], signal: controller.signal, timeoutMs: 300000,
          onOutput: output => {
            if (opened || !valid()) return
            const match = /https:\/\/login\.dingtalk\.com\/oauth2\/auth\?[^\s<>"']+(?=\r?\n)/.exec(output)
            if (!match) return
            const url = new URL(match[0])
            const callback = new URL(url.searchParams.get('redirect_uri') ?? '')
            if (url.origin !== 'https://login.dingtalk.com' || callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/callback') throw new Error('Unexpected DingTalk authorization URL.')
            opened = true
            opening = this.options.open(url.href).then(() => { if (!valid()) throw new Error('DingTalk authorization cancelled.'); started = true; resolveStart() })
            void opening.catch(() => controller.abort())
          },
        })
        await opening
        if (login.isError || !opened || !valid()) throw new Error('DingTalk authorization incomplete.')
        const status = await this.runner({ binary: this.options.binary, directory, keychainDirectory, cwd: directory,
          args: ['auth', 'status', '--format', 'json'], signal: controller.signal })
        const value: unknown = JSON.parse(status.text)
        if (status.isError || !value || typeof value !== 'object' || !('authenticated' in value) || value.authenticated !== true) throw new Error('DingTalk authorization incomplete.')
        const identity = { revision: randomUUID(), connectedAt: Date.now() }
        this.versions.set(key(scope), identity.revision)
        return { result: undefined, identity }
      })
      if (valid()) this.attempts.delete(key(scope))
    })().catch(() => {
      if (!started) rejectStart(new Error('无法启动钉钉登录，请检查网络或重新安装客户端。'))
      if (this.attempts.get(key(scope)) === attempt) attempt.state = { id: 'dingtalk', status: 'error', error: '钉钉授权未完成或已超时，请重新连接。' }
    })
    return start
  }
  async disconnect(scope: TaskOwnerScope): Promise<void> {
    const attempt = this.attempts.get(key(scope))
    this.needsReconnect.delete(key(scope))
    attempt?.controller.abort()
    this.attempts.delete(key(scope))
    this.leases.get(key(scope))?.abort()
    this.leases.delete(key(scope))
    this.versions.set(key(scope), randomUUID())
    await attempt?.done
    try {
      await this.options.store.run(scope, () => this.current(scope), async (directory, _snapshot, keychainDirectory) => {
        const reset = await this.runner({ binary: this.options.binary, directory, keychainDirectory, cwd: directory,
          args: ['auth', 'reset', '--yes', '--format', 'json'], signal: AbortSignal.timeout(20000) })
        if (reset.isError) throw new Error('无法清除钉钉系统凭据，请重新连接后再次断开。')
        return { result: undefined }
      })
    } finally {
      await this.options.store.clear(scope)
      await this.options.legacy.disconnect(scope)
    }
  }
  cancel(): void {
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    for (const lease of this.leases.values()) lease.abort()
    this.attempts.clear(); this.leases.clear(); this.versions.clear()
    this.options.legacy.cancel()
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    if (!this.current(scope) || this.attempts.has(key(scope)) || this.needsReconnect.has(key(scope))) return undefined
    let record
    try { record = await this.options.store.read(scope) } catch { return undefined }
    if (!record) return this.options.legacy.binding(scope)
    if (!this.versions.has(key(scope))) this.versions.set(key(scope), record.revision)
    if (this.versions.get(key(scope)) !== record.revision) return undefined
    let lease = this.leases.get(key(scope))
    if (!lease) { lease = new AbortController(); this.leases.set(key(scope), lease) }
    const signal = lease.signal
    const valid = (): boolean => !signal.aborted && this.current(scope) && this.versions.get(key(scope)) === record.revision
    const invoke = async (args: string[], cwd?: string, source?: AbortSignal): Promise<ConnectorCommandResult> => {
      const combined = source ? AbortSignal.any([signal, source]) : signal
      try {
        const result = await this.options.store.run(scope, () => valid() && !combined.aborted, async (directory, snapshot, keychainDirectory) => {
          if (snapshot?.revision !== record.revision) throw new Error('DingTalk credential snapshot changed.')
          return { result: await this.runner({ binary: this.options.binary, directory, keychainDirectory, cwd: cwd ?? directory, args, signal: combined }) }
        })
        const scheduledReason = result.isError && !result.executionUncertain ? dingTalkFailureReason(result.text) : undefined
        if (scheduledReason === 'authentication-required' && valid()) {
          this.needsReconnect.add(key(scope)); this.versions.set(key(scope), randomUUID()); this.leases.get(key(scope))?.abort()
        }
        return scheduledReason ? { ...result, scheduledReason } : result
      } catch { return { text: '钉钉调用未完成，请检查连接状态；有副作用的操作请先核实结果。', isError: true, executionUncertain: true } }
    }
    const commands: ConnectorCommandBinding = {
        id: 'dingtalk', name: '钉钉', instructions: {
          reference: 'Read official DingTalk DWS instructions. Start with SKILL.md, then relevant references/*.md. Use dingtalk_execute instead of bash. Do not guess commands or IDs; follow business confirmation rules.',
          schema: 'Read the official compact DWS schema for a product or exact leaf command path, e.g. calendar or calendar event create. This returns command contracts, not business data or account status. The client supplies the bound account; do not call profile or auth commands.',
          execute: 'Execute a DingTalk business command as the connected user. args is argv without dws. Read relevant reference and leaf schema first. Client manages identity, format and yes flags. Execute ordinary work within the connected account without asking again in chat. For a simple message to a unique person or group, call chat +dm --to NAME --content TEXT or chat +send-to-group --group NAME --content TEXT directly. Clarify ambiguous recipients before sending. Never automatically retry uncertain writes. Obtain explicit approval for batch/permanent PAT grants including scope, grant type and expiry. Preserve pagination and partial failures; verify writes with one read.',
        },
        reference: async path => {
          if (!valid()) throw new Error('DingTalk connection changed.')
          if (!/^(?:SKILL\.md|references\/[\w/.-]+\.md)$/.test(path) || path.split('/').some(part => part === '..')) throw new Error('Invalid DingTalk reference.')
          this.references ??= unzipSync(await readFile(this.options.skillsArchive), { filter: entry => entry.name.startsWith('mono/') && entry.name.endsWith('.md') })
          const bytes = this.references[`mono/${path}`]
          if (!bytes || bytes.length > 256000) throw new Error('DingTalk reference unavailable.')
          return strFromU8(bytes)
        },
        schema: async (path, source) => {
          if (!/^[\w+ -]{1,160}$/.test(path) || !DINGTALK_PRODUCTS.has(path.split(' ')[0])) throw new ConnectorInputError('仅支持钉钉业务命令的 Schema，不提供账号或 profile 查询。客户端使用已绑定的账号。')
          return invoke(dingTalkSchemaArgs(path), undefined, source)
        },
        evaluateCommand: evaluateDingTalkCommand,
        isScheduledReadOnly: isScheduledDingTalkReadOnly,
        scheduledOperation: describeScheduledDingTalkOperation,
        execute: (args, workspaceDir, source) => invoke(validateDingTalkArgs(args), workspaceDir, source),
    }
    return { revision: record.revision, servers: [], fetch, commands: [commands] }
  }
}
