import {
  knowledgeRequestSchema, knowledgeResponseSchemas,
  type KnowledgeAction, type KnowledgeData, type KnowledgeRequest,
} from '../../../src/shared/knowledge-contracts'
import { config } from '../config'
import { AuthenticationRequiredError } from './authentication-required-error'
import { platformSourceHeaders } from './platform-source-headers'
import { logger } from '../logger'

export class KnowledgeApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly platformCode?: string,
    public readonly requestId?: string,
    public readonly retryAfterMs?: number,
  ) { super(knowledgeErrorMessage(statusCode, platformCode)); this.name = 'KnowledgeApiError' }
}
export function knowledgeErrorMessage(status: number, code?: string): string {
  if (code === 'SOURCE_REJECTED') return '平台拒绝了请求来源，请联系管理员检查客户端来源配置。'
  if (code === 'WAIT_LIMIT_EXCEEDED') return '平台要求的等待时间超过 5 分钟，请稍后重试。'
  if (code === 'INVALID_RESPONSE') return '平台返回的数据格式与知识库契约不一致，请联系管理员核查。'
  if (code === 'DOCUMENT_VERSION_CHANGED') return '文档版本已变化，请从第一页重新打开预览。'
  if (code === 'IDEMPOTENCY_CONFLICT') return '此操作标识与另一项操作冲突，请刷新后重新确认操作。'
  if (status === 401) return '登录已失效，请重新登录。'
  if (status === 403) return '当前成员没有执行此知识库操作的权限。'
  if (status === 404) return '知识库或文档不存在，或你已失去访问权限。'
  if (status === 412 || status === 428) return '文档已更新或缺少版本信息，请刷新详情后重新确认操作。'
  if (status === 409) return '文档正在处理、尚未就绪或不支持当前操作，请刷新详情。'
  if (status === 413) return '文件超过平台允许的 10 MiB 上限。'
  if (status === 415) return '平台不支持此文件格式，请使用 PDF、DOCX、TXT 或 MD。'
  if (status === 429) return '知识库请求过于频繁，请等待后重试。'
  if (status === 499) return '请求已取消。'
  if (status === 408) return '请求超时；写入结果可能尚未确认，请先刷新查看，再重试同一操作。'
  if (status >= 500) return '知识库服务暂时不可用，请稍后重试。'
  if (status === 400) return '知识库请求参数不符合平台要求，请检查输入。'
  return '无法连接知识库平台，请检查网络后重试。'
}

export interface KnowledgeApiOptions {
  getAccessToken(forceRefresh?: boolean): Promise<string>
  baseUrl?: string
  webOrigin?: string
  fetch?: typeof fetch
  requestTimeoutMs?: number
  uploadTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}
