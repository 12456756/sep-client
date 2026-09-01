import { randomUUID } from 'node:crypto'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { ToolApprovalResponse } from '../../src/shared/ipc'

interface PendingApproval {
  request: ToolAuthorizationRequest
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

export interface ApprovalBrokerOptions {
  timeoutMs?: number
  onRequest: (request: ToolAuthorizationRequest) => unknown | Promise<unknown>
  onResolved?: (request: ToolAuthorizationRequest, approved: boolean, reason: string) => unknown | Promise<unknown>
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timeoutMs: number
  private readonly onRequest: ApprovalBrokerOptions['onRequest']
  private readonly onResolved: ApprovalBrokerOptions['onResolved']

  constructor(options: ApprovalBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.onRequest = options.onRequest
    this.onResolved = options.onResolved
  }

  request(input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>): Promise<boolean> {
    const request: ToolAuthorizationRequest = {
      ...input,
      requestId: randomUUID(),
      timestamp: Date.now(),
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.resolve(request.requestId, false, 'timeout')
      }, this.timeoutMs)
      this.pending.set(request.requestId, { request, resolve, timer })
      void Promise.resolve(this.onRequest(request)).catch(() => {
        this.resolve(request.requestId, false, 'request_delivery_failed')
      })
    })
  }

  respond(response: ToolApprovalResponse): boolean {
    let requestId = response.requestId
    if (!requestId && this.pending.size === 1) requestId = this.pending.keys().next().value
    if (!requestId) return false
    return this.resolve(requestId, response.approved, response.reason ?? 'user_response')
  }

  denyRun(runId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.runId === runId) this.resolve(requestId, false, 'run_cancelled')
    }
  }

  denyAll(): void {
    for (const requestId of this.pending.keys()) this.resolve(requestId, false, 'shutdown')
  }

  get size(): number {
    return this.pending.size
  }

  private resolve(requestId: string | undefined, approved: boolean, reason: string): boolean {
    if (!requestId) return false
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(approved)
    void Promise.resolve(this.onResolved?.(pending.request, approved, reason)).catch(() => undefined)
    return true
  }
}
