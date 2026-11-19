import { z } from 'zod'
import { config } from '../config'
import { AuthenticationRequiredError } from './authentication-required-error'
import { AuthApiError } from './platform-api'
import { parseRetryAfter, readApiDiagnostic, safeApiDiagnostic, transportApiDiagnostic } from './api-diagnostic'
import type { ApiDiagnostic } from '../../../src/shared/api-diagnostic'
import {
  createClientTaskSchema, clientTaskStatusSchema, clientTaskHeartbeatSchema, clientTaskEventSchema,
  type CreateClientTaskRequest, type ClientTaskStatusRequest, type ClientTaskHeartbeatRequest, type ClientTaskEventRequest,
} from './client-monitor-contract'
export type { CreateClientTaskRequest, ClientTaskStatusRequest, ClientTaskHeartbeatRequest, ClientTaskEventRequest } from './client-monitor-contract'

export interface ClientTaskMirror { id: string }
export interface ClientTaskMirrorDetail {
  id: string
  clientTaskId: string
  events: ClientTaskEventRequest[]
}
export interface ClientMonitorApiPort {
  getDetail?(mirrorId: string, signal?: AbortSignal): Promise<ClientTaskMirrorDetail>
  createTask(request: CreateClientTaskRequest, signal?: AbortSignal): Promise<ClientTaskMirror>
  updateStatus(mirrorId: string, request: ClientTaskStatusRequest, signal?: AbortSignal): Promise<void>
  sendHeartbeat(mirrorId: string, request: ClientTaskHeartbeatRequest, signal?: AbortSignal): Promise<void>
  sendEvent(mirrorId: string, request: ClientTaskEventRequest, signal?: AbortSignal): Promise<void>
}
export class ClientMonitorApiError extends Error {
  readonly diagnostic: ApiDiagnostic | undefined
  constructor(message: string, public readonly statusCode: number, public readonly retryAfterMs?: number, diagnostic?: ApiDiagnostic) {
    super(message); this.name = 'ClientMonitorApiError'; this.diagnostic = safeApiDiagnostic(diagnostic)
  }
  get isUnauthorized(): boolean { return this.statusCode === 401 && this.diagnostic?.source !== 'upstream' }
  get isRetryable(): boolean { return this.statusCode === 0 || this.statusCode === 408 || this.statusCode === 429 || this.statusCode >= 500 }
}
export interface ClientMonitorApiOptions {
  scopeProvider?: () => { enterpriseId: string; memberId: string } | null
  now?: () => number
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  fetch?: typeof fetch
  baseUrl?: string
  webOrigin?: string
  requestTimeoutMs?: number
}
const mirrorSchema = z.object({ id: z.string().min(1).max(256) })
const responseSchema = z.union([mirrorSchema, z.object({ data: mirrorSchema })])
const detailSchema = z.object({
  id: z.string().min(1), clientTaskId: z.string().min(1),
  events: z.array(z.object({
    clientRunId: z.string().min(1), sequence: z.number().int().positive().max(2147483647),
    type: z.string().min(1).max(64), message: z.string().max(1000).nullable(),
    stepKey: z.string().max(1000).nullable(), occurredAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(), participationMetadata: z.unknown().optional(),
  }).transform(event => clientTaskEventSchema.parse({
    clientRunId: event.clientRunId, sequence: event.sequence, type: event.type,
    message: event.message, stepKey: event.stepKey, occurredAt: event.occurredAt ?? event.createdAt,
    ...(event.participationMetadata != null ? { participation: event.participationMetadata } : {}),
  }))),
})

export class ClientMonitorApi implements ClientMonitorApiPort {
  private readonly fetcher: typeof fetch
  private readonly baseUrl: string
  private readonly webOrigin: string
  constructor(private readonly options: ClientMonitorApiOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.baseUrl = (options.baseUrl ?? config.SEP_BASE_URL).replace(/\/+$/, '')
    this.webOrigin = new URL(options.webOrigin ?? config.SEP_WEB_ORIGIN).origin
  }
  async createTask(request: CreateClientTaskRequest, signal?: AbortSignal): Promise<ClientTaskMirror> {
    const value = await this.request('/client/tasks', 'POST', createClientTaskSchema.parse(request), true, signal)
    const parsed = responseSchema.safeParse(value)
    if (!parsed.success) throw new ClientMonitorApiError('Invalid SEP monitor response.', 502)
    return 'data' in parsed.data ? parsed.data.data : parsed.data
  }
  async updateStatus(id: string, request: ClientTaskStatusRequest, signal?: AbortSignal): Promise<void> {
    await this.request(this.path(id, 'status'), 'PATCH', clientTaskStatusSchema.parse(request), false, signal)
  }
  async sendHeartbeat(id: string, request: ClientTaskHeartbeatRequest, signal?: AbortSignal): Promise<void> {
    await this.request(this.path(id, 'heartbeat'), 'POST', clientTaskHeartbeatSchema.parse(request), false, signal)
  }
  async sendEvent(id: string, request: ClientTaskEventRequest, signal?: AbortSignal): Promise<void> {
    await this.request(this.path(id, 'events'), 'POST', clientTaskEventSchema.parse(request), false, signal)
  }
  async getDetail(id: string, signal?: AbortSignal): Promise<ClientTaskMirrorDetail> {
    const value = await this.request('/client/tasks/' + encodeURIComponent(id), 'GET', undefined, true, signal)
    try {
      const parsed = z.union([detailSchema, z.object({ data: detailSchema })]).parse(value)
      const detail = 'data' in parsed ? parsed.data : parsed
      if (detail.id !== id) throw new Error('Mismatched mirror')
      return detail
    } catch { throw new ClientMonitorApiError('Invalid SEP monitor detail.', 502) }
  }
  private path(id: string, suffix: string): string { return '/client/tasks/' + encodeURIComponent(id) + '/' + suffix }

