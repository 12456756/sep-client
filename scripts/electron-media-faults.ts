export type MediaFaultKind = 'AUTH_QUERY' | 'AUTH_DOWNLOAD' | 'CORRUPT_DOWNLOAD' | 'PARTIAL_DOWNLOAD'

export interface MediaFaultAudit {
  kind: MediaFaultKind | null
  enabled: boolean
  targetReceiptId: string | null
  targetClientRequestId: string | null
  injected: number
  allowedOutputId: string | null
  downloadAttempts: Record<string, number>
}

const requestPath = '/api/gateway/v1/media/requests'
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/
const jsonBudget = 64 * 1024
const jsonTimeoutMs = 1_000
const kinds: readonly MediaFaultKind[] = ['AUTH_QUERY', 'AUTH_DOWNLOAD', 'CORRUPT_DOWNLOAD', 'PARTIAL_DOWNLOAD']

function initialAudit(kind: MediaFaultKind | null): MediaFaultAudit {
  return {
    kind, enabled: kind !== null, targetReceiptId: null, targetClientRequestId: null,
    injected: 0, allowedOutputId: null, downloadAttempts: {},
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > jsonBudget)) return undefined
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    reader = response.clone().body?.getReader()
    if (!reader) return undefined
    const streamReader = reader
    const read = async (): Promise<unknown> => {
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const chunk = await streamReader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > jsonBudget) return undefined
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    }
    return await Promise.race([
      read(),
      new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), jsonTimeoutMs) }),
    ])
  } catch {
    return undefined
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    // A tee's cancellation can wait for the untouched native response; never await it.
    if (reader) {
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

export class MediaFaultInjector {
  private readonly origin: string
  private state: MediaFaultAudit = initialAudit(null)
  private generation = 0
  private capturing = false

  constructor(mockRoot: string) {
    let root: URL
    try {
      root = new URL(mockRoot)
    } catch {
      throw new TypeError('Media faults require a loopback HTTP /api root')
    }
    if (typeof mockRoot !== 'string'
      || !/^http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?\/api$/i.test(mockRoot)
      || root.protocol !== 'http:' || root.pathname !== '/api'
      || root.username || root.password || root.search || root.hash) {
      throw new TypeError('Media faults require a loopback HTTP /api root')
    }
    this.origin = root.origin
  }

  configure(kind: MediaFaultKind | null): void {
    if (kind !== null && !kinds.includes(kind)) throw new TypeError('Invalid media fault kind')
    this.generation++
    this.capturing = false
    if (kind === null) this.state.enabled = false
    else this.state = initialAudit(kind)
  }

  get audit(): MediaFaultAudit {
    return { ...this.state, downloadAttempts: { ...this.state.downloadAttempts } }
  }

  before(url: URL, method: string): Response | undefined {
    if (!this.inScope(url) || method.toUpperCase() !== 'GET' || !this.state.targetReceiptId) return undefined
    const outputId = this.outputId(url)
    // Count at the pre-fetch boundary, including denied, failed and recovery attempts.
    if (outputId) {
      const attempts = Object.hasOwn(this.state.downloadAttempts, outputId) ? this.state.downloadAttempts[outputId] : 0
      Object.defineProperty(this.state.downloadAttempts, outputId, {
        value: attempts + 1, enumerable: true, configurable: true, writable: true,
      })
    }
    if (!this.state.enabled) return undefined
    const query = url.pathname === `${requestPath}/${this.state.targetReceiptId}`
      || url.pathname === `${requestPath}/by-client-id/${this.state.targetClientRequestId}`
    if ((this.state.kind === 'AUTH_QUERY' && query) || (this.state.kind === 'AUTH_DOWNLOAD' && outputId)) {
      this.state.injected++
      return new Response(JSON.stringify({ error: { code: 'MEDIA_FORBIDDEN', message: 'Mock authorization revoked' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }
    return undefined
  }

  async after(url: URL, method: string, response: Response): Promise<Response> {
    if (!this.state.enabled || !this.inScope(url) || !response.ok) return response
    if (method.toUpperCase() === 'POST' && url.pathname === requestPath
      && !this.state.targetReceiptId && !this.capturing) {
      const generation = this.generation
      this.capturing = true
      try {
        const value = await boundedJson(response)
        if (generation !== this.generation || !this.state.enabled) return response
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const { receiptId, clientRequestId } = value as Record<string, unknown>
          if (typeof receiptId === 'string' && idPattern.test(receiptId)
            && typeof clientRequestId === 'string' && idPattern.test(clientRequestId)) {
            this.state.targetReceiptId = receiptId
            this.state.targetClientRequestId = clientRequestId
          }
        }
      } finally {
        if (generation === this.generation) this.capturing = false
      }
      return response
    }
    if (method.toUpperCase() !== 'GET'
      || (this.state.kind !== 'CORRUPT_DOWNLOAD' && this.state.kind !== 'PARTIAL_DOWNLOAD')) return response
    const outputId = this.outputId(url)
    if (!outputId || !response.body
      || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') return response
    if (this.state.kind === 'PARTIAL_DOWNLOAD') {
      this.state.allowedOutputId ??= outputId
      if (this.state.allowedOutputId === outputId) return response
    }
    let changed = false
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!changed && chunk.byteLength) {
          const bytes = Uint8Array.from(chunk)
          bytes[bytes.length - 1] ^= 1
          changed = true
          controller.enqueue(bytes)
        } else controller.enqueue(chunk)
      },
    }))
    this.state.injected++
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  private inScope(url: URL): boolean {
    return url.origin === this.origin && !url.username && !url.password && !url.search && !url.hash
      && !url.href.includes('?') && !url.href.includes('#')
      && (url.pathname === requestPath || url.pathname.startsWith(`${requestPath}/`))
  }

  private outputId(url: URL): string | undefined {
    if (!this.state.targetReceiptId) return undefined
    const prefix = `${requestPath}/${this.state.targetReceiptId}/outputs/`
    if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith('/content')) return undefined
    const id = url.pathname.slice(prefix.length, -'/content'.length)
    return idPattern.test(id) ? id : undefined
  }
}
