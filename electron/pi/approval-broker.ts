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
  onRequest: (request: ToolAuthorizationRequest) => void
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timeoutMs: number
  private readonly onRequest: (request: ToolAuthorizationRequest) => void

  constructor(options: ApprovalBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.onRequest = options.onRequest
  }

  request(input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>): Promise<boolean> {
    const request: ToolAuthorizationRequest = {
      ...input,
      requestId: randomUUID(),
      timestamp: Date.now(),
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.resolve(request.requestId, false)
      }, this.timeoutMs)
      this.pending.set(request.requestId, { request, resolve, timer })
      this.onRequest(request)
    })
  }

  respond(response: ToolApprovalResponse): boolean {
    let requestId = response.requestId
    if (!requestId && this.pending.size === 1) requestId = this.pending.keys().next().value
    if (!requestId) return false
    return this.resolve(requestId, response.approved)
  }

  denyRun(runId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.runId === runId) this.resolve(requestId, false)
    }
  }

  denyAll(): void {
    for (const requestId of this.pending.keys()) this.resolve(requestId, false)
  }

  get size(): number {
    return this.pending.size
  }

  private resolve(requestId: string | undefined, approved: boolean): boolean {
    if (!requestId) return false
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(approved)
    return true
  }
}
