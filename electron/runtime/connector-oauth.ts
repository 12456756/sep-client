import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthClientInformationSchema, OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { ConnectorState } from '../../src/shared/connectors'
import type { ConnectorStore } from '../data/connector-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorBinding, ConnectorRuntimePort } from '../domain/connectors'
import { WriteChain } from '../data/write-chain'
import { connectorOAuthSuccessPage, connectorOAuthSuccessPolicy } from './connector-oauth-page'

const ENDPOINT = 'https://mcp-gw.dingtalk.com/oauth/server/doc'
const TOOLS = ['search_documents', 'get_document_info', 'get_document_content']
const recordSchema = z.object({
  revision: z.string(), connectedAt: z.number(), redirectUrl: z.string(),
  client: OAuthClientInformationSchema, tokens: OAuthTokensSchema, expiresAt: z.number().optional(),
})
type RecordData = z.infer<typeof recordSchema>
interface Attempt { cancel(): void; state: ConnectorState }
class ReconnectRequired extends Error {}
const key = (scope: TaskOwnerScope): string => JSON.stringify([scope.enterpriseId, scope.memberId])
function scopedFetch(request: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => {
    signal.throwIfAborted()
    const source = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    return request(input, { ...init, signal: source ? AbortSignal.any([signal, source]) : signal })
  }
}

/** OAuth HTTP is restricted to the two advertised DingTalk origins; redirects never carry credentials. */
export const dingtalkFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.username || url.password || url.hash || !['https://mcp-gw.dingtalk.com', 'https://mcp-gw2.dingtalk.com'].includes(url.origin)) throw new Error('Unexpected DingTalk authorization origin.')
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  return fetch(input, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) })
}

