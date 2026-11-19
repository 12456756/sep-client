import type { McpRuntime } from './pi-mcp-client'

type BrowserFactory = (waitForHuman: () => Promise<boolean>) => Promise<McpRuntime>
type Lease = { cancellation: AbortController; waitForHuman?: () => Promise<boolean>; pending: number }

/** Owns only the built-in browser, not employee-specific connectors or permissions. */
export class SharedBrowserOwner {
  private runtime?: McpRuntime
  private workspace?: string
  private lease?: Lease
  private idle?: ReturnType<typeof setTimeout>
  private closing: Promise<void> = Promise.resolve()
  private blocked = false
  private retired = false

  constructor(private readonly idleMs = 30 * 60_000) {}

  async acquire(workspace: string, factory: BrowserFactory, waitForHuman?: () => Promise<boolean>): Promise<McpRuntime> {
    if (this.blocked || this.retired) throw new Error('Browser lease has been revoked.')
    if (this.lease) throw new Error('Browser lease is already active.')
    if (this.idle) clearTimeout(this.idle)
    const lease: Lease = { cancellation: new AbortController(), waitForHuman, pending: 0 }
    this.lease = lease
    const assertLease = () => {
      if (this.lease !== lease || lease.cancellation.signal.aborted) throw new Error('Browser lease has expired.')
    }
    try {
      await this.closing
      assertLease()
      if (this.runtime && this.workspace !== workspace) {
        const previous = this.runtime
        this.runtime = undefined
        await previous.dispose()
        assertLease()
      }
      if (!this.runtime) {
        const runtime = await factory(async () => {
          const active = this.lease
          if (!active || active.cancellation.signal.aborted || !active.waitForHuman) return false
          return active.waitForHuman()
        })
        if (this.lease !== lease) { await runtime.dispose(); assertLease() }
        this.runtime = runtime
        this.workspace = workspace
      }
      const active = this.runtime!
      return { ...active, tools: active.tools.map(tool => ({ ...tool, execute: async (id, input, signal, ...rest) => {
        assertLease()
        const operationSignal = signal ? AbortSignal.any([signal, lease.cancellation.signal]) : lease.cancellation.signal
        operationSignal.throwIfAborted()
        lease.pending++
        try {
          const result = await tool.execute(id, input, operationSignal, ...rest)
          assertLease()
          operationSignal.throwIfAborted()
          if (result.details.executionUncertain || result.details.browserSessionClosed) await this.close()
          return result
        } catch (error) {
          if (operationSignal.aborted && this.lease === lease) await this.close()
          throw error
        } finally { lease.pending-- }
      } })), dispose: async () => {
        if (this.lease !== lease) return
        if (lease.pending) { await this.close(); return }
        this.lease = undefined
        lease.cancellation.abort()
        this.idle = setTimeout(() => { void this.close().catch(() => undefined) }, this.idleMs)
        this.idle.unref()
      } }
    } catch (error) {
      if (this.lease === lease) await this.close()
      throw error
    }
  }

  resume(): void {
    if (this.retired) throw new Error('Browser owner has been disposed.')
    this.blocked = false
  }

  revoke(): Promise<void> { this.blocked = true; return this.close() }

  dispose(): Promise<void> { this.retired = true; return this.revoke() }

  /** Revoke synchronously, before any asynchronous cleanup can time out. */
  close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    this.lease?.cancellation.abort()
    this.lease = undefined
    const runtime = this.runtime
    this.runtime = undefined
    this.closing = this.closing.catch(() => undefined).then(() => runtime?.dispose())
    return this.closing
  }
}
