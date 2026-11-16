import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ConnectorState } from '../../src/shared/connectors'
import type { ConnectorStore } from '../data/connector-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { WriteChain } from '../data/write-chain'
import type { ConnectorBinding, ConnectorCommandBinding, ConnectorCommandResult, ConnectorRuntimePort } from '../domain/connectors'
import { TencentMeetingApi, MeetingApiError, meetingIdentitySchema, meetingPublicResult } from './tencent-meeting-api'
import { meetingRequest, meetingSchema } from './tencent-meeting-command'
import { ConnectorSuccessPage } from './connector-success-page'

const recordSchema = z.object({ revision: z.string(), connectedAt: z.number(), identity: meetingIdentitySchema })
const key = (scope: TaskOwnerScope): string => JSON.stringify([scope.enterpriseId, scope.memberId])
interface Attempt { controller: AbortController; done: Promise<void>; state: ConnectorState }
const reference = `Tencent Meeting connector (CSEP adapter of TencentCloud/tencentmeeting-cli 1.1.0).
Read tmeet_schema with path tmeet to list supported methods, then inspect the exact service.method.
Execute args: ["service", "method", "--json", "{...}"]. This is a bounded adapter, not the full native CLI.
Uses the connected user's OAuth identity. identity.whoami verifies that identity; never supply user IDs or tokens.
meeting: list/get/search/create/update/cancel. Ordinary scheduled meetings only; recurring meetings are not supported.
Before updating or cancelling, get the meeting and verify it is an ordinary meeting. Do not modify recurring meetings.
record: search/minutes/transcript. Recordings and smart minutes must already exist and be accessible to the account.
Times require ISO 8601 seconds with an explicit timezone, e.g. 2026-12-01T09:00:00+08:00. Confirm ambiguous dates with the user.
Keep page_token/pid and follow pagination explicitly; search results are not necessarily complete.
Every execution uses the client's approval policy. Confirm concrete writes and verify their result with a read.
Never retry an executionUncertain write automatically: inspect the meeting list/details first.
Permissions, account edition, recording availability and enterprise policy determine actual access.
Disconnect removes local credentials; remote authorization can be managed in Tencent Meeting.`

