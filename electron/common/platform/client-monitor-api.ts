import { z } from 'zod'
import { config } from '../config'
import { AuthenticationRequiredError } from './authentication-required-error'
import {
  createClientTaskSchema, clientTaskStatusSchema, clientTaskHeartbeatSchema, clientTaskEventSchema,
  type CreateClientTaskRequest, type ClientTaskStatusRequest, type ClientTaskHeartbeatRequest, type ClientTaskEventRequest,
} from './client-monitor-contract'
export type { CreateClientTaskRequest, ClientTaskStatusRequest, ClientTaskHeartbeatRequest, ClientTaskEventRequest } from './client-monitor-contract'

export interface ClientTaskMirror { id: string }
export interface ClientMonitorApiPort {
  createTask(request: CreateClientTaskRequest, signal?: AbortSignal): Promise<ClientTaskMirror>
  updateStatus(mirrorId: string, request: ClientTaskStatusRequest, signal?: AbortSignal): Promise<void>
  sendHeartbeat(mirrorId: string, request: ClientTaskHeartbeatRequest, signal?: AbortSignal): Promise<void>
  sendEvent(mirrorId: string, request: ClientTaskEventRequest, signal?: AbortSignal): Promise<void>
}
export class ClientMonitorApiError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly retryAfterMs?: number) { super(message); this.name = 'ClientMonitorApiError' }
  get isUnauthorized(): boolean { return this.statusCode === 401 }
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
      throw new ClientMonitorApiError('SEP monitor request failed.', 0)
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
      const response = await this.fetcher(this.baseUrl + path, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Origin: this.webOrigin, Referer: this.webOrigin + '/' },
        body: JSON.stringify(body), signal,
      })
      if (!response.ok) {
        const reason = response.status === 403 ? await this.forbiddenReason(response) : undefined
        if (response.status !== 403) await response.body?.cancel()
        if (response.status === 401 && attempt === 0) continue
        // Only fixed, known reasons may escape the response boundary.
        throw new ClientMonitorApiError('SEP monitor HTTP ' + response.status + (reason ? ': ' + reason : ''), response.status, this.retryAfter(response.headers.get('Retry-After')))
      }
      if (expectsMirror) return await response.json() as unknown
      await response.body?.cancel()
      return undefined
    }
    throw new ClientMonitorApiError('Authentication required.', 401)
  }
  private async forbiddenReason(response: Response): Promise<string | undefined> {
    const reader = response.body?.getReader()
    if (!reader) return undefined
    try {
      // Bound the untrusted body even when Content-Length is absent or incorrect.
      const parts: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 4096) return undefined
        parts.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
      const parsed = z.object({ message: z.string().max(512) }).safeParse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      if (!parsed.success) return undefined
      const message = parsed.data.message
      for (const reason of ['Missing Origin or Referer header', 'Invalid Origin or Referer header', 'Subscription unavailable', '没有有效的员工使用授权']) {
        if (message === reason) return reason
      }
      if (message === `Origin ${this.webOrigin} not allowed. CSRF protection.`) return 'Origin not allowed. CSRF protection.'
      return undefined
    } catch {
      return undefined
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private scopeKey(): string {
    const scope = this.options.scopeProvider?.()
    return scope ? `${scope.enterpriseId}\0${scope.memberId}` : ''
  }

  private retryAfter(value: string | null): number | undefined {
    if (!value) return undefined
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
      const milliseconds = Number(value) * 1000
      return Number.isFinite(milliseconds) ? milliseconds : undefined
    }
    const date = Date.parse(value)
    return Number.isFinite(date) ? Math.max(0, date - (this.options.now ?? Date.now)()) : undefined
  }

}
