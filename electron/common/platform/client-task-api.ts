import type { AuthSessionManager } from './auth-session-manager'
import { config } from '../config'
import { AuthApiError } from './platform-api'

export interface ClientTaskCreatePayload {
  clientTaskId: string
  clientRunId?: string | null
  subscriptionId?: string | null
  title: string
  status: string
  createdAt: string
}

export interface ClientTaskEventPayload {
  sequence: number
  type: string
  occurredAt: string
  data?: Record<string, unknown>
}

async function request<T>(method: string, path: string, body: unknown, token: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${config.SEP_BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new AuthApiError({ statusCode: 0, message: error instanceof Error ? error.message : 'Network error' }, 'tasks')
  }
  if (!response.ok) {
    let details: { message?: unknown; requestId?: unknown } = {}
    try { details = await response.json() as typeof details } catch { /* empty response */ }
    throw new AuthApiError({
      statusCode: response.status,
      message: typeof details.message === 'string' ? details.message : response.statusText,
      requestId: typeof details.requestId === 'string' ? details.requestId : undefined,
    }, 'tasks')
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

async function withAuth<T>(auth: AuthSessionManager, operation: (token: string) => Promise<T>): Promise<T> {
  const token = await auth.getValidAccessToken()
  try {
    return await operation(token)
  } catch (error) {
    if (!(error instanceof AuthApiError) || !error.isUnauthorized) throw error
    auth.invalidateAccessToken()
    return operation(await auth.getValidAccessToken())
  }
}

export class ClientTaskApi {
  constructor(private readonly auth: AuthSessionManager) {}

  create(payload: ClientTaskCreatePayload): Promise<{ id: string }> {
    return withAuth(this.auth, token => request<{ id: string }>('POST', '/client/tasks', payload, token))
  }

  updateStatus(remoteTaskId: string, status: string): Promise<unknown> {
    return withAuth(this.auth, token => request('PATCH', `/client/tasks/${encodeURIComponent(remoteTaskId)}/status`, { status }, token))
  }

  heartbeat(remoteTaskId: string): Promise<unknown> {
    return withAuth(this.auth, token => request('POST', `/client/tasks/${encodeURIComponent(remoteTaskId)}/heartbeat`, {}, token))
  }

  appendEvent(remoteTaskId: string, payload: ClientTaskEventPayload): Promise<unknown> {
    return withAuth(this.auth, token => request('POST', `/client/tasks/${encodeURIComponent(remoteTaskId)}/events`, payload, token))
  }
}
