import { createHash } from 'node:crypto'
import { z, type ZodType } from 'zod'
import type { ImageMime, MediaGatewayPort, MediaQuote, MediaRequest } from '../domain/media'
import { realMediaParameters, realMediaSemanticHash } from '../common/platform/real-media-semantics'
import { config } from '../common/config'
import { platformSourceHeaders } from '../common/platform/platform-source-headers'
import { AppError } from '../errors/app-error'
import { isErrorCode, type ErrorCode } from '../errors/error-codes'
import { inspectMediaImage } from './media-image'
import { imageRequestedSpecSchema, mediaSpecsEqual } from '../../src/shared/media-spec-contract'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const date = z.string().datetime({ offset: true })
const profileSchema = z.object({ profileId: id, kind: z.literal('image'), displayName: z.string().min(1).max(80),
  configVersion: id, operations: z.array(z.enum(['generate', 'edit'])).min(1).max(2), executionMode: z.literal('sync-response'),
  capabilities: z.object({ supportsReferenceImage: z.boolean(), maxOutputs: z.number().int().min(1).max(8),
    sizes: z.array(z.enum(['1024x1024', '1536x1024', '1024x1536'])).min(1).max(3), maxWidth: z.number().int().positive(), maxHeight: z.number().int().positive() }).strict() }).strict()
const profilesSchema = z.object({ mock: z.literal(false), protocolVersion: z.literal(1), persistence: z.literal('database'), profiles: z.array(profileSchema).max(64) }).strict()
const referenceSchema = z.object({ mock: z.literal(false), referenceId: id, expiresAt: date, mimeType: z.literal('image/png'),
  byteLength: z.number().int().positive().max(5 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096) }).strict()
const money = z.string().regex(/^\d+\.\d{6}$/)
const quoteSchema = z.object({ mock: z.literal(false), quoteId: id, expiresAt: date, semanticSha256: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(3).optional(), effectiveSpec: imageRequestedSpecSchema.optional(),
  pricingStatus: z.literal('quoted'), amountCny: money, pricingVersion: z.string().min(1).max(128), billingStatus: z.literal('NOT_RESERVED'),
  funding: z.object({ creditCny: money, memberWalletCny: money, personalCny: money }).strict() }).strict()
const legacyReceiptSchema = z.object({ mock: z.literal(false), receiptId: id, clientRequestId: id, profileId: id, configVersion: id,
  protocolVersion: z.literal(3).optional(), actualSpec: imageRequestedSpecSchema.optional(),
  executionMode: z.literal('sync-response'), status: z.enum(['SUBMITTING','QUEUED','RUNNING','SUBMISSION_UNKNOWN','SUCCEEDED','PARTIAL_SUCCEEDED','FAILED','CANCELLED','RESULT_EXPIRED']),
    pollAfterMs: z.number().int().nonnegative().nullable(), outputs: z.array(z.object({ outputId: id, kind: z.literal('image'), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    byteLength: z.number().int().positive().max(25 * 1024 * 1024), width: z.number().int().positive(), height: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: date.nullable() }).strict()).max(4),
  billingStatus: z.enum(['RESERVED','SETTLED','RELEASED','RECONCILING']), errorCode: z.string().nullable(),
  outputErrors: z.array(z.object({ index: z.number().int().min(0).max(3), code: z.string() }).strict()).max(4),
  recovery: z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict() }).strict()
const receiptSchema = z.union([legacyReceiptSchema, legacyReceiptSchema.extend({
  protocolVersion: z.literal(3),
  executionMode: z.enum(['sync-response', 'async-query']),
  outputs: z.array(legacyReceiptSchema.shape.outputs.element),
  outputErrors: z.array(z.object({ index: z.number().int().nonnegative(), code: z.string() }).strict()),
})])
const MAX_JSON = 64 * 1024
const MAX_CONTENT = 25 * 1024 * 1024
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/
const SAFE_ERROR_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/
const SAFE_ERROR_RECOVERY = /^[a-z][a-z0-9_-]{0,63}$/
const publicErrorMetadataSchema = z.object({
  source: z.enum(['user', 'model', 'client', 'sep', 'platform', 'adapter', 'pricing', 'sub2api', 'provider', 'upstream', 'authorization']).optional(),
  requestedValue: z.union([z.string().max(96).regex(/^(?:[A-Za-z0-9][A-Za-z0-9_.:-]*|image\/[A-Za-z0-9][A-Za-z0-9.+-]*)$/), z.number().finite(), z.boolean()]).optional(),
  reasonCode: z.string().regex(SAFE_ERROR_CODE).optional(),
  submissionState: z.enum(['not_submitted', 'submitted', 'unknown']).optional(),
  billingState: z.enum(['not_reserved', 'reserved', 'settled', 'released', 'reconciling', 'unknown']).optional(),
  retryable: z.boolean().optional(), alternatives: z.array(imageRequestedSpecSchema.refine(spec => Object.keys(spec).length > 0)).max(8).optional(),
})
const SAFE_ERROR_STAGES = new Set(['image-authorization', 'image-quote', 'image-submit', 'image-query', 'image-content'])

