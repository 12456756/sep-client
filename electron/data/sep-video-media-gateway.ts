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
import { AppError } from '../errors/app-error'
import type { ErrorCode } from '../errors/error-codes'
import { inspectMediaImage } from './media-image'

const id = schema.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const JSON_BUDGET = 256 * 1024
const referenceBytes = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
const videoBytes = Buffer.from(fixture.mediaFixture.base64, 'base64')

export class SepVideoGatewayError extends AppError {
  constructor(readonly gatewayCode: string, readonly statusCode = 0) {
    const code: ErrorCode = statusCode === 401 ? 'AUTH_REQUIRED' : statusCode === 403 ? 'PERMISSION_DENIED'
      : statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'INVALID_ARGUMENT' : statusCode === 409 || statusCode === 410 ? 'INVALID_STATE' : statusCode === 429 ? 'RATE_LIMITED'
        : gatewayCode === 'VIDEO_NETWORK_ERROR' ? 'NETWORK_ERROR' : gatewayCode === 'VIDEO_INVALID_REQUEST' ? 'INVALID_ARGUMENT' : 'SERVICE_UNAVAILABLE'
    super(code, { message: `SEP video request failed (${gatewayCode}).` })
    this.name = gatewayCode === 'VIDEO_ABORTED' ? 'AbortError' : 'SepVideoGatewayError'
  }
}

export interface SepMockVideoGatewayOptions {
  mock: true
  /** SEP API root, e.g. http://127.0.0.1:3001/api. Never a provider URL. */
  baseUrl: string
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

