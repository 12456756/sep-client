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

const id = schema.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const JSON_BUDGET = 256 * 1024
const referenceBytes = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
const videoBytes = Buffer.from(fixture.mediaFixture.base64, 'base64')

export class SepVideoGatewayError extends AppError {
  constructor(readonly gatewayCode: string, readonly statusCode = 0) {
    const code: ErrorCode = statusCode === 401 ? 'AUTH_REQUIRED' : statusCode === 403 ? 'PERMISSION_DENIED'
      : statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'INVALID_ARGUMENT' : statusCode === 409 || statusCode === 410 ? 'INVALID_STATE' : statusCode === 429 ? 'RATE_LIMITED'
        : gatewayCode === 'VIDEO_NETWORK_ERROR' ? 'NETWORK_ERROR' : gatewayCode === 'VIDEO_INVALID_REQUEST' ? 'INVALID_ARGUMENT' : 'SERVICE_UNAVAILABLE'
    super(code, { message: `SEP mock video request failed (${gatewayCode}).` })
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

/** Mock HTTP adapter, instantiated per subscription. It never reads production video runtime. */
export class SepMockVideoGateway implements VideoGatewayPort {
  private readonly root: string
  private readonly fetcher: typeof fetch

  constructor(private readonly options: SepMockVideoGatewayOptions) {
    try {
      const url = new URL(options.baseUrl)
      if (options.mock !== true || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || options.baseUrl.includes('?') || options.baseUrl.includes('#')) throw new Error()
      this.root = `${url.href.replace(/\/+$/, '')}/gateway/v1/media/video`
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
    if (!referenceBytes.equals(bytes)) throw new SepVideoGatewayError('VIDEO_INVALID_REQUEST')
    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'mock-video-reference.png')
    const result = await this.json('/references', 'POST', body, videoReferenceSchema, signal)
    if (result.sha256.toLowerCase() !== SEP_MEDIA_MOCK_PNG_SHA256 || result.byteLength !== bytes.length || result.width !== 1 || result.height !== 1) throw new SepVideoGatewayError('VIDEO_INTEGRITY_MISMATCH')
    return result
  }

  async quote(input: Omit<VideoRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<VideoQuote> {
    const request = parse(videoRequestSchema, input, 'VIDEO_INVALID_REQUEST')
    const value = await this.json('/quotes', 'POST', request, videoQuoteResponseSchema, signal)
    return { quoteId: value.quoteId, requestHash: value.semanticSha256.toLowerCase(), expiresAt: Date.parse(value.expiresAt), status: value.pricingStatus, amount: value.amountCny, currency: 'MOCK' }
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
    const response = await this.request(`/requests/${parse(id, receiptId, 'VIDEO_INVALID_REQUEST')}/cancel`, 'POST', {}, 'application/json', signal)
    this.discard(response)
    throw new SepVideoGatewayError('VIDEO_INVALID_RESPONSE')
  }

  async content(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
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
      return parse(contract, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown)
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
