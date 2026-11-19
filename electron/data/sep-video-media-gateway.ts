import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { z as schema } from 'zod'
import {
  videoProfilesResponseSchema, videoQuoteResponseSchema, videoReceiptSchema, videoReferenceSchema,
  videoRequestSchema, videoRequestWithIdentitySchema,
  type VideoGatewayPort, type VideoQuote, type VideoReceipt, type VideoRequest,
} from '../../src/shared/video-media'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { SEP_MEDIA_MOCK_PNG_BASE64, SEP_MEDIA_MOCK_PNG_SHA256 } from '../common/platform/sep-media-gateway-contract'
import { VideoRequestError, type VideoErrorSource, type VideoRequestStage } from '../errors/video-request-error'
import { AppError } from '../errors/app-error'
import { inspectMediaImage } from './media-image'
import { config } from '../common/config'
import { platformSourceHeaders } from '../common/platform/platform-source-headers'
import { mediaFailureCodeSchema } from '../../src/shared/media-failure'
import { mediaToolFailureFrom } from '../errors/media-tool-error'
import type { ErrorCode } from '../errors/error-codes'
import { isMediaSpecError, mediaSpecsEqual } from '../../src/shared/media-spec-contract'
import { safeMediaUpstreamError, safeMediaUpstreamMessage } from '../common/media-upstream-error'
import { readApiDiagnostic, transportApiDiagnostic } from '../common/platform/api-diagnostic'
import type { ApiDiagnostic } from '../../src/shared/api-diagnostic'
import { AuthApiError } from '../common/platform/platform-api'

const id = schema.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const JSON_BUDGET = 256 * 1024
const referenceBytes = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
const videoBytes = Buffer.from(fixture.mediaFixture.base64, 'base64')
export class SepVideoGatewayError extends VideoRequestError {
  readonly gatewayCode: string
  constructor(gatewayCode: string, statusCode = 0, stage?: VideoRequestStage, details?: { businessCode?: string | null; source?: VideoErrorSource; requestId?: string | null; message?: string; diagnostic?: ApiDiagnostic }) {
    super({ gatewayCode, statusCode, stage, ...details })
    this.gatewayCode = gatewayCode
    this.name = gatewayCode === 'VIDEO_ABORTED' ? 'AbortError' : 'SepVideoGatewayError'
  }
}

export interface SepMockVideoGatewayOptions {
  mock: true
  /** SEP API root, e.g. http://127.0.0.1:3001/api. Never a provider URL. */
  baseUrl: string
  webOrigin?: string
  subscriptionId: string
  token: (subscriptionId: string, signal: AbortSignal) => Promise<string>
  fetch?: typeof fetch
}
export type SepRealVideoGatewayOptions = Omit<SepMockVideoGatewayOptions, 'mock'> & { mock: false }
type GatewayOptions = SepMockVideoGatewayOptions | SepRealVideoGatewayOptions
const MAX_REAL_VIDEO_BYTES = 256 * 1024 * 1024

function parse<T>(contract: z.ZodType<T>, value: unknown, code = 'VIDEO_INVALID_RESPONSE'): T {
  const result = contract.safeParse(value)
  if (!result.success) throw new SepVideoGatewayError(code)
  return result.data
}

function validateV3Receipt(receipt: VideoReceipt, request?: VideoRequest): VideoReceipt {
  if (receipt.protocolVersion !== 3) {
    if (request?.protocolVersion === 3) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
    return receipt
  }
  const measured = receipt.actualSpec !== undefined && 'source' in receipt.actualSpec && receipt.actualSpec.source === 'measured'
  if (receipt.semanticHashVersion !== 3 || receipt.specRevision === undefined || !receipt.effectiveSpec || !receipt.billingDimensions ||
    receipt.billingDimensions.operation !== receipt.operation || receipt.deliveryStatus === undefined || receipt.acceptance !== receipt.deliveryStatus ||
    (receipt.status === 'SUCCEEDED' || receipt.status === 'PARTIAL_SUCCEEDED') && !measured ||
    receipt.deliveryStatus === 'matched' && !measured ||
    request && (receipt.specRevision !== request.specRevision || !mediaSpecsEqual(request.requestedSpec!, receipt.effectiveSpec) ||
      receipt.billingDimensions.operation !== request.operation || receipt.billingDimensions.durationSeconds !== request.requestedSpec!.durationSeconds || receipt.billingDimensions.resolution !== request.requestedSpec!.resolution)) {
    throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
  }
  return receipt
}

