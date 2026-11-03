import { randomBytes } from 'node:crypto'
import { resultFileRequestSchema, resultFileReleaseSchema, type ResultFileRequest, type ResultFilePreview } from '../../src/shared/result-files'
import type { OpenResultFile, ResultFileStorePort } from '../data/result-file-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { requireScope, type ScopeSource } from './scope-guard'
import { AppError } from '../errors/app-error'

interface Options { scope: ScopeSource; store: ResultFileStorePort; reveal(path: string): void | Promise<void> }
interface Lease { scope: TaskOwnerScope; input: ResultFileRequest; file: OpenResultFile; abort: AbortController }

export class ResultFileService {
  private readonly leases = new Map<string, Lease>()
  private epoch = 0
  constructor(private readonly options: Options) {}

  clear(): void {
    this.epoch++
    for (const [url] of this.leases) this.dispose(url)
  }

  private dispose(url: string): void {
    const lease = this.leases.get(url)
    if (!lease) return
    this.leases.delete(url); lease.abort.abort()
    void lease.file.close().catch(() => undefined)
  }

  private assert(scope: TaskOwnerScope, epoch = this.epoch): void {
    const current = requireScope(this.options.scope)
    if (epoch !== this.epoch || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
  }

  async preview(raw: ResultFileRequest): Promise<ResultFilePreview> {
    const input = resultFileRequestSchema.parse(raw), scope = requireScope(this.options.scope), epoch = this.epoch
    const file = await this.options.store.open(scope, input)
    try {
      this.assert(scope, epoch)
      if (this.leases.size >= 64) this.dispose(this.leases.keys().next().value!)
      const url = `sep-result://preview/${randomBytes(32).toString('hex')}`
      this.leases.set(url, { scope, input, file, abort: new AbortController() })
      return { url, mime: file.mime, kind: file.kind }
    } catch (error) { await file.close(); throw error }
  }

  async release(raw: { url: string }): Promise<void> {
    const { url } = resultFileReleaseSchema.parse(raw)
    const lease = this.leases.get(url)
    if (lease) { this.assert(lease.scope); this.dispose(url) }
  }

  async reveal(raw: ResultFileRequest): Promise<void> {
    const input = resultFileRequestSchema.parse(raw), scope = requireScope(this.options.scope), epoch = this.epoch
    const path = await this.options.store.revealPath(scope, input)
    this.assert(scope, epoch)
    await this.options.reveal(path)
  }

  async handle(request: Request): Promise<Response> {
    const lease = this.leases.get(request.url)
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    if (!lease) return new Response(null, { status: 404, headers })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } })
    const epoch = this.epoch
    const check = () => { this.assert(lease.scope, epoch); lease.abort.signal.throwIfAborted(); request.signal.throwIfAborted() }
    try {
      check(); await lease.file.validate(); await lease.file.authorize?.(); check()
      const size = lease.file.size
      let start = 0, end = size - 1
      const range = request.headers.get('range')
      if (range) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!parsed || (!parsed[1] && !parsed[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
        if (!parsed[1]) { const suffix = Number(parsed[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } }); start = Math.max(0, size - suffix) }
        else { start = Number(parsed[1]); if (parsed[2]) end = Math.min(end, Number(parsed[2])) }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
      }
      Object.assign(headers, { 'Content-Type': lease.file.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) })
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      const body = request.method === 'HEAD' ? null : lease.file.stream(start, end, lease.abort.signal, check)
      return new Response(body, { status: range ? 206 : 200, headers })
    } catch { this.dispose(request.url); return new Response(null, { status: 403, headers }) }
  }
}