  constructor(private readonly options: GatewayOptions) {
    try {
      const url = new URL(options.baseUrl)
      if (typeof options.mock !== 'boolean' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || options.baseUrl.includes('?') || options.baseUrl.includes('#')) throw new Error()
      this.root = `${url.href.replace(/\/+$/, '')}/gateway/v1/media/${options.mock ? 'video' : 'video-real'}`
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
    if (this.options.mock ? !referenceBytes.equals(bytes) : bytes.length < 24 || bytes.length > 10 * 1024 * 1024 || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST')
    let dimensions: { width: number; height: number }
    try {
      const image = inspectMediaImage(bytes)
      if (image.mime !== 'image/png' || image.width > 4096 || image.height > 4096) throw new Error()
      dimensions = image
    } catch { throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST') }
    const hash = createHash('sha256').update(bytes).digest('hex')
    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'video-reference.png')
    const result = await this.json('/references', 'POST', body, videoReferenceSchema, signal)
    if (result.sha256.toLowerCase() !== hash || result.byteLength !== bytes.length || result.width !== dimensions.width || result.height !== dimensions.height || !this.options.mock && Date.parse(result.expiresAt) <= Date.now() || this.options.mock && (result.sha256.toLowerCase() !== SEP_MEDIA_MOCK_PNG_SHA256 || result.width !== 1 || result.height !== 1)) throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
    return result
  }

  async quote(input: Omit<VideoRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<VideoQuote> {
    const request = parse(videoRequestSchema, input, 'VIDEO_INVALID_REQUEST')
    const value = await this.json('/quotes', 'POST', request, videoQuoteResponseSchema, signal)
    return { quoteId: value.quoteId, requestHash: value.semanticSha256.toLowerCase(), expiresAt: Date.parse(value.expiresAt), status: value.pricingStatus, amount: value.amountCny, currency: value.mock ? 'MOCK' : 'CNY',
      ...(!value.mock ? { amountUsd: value.amountUsd, pricingVersion: value.pricingVersion, usdToCnyRate: value.usdToCnyRate, funding: value.funding } : {}) }
  }

  async submit(input: VideoRequest, signal: AbortSignal): Promise<VideoReceipt> {
    const request = parse(videoRequestWithIdentitySchema, input, 'VIDEO_INVALID_REQUEST')
    const receipt = await this.json('/requests', 'POST', request, videoReceiptSchema, signal)
    if (receipt.clientRequestId !== request.clientRequestId || receipt.profileId !== request.profileId || receipt.configVersion !== request.configVersion || receipt.operation !== request.operation) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
    return receipt
  }

  async findReceipt(clientRequestId: string, signal: AbortSignal): Promise<VideoReceipt | null> {
    const requestId = parse(id, clientRequestId, 'VIDEO_INVALID_REQUEST')
    try {
      const receipt = await this.json(`/requests/by-client-id/${requestId}`, 'GET', undefined, videoReceiptSchema, signal)
      if (receipt.clientRequestId !== requestId) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
      return receipt
    } catch (error) {
      if (error instanceof SepVideoGatewayError && error.statusCode === 404) return null
      throw error
    }
  }

  async getReceipt(receiptId: string, signal: AbortSignal): Promise<VideoReceipt> {
    const receipt = await this.json(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}`, 'GET', undefined, videoReceiptSchema, signal)
    if (receipt.receiptId !== receiptId) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
    return receipt
  }

  async cancel(receiptId: string, signal: AbortSignal): Promise<void> {
    if (!this.options.mock) {
      const receipt = await this.json(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}/cancel`, 'POST', {}, videoReceiptSchema, signal)
      if (receipt.receiptId !== receiptId) throw new SepVideoGatewayError('VIDEO_RECEIPT_MISMATCH')
      return
    }
    const response = await this.request(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}/cancel`, 'POST', {}, 'application/json', signal)
    this.discard(response)
    throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
  }

  async content(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    if (!this.options.mock) return this.realContent(receiptId, outputId, signal)
    const response = await this.request(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}/outputs/${parse(id, outputId, 'VIDEO_INVALID_REQUEST')}/content`, 'GET', undefined, 'video/mp4', signal)
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
        throw new SepVideoGatewayError('VIDEO_NETWORK_ERROR')
      } finally {
        signal.removeEventListener('abort', onAbort)
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    })()
  }

  private async realContent(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    parse(id, outputId, 'VIDEO_INVALID_REQUEST')
    const receipt = await this.getReceipt(receiptId, signal)
    const output = receipt.outputs.find(item => item.outputId === outputId)
    if (!output || !receipt.recovery.canDownload || output.byteLength > MAX_REAL_VIDEO_BYTES || output.expiresAt !== null && Date.parse(output.expiresAt) <= Date.now()) throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
    const response = await this.request(`/requests/${receiptId}/outputs/${outputId}/content`, 'GET', undefined, output.mimeType, signal)
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
        throw new SepVideoGatewayError('VIDEO_NETWORK_ERROR')
      } finally {
        signal.removeEventListener('abort', onAbort)
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    })()
  }

  private async request(path: string, method: 'GET' | 'POST', body: unknown, accept: string, signal: AbortSignal): Promise<Response> {
    let token: string
    try {
      token = await abortable(signal, () => this.options.token(this.options.subscriptionId, signal))
    } catch (error) {
      if (signal.aborted) throw new SepVideoGatewayError('VIDEO_ABORTED')
      if (error instanceof AppError) {
        if (error.code === 'NETWORK_ERROR') throw new SepVideoGatewayError('VIDEO_NETWORK_ERROR')
        if (error.code === 'PERMISSION_DENIED') throw new SepVideoGatewayError('VIDEO_AUTH_FAILED', 403)
        if (error.code === 'RATE_LIMITED') throw new SepVideoGatewayError('VIDEO_AUTH_RATE_LIMITED', 429)
        if (error.code === 'SERVICE_UNAVAILABLE') throw new SepVideoGatewayError('VIDEO_AUTH_UNAVAILABLE', 503)
      }
      throw new SepVideoGatewayError('VIDEO_AUTH_FAILED', 401)
    }
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) throw new SepVideoGatewayError('VIDEO_AUTH_FAILED', 401)
    const multipart = body instanceof FormData
    let response: Response
    try {
      response = await abortable(signal, () => this.fetcher(`${this.root}${path}`, {
        method, signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${token}`, Accept: accept, ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      }))
    } catch {
      throw new SepVideoGatewayError(signal.aborted ? 'VIDEO_ABORTED' : 'VIDEO_NETWORK_ERROR')
    }
    if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
      this.discard(response)
      throw new SepVideoGatewayError('VIDEO_REDIRECT_BLOCKED')
    }
    if (!response.ok) {
      this.discard(response)
      // Do not surface provider bodies, URLs or credentials in errors. Never retry a POST.
      throw new SepVideoGatewayError('VIDEO_HTTP_ERROR', response.status)
    }
    return response
  }

  private async json<T>(path: string, method: 'GET' | 'POST', body: unknown, contract: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const response = await this.request(path, method, body, 'application/json', signal)
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