  private async request(path: string, method: string, body: unknown, expectsMirror: boolean, external?: AbortSignal): Promise<unknown> {
    const scope = this.scopeKey()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    external?.addEventListener('abort', abort, { once: true })
    if (external?.aborted) abort()
    const timer = setTimeout(abort, this.options.requestTimeoutMs ?? 15_000)
    const signal = controller.signal
    let onAbort: () => void = () => undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ClientMonitorApiError('SEP monitor request aborted or timed out.', 0))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try {
      return await Promise.race([this.send(path, method, body, expectsMirror, signal, scope), cancelled])
    } catch (error) {
      if (error instanceof ClientMonitorApiError) throw error
      if (error instanceof AuthenticationRequiredError) throw new ClientMonitorApiError('Authentication required.', 401)
      if (error instanceof AuthApiError) throw new ClientMonitorApiError('工作记录同步授权暂不可用，请稍后重试。', error.statusCode, error.error.retryAfterMs, error.error.diagnostic)
      throw new ClientMonitorApiError('SEP monitor request failed.', 0, undefined, transportApiDiagnostic(error, 'client-monitor'))
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', abort)
      signal.removeEventListener('abort', onAbort)
    }
  }
  private async send(path: string, method: string, body: unknown, expectsMirror: boolean, signal: AbortSignal, scope: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted()
      const token = await this.options.getAccessToken(attempt === 1)
      signal.throwIfAborted()
      if (scope !== this.scopeKey()) throw new ClientMonitorApiError('SEP monitor scope changed.', 401)
      let response: Response
      try { response = await this.fetcher(this.baseUrl + path, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Origin: this.webOrigin, Referer: this.webOrigin + '/' },
        ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}), signal,
      }) } catch (error) {
        throw new ClientMonitorApiError('工作记录同步网络连接失败，请稍后重试。', 0, undefined, transportApiDiagnostic(error, 'client-monitor', [token]))
      }
      if (!response.ok) {
        const diagnostic = await readApiDiagnostic(response, 'client-monitor', { maxBytes: 64 * 1024, signal, secrets: [token] })
        signal.throwIfAborted()
        if (response.status === 401 && diagnostic.source !== 'upstream' && attempt === 0) continue
        throw new ClientMonitorApiError(this.errorMessage(diagnostic), response.status,
          parseRetryAfter(response.headers.get('Retry-After'), (this.options.now ?? Date.now)()), diagnostic)
      }
      if (expectsMirror) return await response.json() as unknown
      void response.body?.cancel().catch(() => undefined)
      return undefined
    }
    throw new ClientMonitorApiError('Authentication required.', 401)
  }
  private errorMessage(diagnostic: ApiDiagnostic): string {
    if (diagnostic.source === 'upstream') return '工作记录同步依赖的上游服务暂不可用，请联系平台管理员。'
    if (diagnostic.truncated || diagnostic.readError) return '工作记录同步失败，请联系平台管理员。'
    const body = diagnostic.body
    const top = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const nested = top.error && typeof top.error === 'object' && !Array.isArray(top.error) ? top.error : top
    const message = typeof body === 'string' ? body : nested.message ?? (typeof top.error === 'string' ? top.error : top.message)
    if (message === 'Stale client run') return '工作运行记录已更新，当前同步对应旧的运行记录。'
    if (message === 'Subscription unavailable' || message === '没有有效的员工使用授权') return '员工使用授权不可用，请联系企业管理员。'
    if (message === 'Missing Origin or Referer header' || message === 'Invalid Origin or Referer header'
      || message === 'Origin [redacted-url] not allowed. CSRF protection.') return '平台拒绝了工作记录同步来源，请联系平台管理员。'
    return '工作记录同步失败，请联系平台管理员。'
  }

  private scopeKey(): string {
    const scope = this.options.scopeProvider?.()
    return scope ? `${scope.enterpriseId}\0${scope.memberId}` : ''
  }

}