export function knowledgeAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new KnowledgeApiError(signal.reason?.name === 'TimeoutError' ? 408 : 499))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new KnowledgeApiError(499)) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
interface Definition { path: string; method: string; body?: unknown; key?: string; etag?: string; file?: { filename: string; bytes: Uint8Array } }
function definition(r: KnowledgeRequest): Definition {
  const kb = 'kbId' in r ? '/knowledge-bases/' + encodeURIComponent(r.kbId) : '/knowledge-bases'
  const doc = 'docId' in r ? kb + '/documents/' + encodeURIComponent(r.docId) : kb + '/documents'
  const query = (values: Record<string, string | number | undefined>): string => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value))
    return '?' + params.toString()
  }
  switch (r.action) {
    case 'list': return { path: kb + query({ page: r.page, pageSize: r.pageSize, keyword: r.keyword }), method: 'GET' }
    case 'getBase': return { path: kb, method: 'GET' }
    case 'source': return { path: kb + '/sources/' + encodeURIComponent(r.sourceId), method: 'GET' }
    case 'createBase': return { path: kb, method: 'POST', body: { name: r.name, ...(r.description !== undefined ? { description: r.description } : {}) } }
    case 'updateBase': return { path: kb, method: 'PATCH', body: { name: r.name, description: r.description } }
    case 'deleteBase': return { path: kb, method: 'DELETE' }
    case 'documents': return { path: doc, method: 'GET' }
    case 'getDocument': return { path: doc, method: 'GET' }
    case 'uploadDocument': return { path: doc + '/upload', method: 'POST', file: r.file, key: r.idempotencyKey }
    case 'replaceDocument': return { path: doc + '/versions', method: 'POST', file: r.file, key: r.idempotencyKey, etag: r.etag }
    case 'retryDocument': return { path: doc + '/reprocess', method: 'POST', body: {}, key: r.idempotencyKey, etag: r.etag }
    case 'deleteDocument': return { path: doc, method: 'DELETE', key: r.idempotencyKey, etag: r.etag }
    case 'versions': return { path: doc + '/versions', method: 'GET' }
    case 'preview': return { path: doc + '/preview' + query({ page: r.page, pageSize: r.pageSize, versionId: r.versionId }), method: 'GET' }
    case 'members': return { path: '/enterprise/members' + query({ view: 'knowledge-grant', page: r.page, pageSize: r.pageSize, keyword: r.keyword }), method: 'GET' }
    case 'grants': return { path: kb + '/grants' + query({ page: r.page, pageSize: r.pageSize, keyword: r.keyword }), method: 'GET' }
    case 'grant': return { path: kb + '/grants', method: 'POST', body: { memberIds: r.memberIds } }
    case 'revoke': return { path: kb + '/grants/' + encodeURIComponent(r.memberId), method: 'DELETE' }
    case 'search': return { path: '/knowledge-bases/search', method: 'POST', body: { query: r.query, topK: r.topK, ...(r.knowledgeBaseIds ? { knowledgeBaseIds: r.knowledgeBaseIds } : {}) } }
  }
}