export class ConnectorOAuthRuntime implements ConnectorRuntimePort {
  private readonly attempts = new Map<string, Attempt>()
  private readonly writes = new WriteChain()
  private readonly refreshes = new WriteChain()
  private readonly revisions = new Map<string, string>()
  private readonly leases = new Map<string, AbortController>()
  private readonly starting = new Map<string, Promise<void>>()
  private epoch = 0
  constructor(private readonly options: { store: ConnectorStore; currentScope(): TaskOwnerScope | null; open(url: string): Promise<void>; fetch?: typeof fetch }) {}
  private readonly request: typeof fetch = (input, init) => (this.options.fetch ?? dingtalkFetch)(input, init)
  private current(scope: TaskOwnerScope): boolean { const owner = this.options.currentScope(); return !!owner && key(owner) === key(scope) }
  private invalidate(scope: TaskOwnerScope): void {
    this.revisions.set(key(scope), randomUUID())
    this.leases.get(key(scope))?.abort()
    this.leases.delete(key(scope))
  }
  async state(scope: TaskOwnerScope): Promise<ConnectorState> {
    const attempt = this.attempts.get(key(scope))
    if (attempt) return attempt.state
    try {
      const record = await this.read(scope)
      return record ? { id: 'dingtalk', status: 'connected', connectedAt: record.connectedAt } : { id: 'dingtalk', status: 'disconnected' }
    } catch { return { id: 'dingtalk', status: 'error', error: '无法读取本机授权，请检查系统安全存储。' } }
  }
  private async read(scope: TaskOwnerScope): Promise<RecordData | undefined> {
    const raw = await this.options.store.read(scope)
    if (raw == null) return undefined
    const record = recordSchema.parse(raw)
    if (!this.revisions.has(key(scope))) this.revisions.set(key(scope), record.revision)
    return record
  }
  private async save(scope: TaskOwnerScope, record: RecordData, signal: AbortSignal): Promise<void> {
    await this.writes.run(key(scope), async () => {
      const valid = (): boolean => !signal.aborted && this.current(scope) && this.revisions.get(key(scope)) === record.revision
      if (!valid()) throw new Error('Connector authorization changed.')
      await this.options.store.write(scope, record)
      if (!valid()) { await this.options.store.write(scope, null); throw new Error('Connector authorization changed.') }
    })
  }
  async connect(scope: TaskOwnerScope): Promise<void> {
    const pending = this.starting.get(key(scope))
    if (pending) return pending
    const operation = this.startConnect(scope)
    this.starting.set(key(scope), operation)
    try { await operation } finally { if (this.starting.get(key(scope)) === operation) this.starting.delete(key(scope)) }
  }
  private async startConnect(scope: TaskOwnerScope): Promise<void> {
    const epoch = this.epoch
    const valid = (): boolean => epoch === this.epoch && this.current(scope)
    if (!this.current(scope)) throw new Error('Connector account changed.')
    if (this.attempts.get(key(scope))?.state.status === 'authorizing') return
    await this.options.store.read(scope)
    if (!valid()) throw new Error('Connector account changed.')
    this.attempts.get(key(scope))?.cancel()
    this.invalidate(scope)
    await this.writes.run(key(scope), () => this.options.store.write(scope, null))
    if (!valid()) throw new Error('Connector account changed.')
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    if (!valid()) { server.close(); throw new Error('Connector account changed.') }
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('Cannot start callback.') }
    const redirectUrl = `http://127.0.0.1:${address.port}/callback`
    const state = randomBytes(32).toString('hex')
    const revision = randomUUID()
    this.revisions.set(key(scope), revision)
    const controller = new AbortController()
    const request = scopedFetch(this.request, controller.signal)
    let verifier = ''
    let client: OAuthClientInformationMixed | undefined
    let tokens: OAuthTokens | undefined
    let received = false
    let authorizationUrl: URL | undefined
    const cleanup = (): void => { clearTimeout(timer); controller.abort(); server.close(); server.closeAllConnections(); verifier = '' }
    const attempt: Attempt = { state: { id: 'dingtalk', status: 'authorizing' }, cancel: () => {
      cleanup()
      if (this.attempts.get(key(scope)) === attempt) { this.invalidate(scope); this.attempts.delete(key(scope)) }
    } }
    this.attempts.set(key(scope), attempt)
    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata: { client_name: 'CSEP', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post', scope: 'user' },
      state: () => state,
      clientInformation: () => client,
      saveClientInformation: value => { client = value },
      tokens: () => tokens,
      saveTokens: value => { tokens = value },
      saveCodeVerifier: value => { verifier = value }, codeVerifier: () => verifier,
      redirectToAuthorization: value => { authorizationUrl = value },
    }
    server.on('request', (incoming, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      let callback: URL
      try { callback = new URL(incoming.url ?? '/', redirectUrl) }
      catch { response.writeHead(400).end('Invalid authorization callback.'); return }
      if (incoming.method !== 'GET' || incoming.headers.host !== `127.0.0.1:${address.port}` || callback.pathname !== '/callback' || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state || received) {
        response.writeHead(400).end('Invalid authorization callback.'); return
      }
      received = true
      void (async () => {
        try {
          if (!this.current(scope) || callback.searchParams.has('error') || callback.searchParams.getAll('code').length !== 1) throw new Error('Authorization cancelled.')
          const code = callback.searchParams.get('code')
          if (!code) throw new Error('Missing authorization code.')
          const result = await auth(provider, { serverUrl: ENDPOINT, authorizationCode: code, fetchFn: request })
          if (result !== 'AUTHORIZED' || !client || !tokens) throw new Error('Authorization incomplete.')
          const probe = new Client({ name: 'csep-connector-check', version: '1.0.0' }, { capabilities: {} })
          try {
            await probe.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: request, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: 'error' } }), { timeout: 20000 })
            const names = new Set<string>()
            let cursor: string | undefined
            for (let page = 0; page < 100; page++) {
              const discovered = await probe.listTools({ cursor }, { timeout: 20000 })
              for (const tool of discovered.tools) names.add(tool.name)
              cursor = discovered.nextCursor
              if (!cursor || TOOLS.every(name => names.has(name))) break
            }
            if (TOOLS.some(name => !names.has(name))) throw new Error('Required document tools unavailable.')
          } finally { await probe.close().catch(() => undefined) }
          if (controller.signal.aborted) throw new Error('Authorization cancelled.')
          await this.save(scope, { revision, connectedAt: Date.now(), redirectUrl, client, tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined }, controller.signal)
          if (this.attempts.get(key(scope)) === attempt) this.attempts.delete(key(scope))
          response.setHeader('Content-Security-Policy', connectorOAuthSuccessPolicy)
          response.end(connectorOAuthSuccessPage)
          await new Promise<void>(resolve => response.writableFinished ? resolve() : response.once('finish', resolve))
        } catch {
          if (this.attempts.get(key(scope)) === attempt) attempt.state = { id: 'dingtalk', status: 'error', error: '钉钉授权未完成，请重新连接。' }
          response.writeHead(400).end('<h2>授权未完成</h2><p>请返回 CSEP 客户端重新连接。</p>')
        } finally { cleanup() }
      })()
    })
    const timer = setTimeout(() => { if (this.attempts.get(key(scope)) === attempt) { this.invalidate(scope); attempt.state = { id: 'dingtalk', status: 'error', error: '授权已超时，请重新连接。' } }; cleanup() }, 5 * 60 * 1000)
    timer.unref()
    try {
      await auth(provider, { serverUrl: ENDPOINT, fetchFn: request })
      if (!authorizationUrl || !this.current(scope) || this.attempts.get(key(scope)) !== attempt) throw new Error('Authorization cancelled.')
      if (authorizationUrl.origin !== 'https://mcp-gw2.dingtalk.com') throw new Error('Unexpected authorization page.')
      await this.options.open(authorizationUrl.href)
    } catch { attempt.cancel(); throw new Error('Cannot start DingTalk authorization.') }
  }
  async disconnect(scope: TaskOwnerScope): Promise<void> {
    this.epoch++
    this.attempts.get(key(scope))?.cancel()
    this.invalidate(scope)
    await this.writes.run(key(scope), () => this.options.store.write(scope, null))
  }
  cancel(): void {
    this.epoch++
    for (const attempt of this.attempts.values()) attempt.cancel()
    this.attempts.clear()
    for (const lease of this.leases.values()) lease.abort()
    this.leases.clear()
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    let record: RecordData | undefined
    try { record = await this.read(scope) } catch { return undefined }
    if (!record || !this.current(scope) || this.revisions.get(key(scope)) !== record.revision || this.attempts.has(key(scope))) return undefined
    let lease = this.leases.get(key(scope))
    if (!lease) { lease = new AbortController(); this.leases.set(key(scope), lease) }
    const controller = lease
    const request = scopedFetch(this.request, controller.signal)
    return {
      revision: record.revision,
      servers: [{ name: 'dingtalk', transport: { type: 'streamable-http', url: ENDPOINT }, enabledTools: [...TOOLS] }],
      fetch: async (input, init) => {
        if (controller.signal.aborted || !this.current(scope) || this.revisions.get(key(scope)) !== record.revision) throw new Error('DingTalk connection no longer available.')
        const token = await this.refreshes.run(key(scope), async () => {
          const latest = await this.read(scope)
          if (!latest || latest.revision !== record.revision) throw new Error('DingTalk connection no longer available.')
          if (latest.expiresAt && latest.expiresAt < Date.now() + 60000) {
            const provider: OAuthClientProvider = {
              redirectUrl: latest.redirectUrl,
              clientMetadata: { redirect_uris: [latest.redirectUrl], token_endpoint_auth_method: 'client_secret_post' },
              clientInformation: () => latest.client,
              tokens: () => latest.tokens,
              saveTokens: async value => { latest.tokens = { ...value, refresh_token: value.refresh_token ?? latest.tokens.refresh_token }; latest.expiresAt = value.expires_in ? Date.now() + value.expires_in * 1000 : undefined; await this.save(scope, latest, controller.signal) },
              codeVerifier: () => { throw new Error('Interactive authorization required.') }, saveCodeVerifier: () => {},
              redirectToAuthorization: () => { throw new ReconnectRequired('Please reconnect DingTalk.') },
              invalidateCredentials: () => { throw new ReconnectRequired('Please reconnect DingTalk.') },
            }
            try { await auth(provider, { serverUrl: ENDPOINT, fetchFn: request }) }
            catch (error) {
              if (error instanceof ReconnectRequired && !controller.signal.aborted && this.current(scope) && this.revisions.get(key(scope)) === record.revision) {
                this.attempts.set(key(scope), { state: { id: 'dingtalk', status: 'error', error: '钉钉授权已失效，请重新连接。' }, cancel() {} })
              }
              throw new Error('钉钉令牌刷新未完成，请检查网络或重新连接。')
            }
          }
          return latest.tokens.access_token
        })
        if (controller.signal.aborted || !this.current(scope) || this.revisions.get(key(scope)) !== record.revision) throw new Error('DingTalk connection no longer available.')
        const target = new URL(input instanceof Request ? input.url : String(input))
        if (target.href !== ENDPOINT) throw new Error('Unexpected document endpoint.')
        const headers = new Headers(input instanceof Request ? input.headers : undefined)
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
        headers.set('Authorization', `Bearer ${token}`)
        const response = await request(input, { ...init, headers, redirect: 'error' })
        if (controller.signal.aborted || !this.current(scope) || this.revisions.get(key(scope)) !== record.revision) throw new Error('DingTalk connection no longer available.')
        if (response.status === 401) { this.attempts.set(key(scope), { state: { id: 'dingtalk', status: 'error', error: '钉钉授权已失效，请重新连接。' }, cancel() {} }); throw new Error('Please reconnect DingTalk.') }
        return response
      },
    }
  }
}
