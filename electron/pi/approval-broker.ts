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

  /**
   * 处理渲染进程送来的审批结果。
   *
   * C5：requestId 必填，没有任何"只有一个 pending 就当它"的回退。
   * 原来的回退能批准错的调用：请求 A 在 60s 超时被自动拒绝，紧接着请求 B 进入 pending，
   * 用户此时点了针对 A 的批准按钮 —— 命中单条 pending 分支后被批准的是 B，而 B 可能是
   * 一个 bash。这违反"所有 bash/write/edit 需显式用户批准"：用户批准的不是这一个。
   *
   * 渲染进程本来就一直带着 requestId（src/App.tsx 从 request.requestId 取），
   * 所以回退分支从来没有真实调用方，只是个隐患。
   */
  respond(response: ToolApprovalResponse): boolean {
    if (!response.requestId) {
      console.warn('[ApprovalBroker] rejected approval response without requestId', {
        pending: this.pending.size,
        approved: response.approved,
      })
      return false
    }
    if (!this.pending.has(response.requestId)) {
      // 多半是超时自动拒绝之后用户才点的按钮。不能追认，只记一笔。
      console.warn('[ApprovalBroker] approval response for an unknown request', {
        pending: this.pending.size,
        approved: response.approved,
      })
      return false
    }
    return this.resolve(response.requestId, response.approved, response.reason ?? 'user_response')
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