export class KnowledgeApi {
  private readonly fetcher: typeof fetch
  private readonly baseUrl: string
  constructor(private readonly options: KnowledgeApiOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.baseUrl = (options.baseUrl ?? config.SEP_BASE_URL).replace(/\/+$/, '')
  }
  async execute<R extends KnowledgeRequest>(raw: R, external?: AbortSignal): Promise<KnowledgeData<R['action']>> {
    const request = knowledgeRequestSchema.parse(raw)
    const endpoint = definition(request)
    const control = external ?? new AbortController().signal
    let refreshed = false
    let forceRefresh = false
    let retries = 0
    let waited = 0
    for (;;) {
      if (control.aborted) throw new KnowledgeApiError(499)
      const timeout = AbortSignal.timeout(endpoint.file ? this.options.uploadTimeoutMs ?? 60_000 : this.options.requestTimeoutMs ?? 15_000)
      const signal = AbortSignal.any([control, timeout])
      try {
        const token = await knowledgeAbortable(this.options.getAccessToken(forceRefresh), signal)
        forceRefresh = false
        signal.throwIfAborted()
        const headers: Record<string, string> = {
          Authorization: 'Bearer ' + token, ...platformSourceHeaders(this.options.webOrigin ?? config.SEP_WEB_ORIGIN),
          ...(endpoint.key ? { 'Idempotency-Key': endpoint.key } : {}), ...(endpoint.etag ? { 'If-Match': endpoint.etag } : {}),
        }
        let body: FormData | string | undefined
        if (endpoint.file) {
          const form = new FormData()
          const type = /\.pdf$/i.test(endpoint.file.filename) ? 'application/pdf'
            : /\.docx$/i.test(endpoint.file.filename) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : /\.md$/i.test(endpoint.file.filename) ? 'text/markdown' : 'text/plain'
          form.append('file', new Blob([new Uint8Array(endpoint.file.bytes)], { type }), endpoint.file.filename)
          body = form
        } else if (endpoint.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(endpoint.body) }
        headers['Cache-Control'] = 'no-store'
        const response = await knowledgeAbortable(this.fetcher(this.baseUrl + endpoint.path, { method: endpoint.method, headers, body, signal, redirect: 'error' }), signal)
        if (response.status === 401 && !refreshed) {
          if (response.body) await knowledgeAbortable(response.body.cancel(), signal)
          refreshed = true; forceRefresh = true; continue
        }
        if (!response.ok) {
          const error = await this.responseError(response, signal)
          if (response.status === 429 && request.action !== 'createBase' && retries < 3) {
            const delay = error.retryAfterMs ?? 2000 * 2 ** retries
            if (waited + delay > 300_000) throw new KnowledgeApiError(429, 'WAIT_LIMIT_EXCEEDED', error.requestId, delay)
            waited += delay; retries++
            await knowledgeAbortable((this.options.sleep ?? sleep)(delay, control), control)
            continue
          }
          throw error
        }
        const value: unknown = response.status === 204 ? undefined : await this.readJson(response, signal)
        const withEtag = value && typeof value === 'object' && !Array.isArray(value) && response.headers.get('ETag')
          ? { ...value, etag: response.headers.get('ETag') } : value
        const parsed = knowledgeResponseSchemas[request.action].safeParse(withEtag)
        if (!parsed.success) {
          const platformRequestId = response.headers.get('x-request-id') ?? undefined
          logger.warn('knowledge response contract validation failed', {
            action: request.action,
            status: response.status,
            contentType: response.headers.get('content-type') ?? undefined,
            platformRequestId,
            issueCount: parsed.error.issues.length,
            issuePaths: parsed.error.issues.slice(0, 10).map(issue => issue.path.join('.')),
            issueCodes: parsed.error.issues.slice(0, 10).map(issue => issue.code),
          })
          throw new KnowledgeApiError(502, 'INVALID_RESPONSE', platformRequestId)
        }
        return parsed.data as KnowledgeData<R['action']>
      } catch (error) {
        if (control.aborted) throw new KnowledgeApiError(499)
        if (error instanceof KnowledgeApiError) throw error
        if (timeout.aborted) throw new KnowledgeApiError(408)
        if (error instanceof AuthenticationRequiredError) throw new KnowledgeApiError(401)
        throw new KnowledgeApiError(0)
      }
    }
  }
  private async readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) throw new KnowledgeApiError(502, 'INVALID_RESPONSE')
    try {
      const chunks: Uint8Array[] = []; let length = 0
      for (;;) {
        const item = await knowledgeAbortable(reader.read(), signal)
        if (item.done) break
        length += item.value.byteLength
        if (length > 8 * 1024 * 1024) throw new KnowledgeApiError(502, 'INVALID_RESPONSE')
        chunks.push(item.value)
      }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      if (bytes.length === 0) return undefined
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw new KnowledgeApiError(502, 'INVALID_RESPONSE') }
    } finally {
      // Releasing a request must not wait for an unresponsive stream's cancel hook.
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  private async responseError(response: Response, signal: AbortSignal): Promise<KnowledgeApiError> {
    let value: Record<string, unknown> = {}
    try { const raw = await this.readJson(response, signal); if (raw && typeof raw === 'object') value = raw as Record<string, unknown> }
    catch { signal.throwIfAborted() /* Never expose untrusted response bodies. */ }
    const safeId = (input: unknown): string | undefined => typeof input === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input) ? input : undefined
    const code = response.status === 403 && typeof value.message === 'string' && /Origin|Referer|CSRF/.test(value.message) ? 'SOURCE_REJECTED' : safeId(value.code)
    const retry = response.headers.get('Retry-After')
    const parsed = retry && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : retry ? Date.parse(retry) - (this.options.now ?? Date.now)() : NaN
    return new KnowledgeApiError(response.status, code, safeId(value.requestId) ?? safeId(response.headers.get('x-request-id')), Number.isFinite(parsed) ? Math.max(0, parsed) : undefined)
  }
}

export interface KnowledgeApiPort {
  execute<R extends KnowledgeRequest>(request: R, signal?: AbortSignal): Promise<KnowledgeData<R['action']>>
}
export type { KnowledgeAction }