export interface SepRealMediaGatewayOptions {
  baseUrl: string
  webOrigin?: string
  token: (subscriptionId: string, signal: AbortSignal) => Promise<string>
  fetch?: typeof fetch
}

export class SepRealMediaGateway implements MediaGatewayPort {
  readonly quoteRequiresUploadedReferences = true
  private readonly root: string
  private readonly fetcher: typeof fetch
  private readonly sourceHeaders: { Origin: string; Referer: string }

  constructor(private readonly options: SepRealMediaGatewayOptions) {
    try {
      const url = new URL(options.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
      this.root = `${url.href.replace(/\/+$/, '')}/gateway/v1/media/real`
      const web = new URL(options.webOrigin ?? config.SEP_WEB_ORIGIN)
      if (!['http:', 'https:'].includes(web.protocol) || web.username || web.password) throw new Error()
      this.sourceHeaders = platformSourceHeaders(web.origin)
    } catch { throw new AppError('INVALID_ARGUMENT', { message: 'Media service URL is invalid.' }) }
    this.fetcher = options.fetch ?? fetch
  }

  async uploadReference(subscriptionId: string, input: { bytes: Uint8Array; mime: ImageMime; sha256: string }, signal: AbortSignal) {
    let inspected: ReturnType<typeof inspectMediaImage>
    try { inspected = inspectMediaImage(input.bytes) } catch { throw new AppError('INVALID_ARGUMENT') }
    if (input.bytes.byteLength === 0 || createHash('sha256').update(input.bytes).digest('hex') !== input.sha256 || inspected.mime !== input.mime) {
      throw new AppError('INVALID_ARGUMENT')
    }
    const form = new FormData()
    const extension = input.mime === 'image/jpeg' ? 'jpg' : input.mime === 'image/webp' ? 'webp' : 'png'
    form.set('file', new Blob([input.bytes], { type: input.mime }), `reference.${extension}`)
    const raw = await this.json(subscriptionId, '/references', 'POST', form, referenceSchema, signal)
    return { referenceId: raw.referenceId, sha256: raw.sha256, expiresAt: Date.parse(raw.expiresAt) }
  }

  async profiles(subscriptionId: string, signal: AbortSignal) {
    return this.json(subscriptionId, '/profiles', 'GET', undefined, profilesSchema, signal)
  }

  async quote(subscriptionId: string, request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<MediaQuote> {
    const raw = await this.json(subscriptionId, '/quotes', 'POST', this.body(request), quoteSchema, signal)
    const requestHash = realMediaSemanticHash(request)
    if (request.protocolVersion === 3 && (raw.protocolVersion !== 3 || !raw.effectiveSpec || !mediaSpecsEqual(request.requestedSpec!, raw.effectiveSpec))) throw new AppError('SPEC_CONFLICT')
    if (raw.semanticSha256 !== requestHash) throw new AppError('PERMISSION_DENIED', { message: '图片报价与本次模型、输入或规格不匹配，请重新报价。' })
    const expiresAt = Date.parse(raw.expiresAt)
    if (expiresAt <= Date.now()) throw new AppError('PERMISSION_DENIED', { message: 'Media quote has expired.' })
    return { ...(raw.effectiveSpec ? { effectiveSpec: raw.effectiveSpec } : {}), quoteId: raw.quoteId, requestHash, expiresAt, status: 'quoted', amount: raw.amountCny,
      currency: 'CNY', authorized: true, budgetAuthorized: true, allowUnknownCost: false }
  }

  async submit(subscriptionId: string, request: MediaRequest, signal: AbortSignal) {
    return this.normalReceipt(await this.json(subscriptionId, '/requests', 'POST', { ...this.body(request), clientRequestId: request.clientRequestId,
      quoteId: request.quoteId }, receiptSchema, signal))
  }

  async findReceipt(subscriptionId: string, clientRequestId: string, signal: AbortSignal) {
    try { return this.normalReceipt(await this.json(subscriptionId, `/requests/by-client-id/${this.safeId(clientRequestId)}`, 'GET', undefined, receiptSchema, signal)) }
    catch (error) { if (error instanceof AppError && error.code === 'NOT_FOUND') return null; throw error }
  }

  async getReceipt(subscriptionId: string, receiptId: string, signal: AbortSignal) {
    return this.normalReceipt(await this.json(subscriptionId, `/requests/${this.safeId(receiptId)}`, 'GET', undefined, receiptSchema, signal))
  }

  async cancel(subscriptionId: string, receiptId: string, signal: AbortSignal) {
    return this.normalReceipt(await this.json(subscriptionId, `/requests/${this.safeId(receiptId)}/cancel`, 'POST', {}, receiptSchema, signal))
  }

  async content(subscriptionId: string, receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.request(subscriptionId, `/requests/${this.safeId(receiptId)}/outputs/${this.safeId(outputId)}/content`, 'GET', undefined, signal)
    if (!response.ok) {
      throw await this.httpError(response, 'image-content')
    }
    const expectedHash = response.headers.get('X-SHA256')
    const length = Number(response.headers.get('Content-Length'))
    const body = response.body
    const mime = response.headers.get('Content-Type')?.split(';')[0]
    if (!mime || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || response.headers.get('X-SEP-Media-Mock') !== 'false'
      || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(length) || length <= 0 || length > MAX_CONTENT || !body) {
      await body?.cancel().catch(() => undefined)
      throw new AppError('SERVICE_UNAVAILABLE')
    }
    return (async function* () {
      const hash = createHash('sha256'); let size = 0; const chunks: Uint8Array[] = []
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let verified = false
      try {
        reader = body.getReader()
        while (true) {
          signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break
          size += value.byteLength; if (size > MAX_CONTENT || size > length) throw new AppError('SERVICE_UNAVAILABLE')
          hash.update(value); chunks.push(value); yield value
        }
        if (size !== length || hash.digest('hex') !== expectedHash) throw new AppError('SERVICE_UNAVAILABLE')
        const all = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
        if (inspectMediaImage(all).mime !== mime) throw new AppError('SERVICE_UNAVAILABLE')
        verified = true
      } catch { throw new AppError('SERVICE_UNAVAILABLE', { message: 'Media result could not be verified.' }) }
      finally {
        if (reader) {
          if (!verified) await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      }
    })()
  }

  private body(request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'>) {
    if (request.protocolVersion === 3) {
      // A returned output needs at least this much JSON metadata. Refuse only
      // counts that cannot fit the existing byte budget even at their minimum.
      const minimumOutputBytes = Buffer.byteLength(JSON.stringify({ outputId: 'x', kind: 'image', mimeType: 'image/png',
        byteLength: 1, width: 1, height: 1, sha256: '0'.repeat(64), expiresAt: null }), 'utf8') + 1
      if (request.requestedSpec?.count !== undefined && request.requestedSpec.count > Math.floor(MAX_JSON / minimumOutputBytes)) {
        throw new AppError('INVALID_ARGUMENT', { message: '请求的图片数量无法容纳在本地回执的 64 KiB 安全预算内，请拆分为多次明确的生成请求。',
          details: { resource: 'image', stage: 'image-quote', field: 'count', source: 'client', requestedValue: request.requestedSpec.count,
            reasonCode: 'LOCAL_RESPONSE_SIZE_LIMIT', submissionState: 'not_submitted', billingState: 'not_reserved' } })
      }
      return {
      protocolVersion: 3, profileId: this.safeId(request.profileId), configVersion: this.safeId(request.configVersion), operation: request.operation,
      referenceIds: request.referenceIds.map(value => this.safeId(value)), creativeBrief: request.creativeBrief.trim(),
      requestedSpec: imageRequestedSpecSchema.parse(request.requestedSpec), parameterSources: request.parameterSources, specRevision: request.specRevision,
      }
    }
    const parameters = realMediaParameters(request.parameters)
    return { profileId: this.safeId(request.profileId), configVersion: this.safeId(request.configVersion), operation: request.operation,
      referenceIds: request.referenceIds.map(value => this.safeId(value)), creativeBrief: request.creativeBrief.trim(), parameters }
  }
  private safeId(value: string) { const parsed = id.safeParse(value); if (!parsed.success) throw new AppError('INVALID_ARGUMENT'); return parsed.data }
  private normalReceipt(value: z.infer<typeof receiptSchema>) {
    return { receiptId: value.receiptId, clientRequestId: value.clientRequestId, profileId: value.profileId, configVersion: value.configVersion,
      status: value.status, actualSpec: value.actualSpec, pollAfterMs: value.pollAfterMs, outputs: value.outputs.map(output => ({ outputId: output.outputId, mime: output.mimeType,
        size: output.byteLength, width: output.width, height: output.height, sha256: output.sha256, expiresAt: output.expiresAt ? Date.parse(output.expiresAt) : null })),
      billingStatus: value.billingStatus, recovery: value.recovery, errorCode: value.errorCode, outputErrors: value.outputErrors }
  }
  private async json<T>(subscriptionId: string, path: string, method: 'GET' | 'POST', body: unknown, schema: ZodType<T>, signal: AbortSignal): Promise<T> {
    const response = await this.request(subscriptionId, path, method, body, signal)
    if (response.status === 404) throw await this.httpError(response, 'image-query')
    if (!response.ok) {
      throw await this.httpError(response, method === 'POST' ? path === '/quotes' ? 'image-quote' : 'image-submit' : 'image-query')
    }
    const length = Number(response.headers.get('Content-Length'))
    const responseBody = response.body
    if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      || (Number.isFinite(length) && length > MAX_JSON) || !responseBody) {
      await responseBody?.cancel().catch(() => undefined)
      throw new AppError('SERVICE_UNAVAILABLE', { message: 'Media service returned an invalid response.' })
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let verified = false
    try {
      reader = responseBody.getReader()
      const chunks: Uint8Array[] = []; let size = 0
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_JSON) throw new Error()
        chunks.push(value)
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
      const parsed = schema.safeParse(data)
      if (!parsed.success) throw new Error()
      verified = true
      return parsed.data
    }
    catch { throw new AppError('SERVICE_UNAVAILABLE', { message: 'Media service returned an invalid response.' }) }
    finally {
      if (reader) {
        if (!verified) await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    }
  }
  private async httpError(response: Response, stage: string): Promise<AppError> {
    const status = response.status
    let payload: unknown
    const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    const length = Number(response.headers.get('Content-Length'))
    if (contentType === 'application/json' && (!Number.isFinite(length) || length <= MAX_JSON) && response.body) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_JSON) throw new Error(); chunks.push(value) }
        reader.releaseLock(); payload = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
      } catch { if (reader) await reader.cancel().catch(() => undefined); else await response.body.cancel().catch(() => undefined) }
      finally { reader?.releaseLock() }
    } else await response.body?.cancel().catch(() => undefined)
    const error = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).error : undefined
    const code = error && typeof error === 'object' && typeof (error as Record<string, unknown>).code === 'string' && SAFE_ERROR_CODE.test((error as Record<string, unknown>).code as string)
      ? (error as Record<string, unknown>).code as string : undefined
    const field = error && typeof error === 'object' && typeof (error as Record<string, unknown>).field === 'string' && SAFE_ERROR_FIELD.test((error as Record<string, unknown>).field as string)
      ? (error as Record<string, unknown>).field as string : undefined
    const recovery = error && typeof error === 'object' && typeof (error as Record<string, unknown>).recovery === 'string' && SAFE_ERROR_RECOVERY.test((error as Record<string, unknown>).recovery as string)
      ? (error as Record<string, unknown>).recovery as string : undefined
    const mapped: ErrorCode = code && isErrorCode(code) ? code : status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : status === 400 ? 'INVALID_ARGUMENT' : 'SERVICE_UNAVAILABLE'
    const message = mapped === 'AUTH_REQUIRED' ? '图片服务认证已失效，请重新登录。' : mapped === 'PERMISSION_DENIED' ? '图片服务拒绝了当前授权或请求。' : mapped === 'INVALID_ARGUMENT' ? '图片服务拒绝了当前输入或规格。' : mapped === 'NOT_FOUND' ? '未找到对应的图片任务或资源。' : mapped === 'RATE_LIMITED' ? '图片服务请求过于频繁，请稍后重试。' : '图片服务暂时不可用，请查询原请求，不要自动重新生成。'
    const metadata = publicErrorMetadataSchema.safeParse(error)
    return new AppError(mapped, { message, details: { resource: 'image', stage: SAFE_ERROR_STAGES.has(stage) ? stage : 'image-query', ...(code ? { businessCode: code } : {}), ...(field ? { field } : {}), ...(recovery ? { recovery } : {}), ...(metadata.success ? metadata.data : {}) } })
  }
  private async request(subscriptionId: string, path: string, method: 'GET'|'POST', body: unknown, signal: AbortSignal) {
    this.safeId(subscriptionId); signal.throwIfAborted()
    try {
      const token = await this.options.token(subscriptionId, signal)
      if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) throw new Error()
      const multipart = body instanceof FormData
      const response = await this.fetcher(`${this.root}${path}`, { method, signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { ...this.sourceHeaders, Authorization: `Bearer ${token}`, Accept: 'application/json, image/png', ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) })
      if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw new Error() }
      return response
    } catch { if (signal.aborted) throw new AppError('INVALID_STATE', { message: 'Media request was cancelled.' }); throw new AppError('NETWORK_ERROR') }
  }
}
