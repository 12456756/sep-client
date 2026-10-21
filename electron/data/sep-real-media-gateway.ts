import { createHash } from 'node:crypto'
import { z, type ZodType } from 'zod'
import type { ImageMime, MediaGatewayPort, MediaQuote, MediaRequest } from '../domain/media'
import { realMediaParameters, realMediaSemanticHash } from '../common/platform/real-media-semantics'
import { config } from '../common/config'
import { platformSourceHeaders } from '../common/platform/platform-source-headers'
import { AppError } from '../errors/app-error'
import { inspectMediaImage } from './media-image'

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
  pricingStatus: z.literal('quoted'), amountCny: money, pricingVersion: z.string().min(1).max(128), billingStatus: z.literal('NOT_RESERVED'),
  funding: z.object({ creditCny: money, memberWalletCny: money, personalCny: money }).strict() }).strict()
const receiptSchema = z.object({ mock: z.literal(false), receiptId: id, clientRequestId: id, profileId: id, configVersion: id,
  executionMode: z.literal('sync-response'), status: z.enum(['SUBMITTING','QUEUED','RUNNING','SUBMISSION_UNKNOWN','SUCCEEDED','PARTIAL_SUCCEEDED','FAILED','CANCELLED','RESULT_EXPIRED']),
  pollAfterMs: z.number().int().nonnegative().nullable(), outputs: z.array(z.object({ outputId: id, kind: z.literal('image'), mimeType: z.literal('image/png'),
    byteLength: z.number().int().positive().max(25 * 1024 * 1024), width: z.number().int().positive(), height: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: date.nullable() }).strict()).max(4),
  billingStatus: z.enum(['RESERVED','SETTLED','RELEASED','RECONCILING']), errorCode: z.string().nullable(),
  outputErrors: z.array(z.object({ index: z.number().int().min(0).max(3), code: z.string() }).strict()).max(4),
  recovery: z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict() }).strict()
const MAX_JSON = 64 * 1024
const MAX_CONTENT = 25 * 1024 * 1024

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
    if (input.mime !== 'image/png' || input.bytes.byteLength === 0 || input.bytes.byteLength > 5 * 1024 * 1024
      || createHash('sha256').update(input.bytes).digest('hex') !== input.sha256 || inspectMediaImage(input.bytes).mime !== 'image/png') {
      throw new AppError('INVALID_ARGUMENT')
    }
    const form = new FormData()
    form.set('file', new Blob([input.bytes], { type: 'image/png' }), 'reference.png')
    const raw = await this.json(subscriptionId, '/references', 'POST', form, referenceSchema, signal)
    return { referenceId: raw.referenceId, sha256: raw.sha256, expiresAt: Date.parse(raw.expiresAt) }
  }

  async profiles(subscriptionId: string, signal: AbortSignal) {
    return this.json(subscriptionId, '/profiles', 'GET', undefined, profilesSchema, signal)
  }

  async quote(subscriptionId: string, request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<MediaQuote> {
    const raw = await this.json(subscriptionId, '/quotes', 'POST', this.body(request), quoteSchema, signal)
    const requestHash = realMediaSemanticHash(request)
    if (raw.semanticSha256 !== requestHash) throw new AppError('PERMISSION_DENIED', { message: '图片报价与本次模型、输入或规格不匹配，请重新报价。' })
    const expiresAt = Date.parse(raw.expiresAt)
    if (expiresAt <= Date.now()) throw new AppError('PERMISSION_DENIED', { message: 'Media quote has expired.' })
    return { quoteId: raw.quoteId, requestHash, expiresAt, status: 'quoted', amount: raw.amountCny,
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
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401) throw new AppError('AUTH_REQUIRED')
      if (response.status === 403) throw new AppError('PERMISSION_DENIED')
      if (response.status === 429) throw new AppError('RATE_LIMITED')
      throw new AppError('SERVICE_UNAVAILABLE')
    }
    const expectedHash = response.headers.get('X-SHA256')
    const length = Number(response.headers.get('Content-Length'))
    const body = response.body
    if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/png' || response.headers.get('X-SEP-Media-Mock') !== 'false'
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
        if (inspectMediaImage(all).mime !== 'image/png') throw new AppError('SERVICE_UNAVAILABLE')
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
    const parameters = realMediaParameters(request.parameters)
    return { profileId: this.safeId(request.profileId), configVersion: this.safeId(request.configVersion), operation: request.operation,
      referenceIds: request.referenceIds.map(value => this.safeId(value)), creativeBrief: request.creativeBrief.trim(), parameters }
  }
  private safeId(value: string) { const parsed = id.safeParse(value); if (!parsed.success) throw new AppError('INVALID_ARGUMENT'); return parsed.data }
  private normalReceipt(value: z.infer<typeof receiptSchema>) {
    return { receiptId: value.receiptId, clientRequestId: value.clientRequestId, profileId: value.profileId, configVersion: value.configVersion,
      status: value.status, pollAfterMs: value.pollAfterMs, outputs: value.outputs.map(output => ({ outputId: output.outputId, mime: output.mimeType as 'image/png',
        size: output.byteLength, width: output.width, height: output.height, sha256: output.sha256, expiresAt: output.expiresAt ? Date.parse(output.expiresAt) : null })),
      billingStatus: value.billingStatus, recovery: value.recovery, errorCode: value.errorCode, outputErrors: value.outputErrors }
  }
  private async json<T>(subscriptionId: string, path: string, method: 'GET' | 'POST', body: unknown, schema: ZodType<T>, signal: AbortSignal): Promise<T> {
    const response = await this.request(subscriptionId, path, method, body, signal)
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); throw new AppError('NOT_FOUND') }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401) throw new AppError('AUTH_REQUIRED')
      if (response.status === 403) throw new AppError('PERMISSION_DENIED')
      if (response.status === 429) throw new AppError('RATE_LIMITED')
      throw new AppError('SERVICE_UNAVAILABLE')
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
