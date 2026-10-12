export const MAX_GATEWAY_RETRY_WAIT_MS = 5 * 60_000

function numericDelay(value: string | null, multiplier: number): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined
  const delay = Number(value) * multiplier
  return Math.ceil(delay)
}

function retryAfter(headers: Headers, now: number): number | undefined {
  const milliseconds = numericDelay(headers.get('retry-after-ms'), 1)
  if (milliseconds !== undefined) return milliseconds
  const value = headers.get('retry-after')
  const seconds = numericDelay(value, 1000)
  if (seconds !== undefined) return seconds
  // Do not let Date.parse reinterpret malformed numeric values as calendar dates.
  if (!value || !/[a-z]/i.test(value) || !value.includes(',')) return undefined
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export function waitForGatewayRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new DOMException('Gateway retry cancelled.', 'AbortError'))
    }
    const timer = setTimeout(() => { cleanup(); resolve() }, delayMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Per-session timing only. Pi remains the sole owner of retry decisions and attempts. */
export class GatewayRetryWait {
  private hintMs: number | undefined
  private pendingMs = 0
  private attempt = 0
  private blocked = false
  terminalError: string | undefined

  reset(): void {
    this.hintMs = undefined
    this.pendingMs = 0
    this.attempt = 0
    this.blocked = false
    this.terminalError = undefined
  }

  inspect(response: Response, now = Date.now()): boolean {
    this.hintMs = response.status === 429 ? retryAfter(response.headers, now) : undefined
    this.blocked = response.headers.get('x-should-retry') === 'false' && !response.ok
    if (this.blocked) return false
    if (this.hintMs !== undefined && this.hintMs > MAX_GATEWAY_RETRY_WAIT_MS) {
      this.terminalError = `Gateway recovery requires ${this.hintMs} ms, exceeding the ${MAX_GATEWAY_RETRY_WAIT_MS} ms retry wait limit.`
      return false
    }
    return true
  }

  schedule(): number {
    this.attempt++
    this.pendingMs = this.hintMs ?? Math.min(2000 * 2 ** (this.attempt - 1), MAX_GATEWAY_RETRY_WAIT_MS)
    this.hintMs = undefined
    return this.pendingMs
  }

  async wait(signal?: AbortSignal | null): Promise<void> {
    if (this.terminalError) throw new Error(this.terminalError)
    if (this.blocked) throw new Error('Gateway disabled automatic retry for this response.')
    const delay = this.pendingMs
    this.pendingMs = 0
    if (delay > 0 || signal?.aborted) await waitForGatewayRetry(delay, signal)
  }
}