async function abortable<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new SepVideoGatewayError('VIDEO_ABORTED'))
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return action() }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** Shared authenticated transport; mode determines the endpoint and every response contract. */
class SepVideoGateway implements VideoGatewayPort {
  private readonly root: string
  private readonly fetcher: typeof fetch
  private readonly sourceHeaders: { Origin: string; Referer: string }

  constructor(private readonly options: GatewayOptions) {
    try {
      const url = new URL(options.baseUrl)
      if (typeof options.mock !== 'boolean' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || options.baseUrl.includes('?') || options.baseUrl.includes('#')) throw new Error()
      this.root = `${url.href.replace(/\/+$/, '')}/gateway/v1/media/${options.mock ? 'video' : 'video-real'}`
      const web = new URL(options.webOrigin ?? config.SEP_WEB_ORIGIN)
      if (!['http:', 'https:'].includes(web.protocol) || web.username || web.password) throw new Error()
      this.sourceHeaders = platformSourceHeaders(web.origin)
    } catch {
      throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST')
    }
    parse(id, options.subscriptionId, 'VIDEO_INVALID_REQUEST')
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async profiles(signal: AbortSignal) {
    return this.json('/profiles', 'GET', undefined, videoProfilesResponseSchema, signal)
  }

  async uploadReference(bytes: Uint8Array, signal: AbortSignal) {
    if (this.options.mock ? !referenceBytes.equals(bytes) : bytes.length < 24 || bytes.length > 10 * 1024 * 1024) throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST')
    let dimensions: { width: number; height: number }
    let mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
    try {
      const image = inspectMediaImage(bytes)
      if (image.width > 4096 || image.height > 4096) throw new Error()
      dimensions = image
      mimeType = image.mime
    } catch { throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST') }
    const hash = createHash('sha256').update(bytes).digest('hex')
    const body = new FormData()
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
    body.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `video-reference.${extension}`)
    const result = await this.json('/references', 'POST', body, videoReferenceSchema, signal)
    if (result.sha256.toLowerCase() !== hash || result.byteLength !== bytes.length || result.width !== dimensions.width || result.height !== dimensions.height || result.mimeType !== mimeType || !this.options.mock && Date.parse(result.expiresAt) <= Date.now() || this.options.mock && (result.sha256.toLowerCase() !== SEP_MEDIA_MOCK_PNG_SHA256 || result.width !== 1 || result.height !== 1)) throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
    return result
  }

  async quote(input: Omit<VideoRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<VideoQuote> {
    const request = parse(videoRequestSchema, input, 'VIDEO_INVALID_REQUEST')
    if (request.protocolVersion === 3 && this.options.mock) throw new AppError('UPGRADE_REQUIRED')
    const { parameters: _parameters, ...versioned } = request
    const value = await this.json('/quotes', 'POST', request.protocolVersion === 3 ? versioned : request, videoQuoteResponseSchema, signal)
    if (request.protocolVersion === 3 && (value.mock || value.protocolVersion !== 3 || value.semanticHashVersion !== 3 || value.specRevision !== request.specRevision || !value.effectiveSpec || !mediaSpecsEqual(request.requestedSpec!, value.effectiveSpec) || !value.billingDimensions || value.billingDimensions.operation !== request.operation || value.billingDimensions.durationSeconds !== request.requestedSpec!.durationSeconds || value.billingDimensions.resolution !== request.requestedSpec!.resolution)) {
      throw new AppError('SPEC_CONFLICT', { details: { field: 'effectiveSpec', source: 'platform', stage: 'video-quote' } })
    }
    return { quoteId: value.quoteId, requestHash: value.semanticSha256.toLowerCase(), expiresAt: Date.parse(value.expiresAt), status: value.pricingStatus, amount: value.amountCny, currency: value.mock ? 'MOCK' : 'CNY',
      ...(!value.mock ? { amountUsd: value.amountUsd, pricingVersion: value.pricingVersion, usdToCnyRate: value.usdToCnyRate, funding: value.funding,
        ...(value.protocolVersion === 3 ? { protocolVersion: 3 as const, specRevision: value.specRevision, effectiveSpec: value.effectiveSpec } : {}) } : {}) }
  }

  async submit(input: VideoRequest, signal: AbortSignal): Promise<VideoReceipt> {
    const request = parse(videoRequestWithIdentitySchema, input, 'VIDEO_INVALID_REQUEST')
    if (request.protocolVersion === 3 && this.options.mock) throw new AppError('UPGRADE_REQUIRED')
    const { parameters: _parameters, ...versioned } = request
    const receipt = validateV3Receipt(await this.receipt('/requests', 'POST', request.protocolVersion === 3 ? versioned : request, signal), request)
    if (receipt.clientRequestId !== request.clientRequestId || receipt.profileId !== request.profileId || receipt.configVersion !== request.configVersion || receipt.operation !== request.operation) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
    return receipt
  }

  async findReceipt(clientRequestId: string, signal: AbortSignal): Promise<VideoReceipt | null> {
    const requestId = parse(id, clientRequestId, 'VIDEO_INVALID_REQUEST')
    try {
      const receipt = await this.receipt(`/requests/by-client-id/${requestId}`, 'GET', undefined, signal)
      if (receipt.clientRequestId !== requestId) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
      return receipt
    } catch (error) {
      if (error instanceof SepVideoGatewayError && error.statusCode === 404 && error.source !== 'upstream') return null
      throw error
    }
  }

  async getReceipt(receiptId: string, signal: AbortSignal): Promise<VideoReceipt> {
    const receipt = await this.receipt(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}`, 'GET', undefined, signal)
    if (receipt.receiptId !== receiptId) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
    return receipt
  }

  async cancel(receiptId: string, signal: AbortSignal): Promise<void> {
    if (!this.options.mock) {
      const receipt = await this.receipt(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}/cancel`, 'POST', {}, signal)
      if (receipt.receiptId !== receiptId) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
      return
    }
    const { response } = await this.request(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}/cancel`, 'POST', {}, 'application/json', signal)
    this.discard(response)
    throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
  }

  async content(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    if (!this.options.mock) return this.realContent(receiptId, outputId, signal)
    const { response, token } = await this.request(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}/outputs/${parse(id, outputId, 'VIDEO_INVALID_REQUEST')}/content`, 'GET', undefined, 'video/mp4', signal)
    const length = this.length(response, videoBytes.length)
    if (this.mime(response) !== 'video/mp4' || response.headers.get('X-SEP-Media-Mock') !== 'true' || response.headers.get('X-SHA256')?.toLowerCase() !== fixture.mediaFixture.sha256) {
      this.discard(response)
      throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    const onAbort = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    return (async function* () {
      let size = 0
      const hash = createHash('sha256')
      try {
        for (;;) {
          const chunk = await abortable(signal, () => reader.read())
          signal.throwIfAborted()
          if (chunk.done) break
          const nextSize = size + chunk.value.byteLength
          if (nextSize > videoBytes.length || !videoBytes.subarray(size, nextSize).equals(chunk.value)) throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
          size = nextSize
          hash.update(chunk.value)
          yield chunk.value
        }
        if (size !== videoBytes.length || length !== null && size !== length || hash.digest('hex') !== fixture.mediaFixture.sha256) throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
      } catch (error) {
        if (signal.aborted) throw new SepVideoGatewayError('VIDEO_ABORTED')
        if (error instanceof SepVideoGatewayError) throw error
        throw new SepVideoGatewayError('VIDEO_NETWORK_ERROR', 0, 'video-save', { diagnostic: transportApiDiagnostic(error, 'video-save', [token]) })
      } finally {
        signal.removeEventListener('abort', onAbort)
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    })()
  }

  private async receipt(path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<VideoReceipt> {
    const raw = await this.json(path, method, body, videoReceiptSchema, signal)
    const receipt = raw.upstreamError ? { ...raw, upstreamError: safeMediaUpstreamError(raw.upstreamError) } : raw
    return validateV3Receipt(receipt.deliveryStatus && receipt.acceptance === undefined ? { ...receipt, acceptance: receipt.deliveryStatus } : receipt)
  }

  private async realContent(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    parse(id, outputId, 'VIDEO_INVALID_REQUEST')
    const receipt = await this.getReceipt(receiptId, signal)
    const output = receipt.outputs.find(item => item.outputId === outputId)
    if (!output || !receipt.recovery.canDownload || output.byteLength > MAX_REAL_VIDEO_BYTES || output.expiresAt !== null && Date.parse(output.expiresAt) <= Date.now()) throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    const { response, token } = await this.request(`/requests/${receiptId}/outputs/${outputId}/content`, 'GET', undefined, output.mimeType, signal)
    const length = this.length(response, output.byteLength)
    const expectedHash = output.sha256.toLowerCase()
    const headerHash = response.headers.get('X-SHA256')
    if (this.mime(response) !== output.mimeType || response.headers.get('X-SEP-Media-Mock') === 'true' || length !== null && length !== output.byteLength || headerHash !== null && headerHash.toLowerCase() !== expectedHash) {
      this.discard(response)
      throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    const onAbort = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    return (async function* () {
      let size = 0
      const hash = createHash('sha256')
      try {
        for (;;) {
          const chunk = await abortable(signal, () => reader.read())
          signal.throwIfAborted()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > output.byteLength) throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
          hash.update(chunk.value)
          yield chunk.value
        }
        if (size !== output.byteLength || hash.digest('hex') !== expectedHash) throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
      } catch (error) {
        if (signal.aborted) throw new SepVideoGatewayError('VIDEO_ABORTED')
        if (error instanceof SepVideoGatewayError) throw error
        throw new SepVideoGatewayError('VIDEO_NETWORK_ERROR', 0, 'video-save', { diagnostic: transportApiDiagnostic(error, 'video-save', [token]) })
      } finally {
        signal.removeEventListener('abort', onAbort)
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    })()
  }

  private async request(path: string, method: 'GET' | 'POST', body: unknown, accept: string, signal: AbortSignal): Promise<{ response: Response; token: string }> {
    let token: string
    try {
      token = await abortable(signal, () => this.options.token(this.options.subscriptionId, signal))
    } catch (error) {
      if (signal.aborted) throw new SepVideoGatewayError('VIDEO_ABORTED')
      if (error instanceof AuthApiError) throw new SepVideoGatewayError(error.isNetworkError ? 'VIDEO_NETWORK_ERROR' : 'VIDEO_AUTH_FAILED',
        error.statusCode, 'video-authorization', { diagnostic: error.error.diagnostic, source: error.error.diagnostic?.source === 'upstream' ? 'upstream' : null })
      if (error instanceof AppError) {
        const diagnostic = { diagnostic: error.diagnostic }
        if (error.diagnostic?.source === 'upstream') throw new SepVideoGatewayError('VIDEO_AUTH_UNAVAILABLE', error.diagnostic.httpStatus ?? 0, 'video-authorization', { ...diagnostic, source: 'upstream' })
        if (error.code === 'NETWORK_ERROR') throw new SepVideoGatewayError('VIDEO_NETWORK_ERROR', 0, 'video-authorization', diagnostic)
        if (error.code === 'PERMISSION_DENIED') throw new SepVideoGatewayError('VIDEO_AUTH_FAILED', 403, 'video-authorization', diagnostic)
        if (error.code === 'RATE_LIMITED') throw new SepVideoGatewayError('VIDEO_AUTH_RATE_LIMITED', 429, 'video-authorization', diagnostic)
        if (error.code === 'SERVICE_UNAVAILABLE') throw new SepVideoGatewayError('VIDEO_AUTH_UNAVAILABLE', 503, 'video-authorization', diagnostic)
      }
      throw new SepVideoGatewayError('VIDEO_AUTH_FAILED', 401, 'video-authorization')
    }
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) throw new SepVideoGatewayError('VIDEO_AUTH_FAILED', 401, 'video-authorization')
    const multipart = body instanceof FormData
    let response: Response
    try {
      response = await abortable(signal, () => this.fetcher(`${this.root}${path}`, {
        method, signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { ...this.sourceHeaders, Authorization: `Bearer ${token}`, Accept: accept, ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      }))
    } catch (error) {
      throw new SepVideoGatewayError(signal.aborted ? 'VIDEO_ABORTED' : 'VIDEO_NETWORK_ERROR', 0, undefined,
        { diagnostic: transportApiDiagnostic(error, 'video-request', [token]) })
    }
    if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
      this.discard(response)
      throw new SepVideoGatewayError('VIDEO_REDIRECT_BLOCKED')
    }
    if (!response.ok) {
      const stage = path.endsWith('/content') ? 'video-save' : method === 'POST' ? path === '/quotes' ? 'video-quote' : path === '/requests' ? 'video-submit' : undefined : 'video-query'
      const details = await this.errorDetails(response, signal, token)
      if (details.source === 'upstream') throw new SepVideoGatewayError('VIDEO_HTTP_ERROR', response.status, stage, details)
      if (details.businessCode && isMediaSpecError(details.businessCode)) throw new AppError(details.businessCode as ErrorCode, { diagnostic: details.diagnostic, details: { ...details.specDetails,
        stage, statusCode: response.status, ...(details.requestId ? { requestId: details.requestId } : {}), ...(details.source ? { source: details.source } : {}), businessCode: details.businessCode } })
      throw new SepVideoGatewayError('VIDEO_HTTP_ERROR', response.status, stage, details)
    }
    return { response, token }
  }

  private async json<T>(path: string, method: 'GET' | 'POST', body: unknown, contract: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const { response, token } = await this.request(path, method, body, 'application/json', signal)
    const length = this.length(response, JSON_BUDGET)
    if (this.mime(response) !== 'application/json') {
      this.discard(response)
      throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await abortable(signal, () => reader.read())
        signal.throwIfAborted()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > JSON_BUDGET) throw new SepVideoGatewayError('VIDEO_RESPONSE_TOO_LARGE')
        chunks.push(chunk.value)
      }
      if (length !== null && length !== size) throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
      const result = parse(contract, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown)
      if (!result || typeof result !== 'object' || !('mock' in result) || result.mock !== this.options.mock) throw new SepVideoGatewayError('VIDEO_MODE_MISMATCH')
      if ('upstreamError' in result && result.upstreamError) return { ...result, upstreamError: safeMediaUpstreamError(result.upstreamError, [token]) }
      return result
    } catch (error) {
      if (signal.aborted) throw new SepVideoGatewayError('VIDEO_ABORTED')
      if (error instanceof SepVideoGatewayError) throw error
      throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    } finally {
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private mime(response: Response): string {
    return (response.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase()
  }

  private async errorDetails(response: Response, signal: AbortSignal, token: string): Promise<{ businessCode: string | null; source: VideoErrorSource; requestId: string | null; specDetails?: Record<string, unknown>; message?: string; diagnostic: ApiDiagnostic }> {
    const diagnostic = await readApiDiagnostic(response, 'video-request', { maxBytes: 64 * 1024, signal, secrets: [token] })
    if (signal.aborted) throw new SepVideoGatewayError('VIDEO_ABORTED')
    const headerRequestId = response.headers.get('x-request-id')
    const requestId = headerRequestId && /^[A-Za-z0-9_-]{1,128}$/.test(headerRequestId) ? headerRequestId : null
    const upstream = diagnostic.source === 'upstream'
    const value = diagnostic.body
    if (this.mime(response) !== 'application/json' || diagnostic.truncated || diagnostic.readError) {
      return { businessCode: null, source: upstream ? 'upstream' : null, requestId: null, diagnostic }
    }
    const top = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const error = top.error && typeof top.error === 'object' && !Array.isArray(top.error) ? top.error : top
    const rawCode = typeof error.code === 'string' ? error.code : null
    const businessCode = mediaFailureCodeSchema.safeParse(rawCode).success ? rawCode : null
    const source = upstream ? 'upstream' : error.source === 'platform' || error.source === 'upstream' ? error.source : null
    if (error.requestId !== undefined && (typeof error.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(error.requestId))) {
      return { businessCode: null, source, requestId, diagnostic }
    }
    const bodyRequestId = typeof error.requestId === 'string' ? error.requestId : null
    const safeBodyRequestId = bodyRequestId && /^[A-Za-z0-9_-]{1,128}$/.test(bodyRequestId) ? bodyRequestId : null
    if (headerRequestId !== null && (requestId === null || safeBodyRequestId !== null && safeBodyRequestId !== requestId)) {
      return { businessCode: null, source, requestId: null, diagnostic }
    }
    const safe = businessCode && isMediaSpecError(businessCode) ? mediaToolFailureFrom(new AppError(businessCode as ErrorCode, { details: error })).error : undefined
    const specDetails = safe ? Object.fromEntries(Object.entries(safe).filter(([key]) => key !== 'code' && key !== 'message')) : undefined
    return { businessCode, source, requestId: safeBodyRequestId ?? requestId, specDetails, diagnostic,
      ...(source === 'upstream' ? { message: safeMediaUpstreamMessage(value) } : {}) }
  }

  private length(response: Response, budget: number): number | null {
    const raw = response.headers.get('Content-Length')
    if (raw === null) return null
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > budget) {
      this.discard(response)
      throw new SepVideoGatewayError('VIDEO_RESPONSE_TOO_LARGE')
    }
    return Number(raw)
  }

  private discard(response: Response): void {
    void response.body?.cancel().catch(() => undefined)
  }
}

export class SepMockVideoGateway extends SepVideoGateway {
  constructor(options: SepMockVideoGatewayOptions) {
    if (options.mock !== true) throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST')
    super(options)
  }
}
export class SepRealVideoGateway extends SepVideoGateway {
  constructor(options: SepRealVideoGatewayOptions) {
    if (options.mock !== false) throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST')
    super(options)
  }
}
