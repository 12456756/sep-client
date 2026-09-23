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
  constructor(message: string, public readonly statusCode: number) { super(message); this.name = 'ClientMonitorApiError' }
  get isUnauthorized(): boolean { return this.statusCode === 401 }
  get isRetryable(): boolean { return this.statusCode === 0 || this.statusCode === 408 || this.statusCode === 429 || this.statusCode >= 500 }
}
export interface ClientMonitorApiOptions {
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  fetch?: typeof fetch
  baseUrl?: string
  requestTimeoutMs?: number
}
const mirrorSchema = z.object({ id: z.string().min(1).max(256) })
const responseSchema = z.union([mirrorSchema, z.object({ data: mirrorSchema })])

export class ClientMonitorApi implements ClientMonitorApiPort {
  private readonly fetcher: typeof fetch
  private readonly baseUrl: string
  constructor(private readonly options: ClientMonitorApiOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.baseUrl = (options.baseUrl ?? config.SEP_BASE_URL).replace(/\/+$/, '')
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
      return await Promise.race([this.send(path, method, body, expectsMirror, signal), cancelled])
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
  private async send(path: string, method: string, body: unknown, expectsMirror: boolean, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted()
      const token = await this.options.getAccessToken(attempt === 1)
      signal.throwIfAborted()
      const response = await this.fetcher(this.baseUrl + path, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401 && attempt === 0) continue
        // Do not log or persist arbitrary remote response bodies.
        throw new ClientMonitorApiError('SEP monitor HTTP ' + response.status, response.status)
      }
      if (expectsMirror) return await response.json() as unknown
      await response.body?.cancel()
      return undefined
    }
    throw new ClientMonitorApiError('Authentication required.', 401)
  }
}