export class TencentMeetingWorkspaceRuntime implements ConnectorRuntimePort {
  private readonly attempts = new Map<string, Attempt>()
  private readonly leases = new Map<string, AbortController>()
  private readonly versions = new Map<string, string>()
  private readonly pages = new Map<string, ConnectorSuccessPage>()
  private readonly writes = new WriteChain()
  private readonly api: Pick<TencentMeetingApi, 'login' | 'refresh' | 'execute'>
  constructor(private readonly options: {
    store: ConnectorStore
    currentScope(): TaskOwnerScope | null
    open(url: string): Promise<void>
    api?: Pick<TencentMeetingApi, 'login' | 'refresh' | 'execute'>
  }) { this.api = options.api ?? new TencentMeetingApi() }
  private current(scope: TaskOwnerScope): boolean {
    const owner = this.options.currentScope()
    return !!owner && key(owner) === key(scope)
  }
  private async read(scope: TaskOwnerScope): Promise<z.infer<typeof recordSchema> | undefined> {
    const value = await this.options.store.read(scope)
    return value == null ? undefined : recordSchema.parse(value)
  }
  async state(scope: TaskOwnerScope): Promise<ConnectorState> {
    if (!this.current(scope)) return { id: 'tmeet', status: 'disconnected' }
    const attempt = this.attempts.get(key(scope))
    if (attempt) return attempt.state
    try {
      const record = await this.read(scope)
      if (!this.current(scope) || !record) return { id: 'tmeet', status: 'disconnected' }
      if (this.versions.has(key(scope)) && this.versions.get(key(scope)) !== record.revision || Math.max(record.identity.expiresAt, record.identity.refreshExpiresAt) <= Date.now()) {
        return { id: 'tmeet', status: 'error', error: '腾讯会议授权已失效，请重新连接。' }
      }
      return { id: 'tmeet', status: 'connected', coverage: 'meetings', connectedAt: record.connectedAt }
    } catch { return { id: 'tmeet', status: 'error', error: '无法读取腾讯会议授权，请检查系统安全存储。' } }
  }
  private invalidate(scope: TaskOwnerScope): void {
    this.leases.get(key(scope))?.abort(); this.leases.delete(key(scope))
    this.pages.get(key(scope))?.close(); this.pages.delete(key(scope))
    this.versions.set(key(scope), randomUUID())
  }
  async connect(scope: TaskOwnerScope): Promise<void> {
    if (!this.current(scope)) throw new Error('Connector account changed.')
    if (this.attempts.get(key(scope))?.state.status === 'authorizing') return
    this.attempts.get(key(scope))?.controller.abort()
    this.invalidate(scope)
    const attempt: Attempt = { controller: new AbortController(), done: Promise.resolve(), state: { id: 'tmeet', status: 'authorizing', phase: 'authorization' } }
    this.attempts.set(key(scope), attempt)
    const valid = (): boolean => !attempt.controller.signal.aborted && this.current(scope) && this.attempts.get(key(scope)) === attempt
    let started = false
    let resolveStart!: () => void
    let rejectStart!: (error: Error) => void
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
    attempt.done = this.writes.run(key(scope), async () => {
      if (!valid()) throw new Error('Connector authorization cancelled.')
      await this.options.store.write(scope, null)
      if (!valid()) throw new Error('Connector authorization cancelled.')
      const identity = await this.api.login(randomBytes(24).toString('hex'), async url => {
        if (!valid()) throw new Error('Connector authorization cancelled.')
        await this.options.open(url)
        if (!valid()) throw new Error('Connector authorization cancelled.')
        started = true; resolveStart()
      }, attempt.controller.signal)
      if (!valid()) throw new Error('Connector authorization cancelled.')
      const revision = randomUUID()
      await this.options.store.write(scope, { revision, connectedAt: Date.now(), identity })
      if (!valid()) { await this.options.store.write(scope, null); return }
      this.versions.set(key(scope), revision)
      this.attempts.delete(key(scope))
      // A browser failure must not roll back an authorization already saved securely.
      try {
        const active = (): boolean => !attempt.controller.signal.aborted && this.current(scope) && this.versions.get(key(scope)) === revision
        const page = await ConnectorSuccessPage.start(active)
        if (!active()) { page.close(); return }
        this.pages.set(key(scope), page)
        await this.options.open(page.url)
      } catch { this.pages.get(key(scope))?.close(); this.pages.delete(key(scope)) }
    }).catch(() => {
      if (!started) rejectStart(new Error('无法启动腾讯会议授权，请重试。'))
      if (valid()) attempt.state = { id: 'tmeet', status: 'error', error: '腾讯会议授权未完成，请在浏览器确认授权后重试。' }
    })
    return start
  }
  async disconnect(scope: TaskOwnerScope): Promise<void> {
    const attempt = this.attempts.get(key(scope))
    attempt?.controller.abort(); this.attempts.delete(key(scope)); this.invalidate(scope)
    await attempt?.done
    await this.writes.run(key(scope), () => this.options.store.write(scope, null))
  }
  cancel(): void {
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    for (const lease of this.leases.values()) lease.abort()
    for (const page of this.pages.values()) page.close()
    this.attempts.clear(); this.leases.clear(); this.versions.clear(); this.pages.clear()
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    if ((await this.state(scope)).status !== 'connected') return undefined
    const record = await this.read(scope)
    if (!record || !this.current(scope) || this.attempts.has(key(scope))) return undefined
    if (!this.versions.has(key(scope))) this.versions.set(key(scope), record.revision)
    if (this.versions.get(key(scope)) !== record.revision) return undefined
    let lease = this.leases.get(key(scope))
    if (!lease) { lease = new AbortController(); this.leases.set(key(scope), lease) }
    const signal = lease.signal
    const valid = (): boolean => !signal.aborted && this.current(scope) && this.versions.get(key(scope)) === record.revision
    const command: ConnectorCommandBinding = {
      id: 'tmeet', name: '腾讯会议', instructions: {
        reference: 'Read the Tencent Meeting adapter guide at tmeet/SKILL.md before invoking meeting or recording tools.',
        schema: 'Inspect the supported CSEP Tencent Meeting adapter contract; path is tmeet, meeting, record, identity or service.method. This is not the full native CLI.',
        execute: 'Execute a supported Tencent Meeting command as the connected user. args is [service, method, --json, JSON object]. Read reference and schema first. All executions require approval. Never override identity. Verify concrete writes, preserve pagination and never retry uncertain writes. Only ordinary scheduled meetings are supported.',
      },
      reference: async path => {
        if (path !== 'tmeet/SKILL.md') throw new Error('Invalid Tencent Meeting reference.')
        return reference
      },
      schema: async path => ({ text: meetingSchema(path), isError: false }),
      execute: async (args, _workspace, source): Promise<ConnectorCommandResult> => {
        const request = meetingRequest(args, record.identity.openId)
        const combined = source ? AbortSignal.any([signal, source]) : signal
        const mutating = args[0] === 'meeting' && ['create', 'update', 'cancel'].includes(args[1])
        let launched = false
        try {
          const identity = await this.writes.run(key(scope), async () => {
            if (!valid() || combined.aborted) throw new Error('Connector account changed.')
            const fresh = await this.read(scope)
            if (!fresh || fresh.revision !== record.revision) throw new Error('Connector account changed.')
            if (fresh.identity.expiresAt <= Date.now() + 60000) {
              if (fresh.identity.refreshExpiresAt <= Date.now()) { this.invalidate(scope); throw new Error('Reconnect required.') }
              try {
                const identity = await this.api.refresh(fresh.identity, signal)
                if (!valid()) throw new Error('Connector account changed.')
                await this.options.store.write(scope, { ...fresh, identity })
                if (!valid()) { await this.options.store.write(scope, null); throw new Error('Connector account changed.') }
                return identity
              } catch { this.invalidate(scope); throw new Error('Reconnect required.') }
            }
            return fresh.identity
          })
          if (!valid() || combined.aborted) throw new Error('Connector account changed.')
          if (args[0] === 'meeting' && ['update', 'cancel'].includes(args[1])) {
            const meetingId = request.path.split('/')[3]
            const details = await this.api.execute(identity, meetingRequest(['meeting', 'get', '--json', JSON.stringify({ meeting_id: meetingId })], identity.openId), combined)
            const ordinary = z.object({ meeting_info_list: z.array(z.object({ meeting_id: z.string(), meeting_type: z.literal(0) })).length(1) }).safeParse(details)
            if (!ordinary.success || ordinary.data.meeting_info_list[0].meeting_id !== meetingId) return { text: '未确认是普通预约会议，本次修改未执行；暂不支持修改或取消周期会议。', isError: true }
            if (!valid() || combined.aborted) throw new Error('Connector account changed.')
          }
          launched = true
          const result = await this.api.execute(identity, request, combined)
          if (!valid() || combined.aborted) throw new Error('Connector account changed.')
          return { text: meetingPublicResult(result, identity), isError: false }
        } catch (error) {
          if (error instanceof MeetingApiError && error.code === 200190303 && valid()) this.invalidate(scope)
          const uncertain = launched && mutating && (!(error instanceof MeetingApiError) || error.status === 408 || error.status >= 500)
          return { text: error instanceof MeetingApiError ? error.message : '腾讯会议调用未完成，请检查连接状态；修改操作请先查询结果。', isError: true, ...(uncertain ? { executionUncertain: true } : {}) }
        }
      },
    }
    return { revision: record.revision, servers: [], fetch, commands: [command] }
  }
}
