/**
 * electron/runtime/run-approvals.ts — 工具授权，按 requestId 寻址（C5）
 *
 * `bash` / `write` / `edit` 必须经用户明确批准；未知工具默认拒绝；等待上限 60 秒，
 * 浏览器人工接管等待上限 3 分钟；超时自动拒绝。
 *
 * C5 是一个严重缺陷：`respond()` 原来有个"只有一个 pending 时可以省略 requestId"的
 * 回退。它能批准**错的**调用——A 超时被自动拒绝、B 随后进入 pending，用户点的是 A 的
 * 批准按钮，被放行的却是 B。于是一个从未被批准的 `bash` 得到执行。所以这里没有任何
 * 按数量的回退：requestId 对不上就返回 false，pending 一个都不消耗。
 */
import { randomUUID } from 'node:crypto'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { ToolApprovalResponse } from '../../src/shared/ipc'
import { isDetectedBrowserHandoff, toolApprovalTimeoutMs } from '../../src/shared/tool-approval'
import type { BrowserHandoffDetection } from '../domain/browser-handoff'
import { logger } from '../common/logger'

const log = logger.child('run-approvals')

interface PendingApproval {
  request: ToolAuthorizationRequest
  resolve: (decision: { approved: boolean; reason: string }) => void
  timer: NodeJS.Timeout
  stopVerification?: () => void
}

export interface ToolApprovalsOptions {
  timeoutMs?: number
  onRequest: (request: ToolAuthorizationRequest) => unknown | Promise<unknown>
  onResolved?: (request: ToolAuthorizationRequest, approved: boolean, reason: string) => unknown | Promise<unknown>
}

export class ToolApprovals {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timeoutMs: number | undefined
  private readonly onRequest: ToolApprovalsOptions['onRequest']
  private readonly onResolved: ToolApprovalsOptions['onResolved']

  constructor(options: ToolApprovalsOptions) {
    this.timeoutMs = options.timeoutMs
    this.onRequest = options.onRequest
    this.onResolved = options.onResolved
  }

  async request(input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>, detection?: BrowserHandoffDetection): Promise<boolean> {
    return (await this.requestDecision(input, detection)).approved
  }

  requestDecision(input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>, detection?: BrowserHandoffDetection): Promise<{ approved: boolean; reason: string }> {
    if (isDetectedBrowserHandoff(input) !== !!detection || detection?.signal.aborted) return Promise.resolve({ approved: false, reason: 'invalid_request' })
    const timeoutMs = this.timeoutMs ?? toolApprovalTimeoutMs(input)
    const timestamp = Date.now()
    const request: ToolAuthorizationRequest = {
      ...input,
      requestId: randomUUID(),
      timestamp,
      expiresAt: timestamp + timeoutMs,
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.resolve(request.requestId, false, 'timeout')
      }, timeoutMs)
      const pending: PendingApproval = { request, resolve, timer }
      this.pending.set(request.requestId, pending)
      const verification = detection ? new AbortController() : undefined
      if (detection && verification) {
        const onAbort = () => { this.resolve(request.requestId, false, 'browser_handoff_cancelled') }
        detection.signal.addEventListener('abort', onAbort, { once: true })
        pending.stopVerification = () => {
          detection.signal.removeEventListener('abort', onAbort)
          verification.abort()
        }
      }
      void (async () => {
        try { await this.onRequest(request) }
        catch { this.resolve(request.requestId, false, 'request_delivery_failed'); return }
        if (!detection || !verification || verification.signal.aborted) return
        try {
          await detection.waitForCompletion(verification.signal)
          if (!verification.signal.aborted) {
            const withinDeadline = Date.now() < timestamp + timeoutMs
            this.resolve(request.requestId, withinDeadline, withinDeadline ? 'browser_handoff_detected' : 'timeout')
          }
        } catch { /* Manual completion remains available if detection cannot confirm a result. */ }
      })()
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
  getPending(requestId: string): ToolAuthorizationRequest | undefined {
    const request = this.pending.get(requestId)?.request
    return request && request.expiresAt! > Date.now() ? request : undefined
  }

  respond(response: ToolApprovalResponse): boolean {
    if (!response.requestId) {
      log.warn('rejected approval response without requestId', {
        pending: this.pending.size,
        approved: response.approved,
      })
      return false
    }
    const pending = this.pending.get(response.requestId)
    if (!pending) {
      // 多半是超时自动拒绝之后用户才点的按钮。不能追认，只记一笔。
      log.warn('approval response for an unknown request', {
        pending: this.pending.size,
        approved: response.approved,
      })
      return false
    }
    if (Date.now() >= pending.request.expiresAt!) return this.resolve(response.requestId, false, 'timeout')
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
    pending.stopVerification?.()
    pending.resolve({ approved, reason })
    void Promise.resolve(this.onResolved?.(pending.request, approved, reason)).catch(() => undefined)
    return true
  }
}


