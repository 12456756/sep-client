import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { ImageMime, MediaCapabilities, MediaGatewayPort, MediaQuote, MediaRequest } from '../domain/media'
import { mediaCapabilitiesSchema } from '../common/platform/media-contract'
import {
  SEP_MEDIA_MOCK_PNG_BASE64, SEP_MEDIA_MOCK_PNG_SHA256, SEP_MEDIA_MOCK_PNG_BYTES,
  SEP_MEDIA_JSON_BUDGET, SEP_MEDIA_CONTENT_BUDGET,
  sepMediaGatewayIdSchema, sepMediaGatewayProfilesSchema, sepMediaGatewayReferenceSchema,
  sepMediaGatewayQuoteSchema, sepMediaGatewayReceiptSchema, sepMediaGatewayHttpErrorSchema,
  sepMediaGatewayQuoteRequestSchema, sepMediaGatewayRequestSchema,
  sepMediaGatewayLocalParametersSchema, sepMediaGatewayRequestHashSchema,
  type SepMediaGatewayReceipt, type SepMediaGatewayHttpErrorCode,
} from '../common/platform/sep-media-gateway-contract'
import { inspectMediaImage } from './media-image'
import { AppError } from '../errors/app-error'
import type { ErrorCode } from '../errors/error-codes'

export interface SepMediaGatewayOptions {
  baseUrl: string
  token: (subscriptionId: string, signal: AbortSignal) => Promise<string>
  fetch?: typeof fetch
}

export type SepMediaGatewayErrorCode = SepMediaGatewayHttpErrorCode
  | 'MEDIA_INVALID_BASE_URL' | 'MEDIA_INVALID_REQUEST' | 'MEDIA_INVALID_RESPONSE'
  | 'MEDIA_RESPONSE_TOO_LARGE' | 'MEDIA_REDIRECT_BLOCKED' | 'MEDIA_NETWORK_ERROR'
  | 'MEDIA_AUTH_FAILED' | 'MEDIA_ABORTED' | 'MEDIA_HTTP_ERROR' | 'MEDIA_INTEGRITY_MISMATCH'

function appCode(gatewayCode: SepMediaGatewayErrorCode, statusCode: number): ErrorCode {
  if (statusCode === 401 || ['AUTH_REQUIRED', 'UNAUTHORIZED', 'MEDIA_AUTH_FAILED'].includes(gatewayCode)) return 'AUTH_REQUIRED'
  if (statusCode === 403 || ['MEDIA_FORBIDDEN', 'FORBIDDEN', 'PERMISSION_DENIED', 'BUDGET_EXCEEDED'].includes(gatewayCode)) return 'PERMISSION_DENIED'
  if (['MEDIA_RATE_LIMITED', 'RATE_LIMITED'].includes(gatewayCode)) return 'RATE_LIMITED'
  if (gatewayCode === 'MEDIA_NOT_FOUND') return 'NOT_FOUND'
  if (gatewayCode === 'MEDIA_NETWORK_ERROR') return 'NETWORK_ERROR'
  if (['MEDIA_INVALID_BASE_URL', 'MEDIA_INVALID_REQUEST', 'INVALID_PARAMETER', 'INVALID_REFERENCE',
    'UNSUPPORTED_MEDIA_PARAMETERS', 'REQUEST_BODY_TOO_LARGE'].includes(gatewayCode)) return 'INVALID_ARGUMENT'
  if (['QUOTE_EXPIRED', 'REFERENCE_EXPIRED', 'CONFIG_CHANGED', 'RESULT_EXPIRED', 'CANCEL_UNSUPPORTED',
    'IDEMPOTENCY_CONFLICT', 'MEDIA_INTEGRITY_MISMATCH', 'MEDIA_ABORTED'].includes(gatewayCode)) return 'INVALID_STATE'
  return 'SERVICE_UNAVAILABLE'
}

export class SepMediaGatewayError extends AppError {
  constructor(readonly gatewayCode: SepMediaGatewayErrorCode, readonly statusCode: number = 0) {
    super(appCode(gatewayCode, statusCode), { message: `SEP mock media request failed (${gatewayCode}).` })
    this.name = gatewayCode === 'MEDIA_ABORTED' ? 'AbortError' : 'SepMediaGatewayError'
  }
}

export interface SepMediaProfiles {
  capabilities: MediaCapabilities
  referenceFixtureBase64: string
  referenceFixtureSha256: string
  persistence: 'database'
}

export type SepMediaReceipt = Omit<SepMediaGatewayReceipt, 'mock' | 'outputs' | 'executionMode'> & {
  outputs: {
    outputId: string; mime: 'image/png'; size: number; width: number; height: number
    sha256: string; expiresAt: number | null
  }[]
}

const fixture = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new SepMediaGatewayError('MEDIA_ABORTED')
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: SepMediaGatewayErrorCode = 'MEDIA_INVALID_RESPONSE'): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new SepMediaGatewayError(code)
  return result.data
}

async function abortable<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  checkAbort(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SepMediaGatewayError('MEDIA_ABORTED'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => { checkAbort(signal); return action() }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function apiRoot(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || baseUrl.includes('?') || baseUrl.includes('#')) throw new Error()
    return url.href.replace(/\/+$/, '')
  } catch {
    throw new SepMediaGatewayError('MEDIA_INVALID_BASE_URL')
  }
}

function receipt(value: SepMediaGatewayReceipt): SepMediaReceipt {
  const { mock: _mock, executionMode: _executionMode, outputs, ...rest } = value
  return { ...rest, outputs: outputs.map(output => ({
    outputId: output.outputId, mime: output.mimeType, size: output.byteLength,
    width: output.width, height: output.height, sha256: output.sha256.toLowerCase(),
    expiresAt: output.expiresAt === null ? null : Date.parse(output.expiresAt),
  })) }
}

/** Explicit development mock port. Never use production runtime profiles to enable it. */
export class SepMediaGateway implements MediaGatewayPort {
  readonly quoteRequiresUploadedReferences = true
  private readonly root: string
  private readonly fetcher: typeof fetch

  constructor(private readonly options: SepMediaGatewayOptions) {
    this.root = `${apiRoot(options.baseUrl)}/gateway/v1/media`
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async profiles(subscriptionId: string, signal: AbortSignal): Promise<SepMediaProfiles> {
    const value = await this.json(subscriptionId, '/profiles', 'GET', undefined, sepMediaGatewayProfilesSchema, signal)
    const capabilities = parse(mediaCapabilitiesSchema, {
      protocolVersion: 1,
      tools: ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'],
      profiles: value.profiles.map(profile => ({
        profileId: profile.profileId, kind: 'image', displayName: profile.profileId,
        configVersion: profile.configVersion, operations: profile.operations, executionMode: profile.executionMode,
        capabilities: {
          referenceImage: profile.capabilities.supportsReferenceImage,
          // These are the explicit mock scenario guarantees, not production-mode inferences.
          cancel: profile.executionMode === 'async-query' && profile.profileId !== 'mock-no-cancel',
          recoverByRequestId: true,
        },
        allowedAspectRatios: ['1:1'], allowedSizes: profile.capabilities.sizes, maxCount: profile.capabilities.maxOutputs,
      })),
    })
    return {
      capabilities, referenceFixtureBase64: value.referenceFixtureBase64,
      referenceFixtureSha256: value.referenceFixtureSha256, persistence: value.persistence,
    }
  }

  async uploadReference(subscriptionId: string, input: { bytes: Uint8Array; mime: ImageMime; sha256: string }, signal: AbortSignal) {
    checkAbort(signal)
    if (input.mime !== 'image/png' || input.bytes.byteLength !== SEP_MEDIA_MOCK_PNG_BYTES
      || input.sha256 !== SEP_MEDIA_MOCK_PNG_SHA256 || !fixture.equals(input.bytes)) {
      throw new SepMediaGatewayError('INVALID_REFERENCE')
    }
    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(input.bytes)], { type: 'image/png' }), 'sep-mock-reference.png')
    const value = await this.json(subscriptionId, '/references', 'POST', body, sepMediaGatewayReferenceSchema, signal)
    if (value.sha256.toLowerCase() !== SEP_MEDIA_MOCK_PNG_SHA256 || value.byteLength !== fixture.length
      || value.width !== 1 || value.height !== 1) throw new SepMediaGatewayError('MEDIA_INTEGRITY_MISMATCH')
    return { referenceId: value.referenceId, sha256: value.sha256.toLowerCase(), expiresAt: Date.parse(value.expiresAt) }
  }

  async quote(subscriptionId: string, request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<MediaQuote> {
    checkAbort(signal)
    const hash = parse(sepMediaGatewayRequestHashSchema, request.requestHash, 'MEDIA_INVALID_REQUEST')
    const body = parse(sepMediaGatewayQuoteRequestSchema, this.quoteBody(request), 'MEDIA_INVALID_REQUEST')
    const value = await this.json(subscriptionId, '/quotes', 'POST', body, sepMediaGatewayQuoteSchema, signal)
    if (value.semanticSha256.toLowerCase() !== hash) throw new SepMediaGatewayError('MEDIA_INTEGRITY_MISMATCH')
    return {
      quoteId: value.quoteId, requestHash: value.semanticSha256.toLowerCase(), expiresAt: Date.parse(value.expiresAt),
      status: value.pricingStatus, amount: value.amountCny, currency: 'CNY',
      // Mock quotations never debit a wallet; these flags do not authorize real spending.
      authorized: true, budgetAuthorized: true, allowUnknownCost: false,
    }
  }

  async submit(subscriptionId: string, request: MediaRequest, signal: AbortSignal): Promise<SepMediaReceipt> {
    checkAbort(signal)
    const body = parse(sepMediaGatewayRequestSchema, {
      ...this.quoteBody(request), clientRequestId: request.clientRequestId, quoteId: request.quoteId,
    }, 'MEDIA_INVALID_REQUEST')
    return receipt(await this.json(subscriptionId, '/requests', 'POST', body, sepMediaGatewayReceiptSchema, signal))
  }

  async findReceipt(subscriptionId: string, clientRequestId: string, signal: AbortSignal): Promise<SepMediaReceipt | null> {
    checkAbort(signal)
    try {
      return receipt(await this.json(subscriptionId, `/requests/by-client-id/${this.id(clientRequestId)}`, 'GET', undefined, sepMediaGatewayReceiptSchema, signal))
    } catch (error) {
      if (error instanceof SepMediaGatewayError && error.statusCode === 404 && error.gatewayCode === 'MEDIA_NOT_FOUND') return null
      throw error
    }
  }

  async getReceipt(subscriptionId: string, receiptId: string, signal: AbortSignal): Promise<SepMediaReceipt> {
    checkAbort(signal)
    return receipt(await this.json(subscriptionId, `/requests/${this.id(receiptId)}`, 'GET', undefined, sepMediaGatewayReceiptSchema, signal))
  }

  async cancel(subscriptionId: string, receiptId: string, signal: AbortSignal): Promise<SepMediaReceipt> {
    checkAbort(signal)
    return receipt(await this.json(subscriptionId, `/requests/${this.id(receiptId)}/cancel`, 'POST', {}, sepMediaGatewayReceiptSchema, signal))
  }

  async content(subscriptionId: string, receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    checkAbort(signal)
    const response = await this.request(subscriptionId, `/requests/${this.id(receiptId)}/outputs/${this.id(outputId)}/content`, 'GET', undefined, 'image/png', signal)
    const length = this.length(response, SEP_MEDIA_CONTENT_BUDGET)
    if (this.mime(response) !== 'image/png' || response.headers.get('X-SEP-Media-Mock') !== 'true'
      || response.headers.get('X-SHA256')?.toLowerCase() !== SEP_MEDIA_MOCK_PNG_SHA256) {
      this.discard(response)
      throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE')
    const onAbort = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    return (async function* () {
      let size = 0
      const hash = createHash('sha256')
      try {
        while (true) {
          checkAbort(signal)
          const chunk = await abortable(signal, () => reader.read())
          checkAbort(signal)
          if (chunk.done) break
          const nextSize = size + chunk.value.byteLength
          if (nextSize > SEP_MEDIA_CONTENT_BUDGET) throw new SepMediaGatewayError('MEDIA_RESPONSE_TOO_LARGE')
          // No JSON, forged PNG or non-fixture bytes ever reach the local output store.
          if (nextSize > fixture.length || !fixture.subarray(size, nextSize).equals(chunk.value)) {
            throw new SepMediaGatewayError('MEDIA_INTEGRITY_MISMATCH')
          }
          size = nextSize
          hash.update(chunk.value)
          yield chunk.value
        }
        if (size !== fixture.length || (length !== null && size !== length)
          || hash.digest('hex') !== SEP_MEDIA_MOCK_PNG_SHA256 || inspectMediaImage(fixture).mime !== 'image/png') {
          throw new SepMediaGatewayError('MEDIA_INTEGRITY_MISMATCH')
        }
      } catch (error) {
        if (signal.aborted) throw new SepMediaGatewayError('MEDIA_ABORTED')
        if (error instanceof SepMediaGatewayError) throw error
        throw new SepMediaGatewayError('MEDIA_NETWORK_ERROR')
      } finally {
        signal.removeEventListener('abort', onAbort)
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    })()
  }

  private id(value: string): string {
    return parse(sepMediaGatewayIdSchema, value, 'MEDIA_INVALID_REQUEST')
  }

  private quoteBody(request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'>) {
    const parameters = parse(sepMediaGatewayLocalParametersSchema, request.parameters, 'UNSUPPORTED_MEDIA_PARAMETERS')
    return {
      profileId: request.profileId, configVersion: request.configVersion, operation: request.operation,
      referenceIds: request.referenceIds, creativeBrief: request.creativeBrief,
      parameters: { size: parameters.size ?? '1x1', count: parameters.count },
    }
  }

  private async request(subscriptionId: string, path: string, method: 'GET' | 'POST', body: unknown, accept: string, signal: AbortSignal): Promise<Response> {
    checkAbort(signal)
    this.id(subscriptionId)
    let token: string
    try {
      token = await abortable(signal, () => this.options.token(subscriptionId, signal))
    } catch (error) {
      if (signal.aborted) throw new SepMediaGatewayError('MEDIA_ABORTED')
      if (error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')) {
        throw new SepMediaGatewayError(error.code)
      }
      throw new SepMediaGatewayError(signal.aborted ? 'MEDIA_ABORTED' : 'MEDIA_AUTH_FAILED')
    }
    checkAbort(signal)
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) {
      throw new SepMediaGatewayError('MEDIA_AUTH_FAILED')
    }
    const multipart = body instanceof FormData
    const payload = body === undefined ? undefined : multipart ? body : JSON.stringify(body)
    if (typeof payload === 'string' && Buffer.byteLength(payload) > SEP_MEDIA_JSON_BUDGET) throw new SepMediaGatewayError('MEDIA_INVALID_REQUEST')
    let response: Response
    try {
      response = await abortable(signal, () => this.fetcher(`${this.root}${path}`, {
        method, signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${token}`, Accept: accept,
          ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: payload,
      }))
    } catch {
      throw new SepMediaGatewayError(signal.aborted ? 'MEDIA_ABORTED' : 'MEDIA_NETWORK_ERROR')
    }
    if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      this.discard(response)
      throw new SepMediaGatewayError('MEDIA_REDIRECT_BLOCKED', response.status)
    }
    if (!response.ok) {
      let value: unknown
      try {
        value = await this.readJson(response, signal)
      } catch (error) {
        if (error instanceof SepMediaGatewayError) throw new SepMediaGatewayError(error.gatewayCode, response.status)
        throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE', response.status)
      }
      const error = sepMediaGatewayHttpErrorSchema.safeParse(value)
      throw new SepMediaGatewayError(error.success ? error.data.error.code : response.status === 401 ? 'AUTH_REQUIRED'
        : response.status === 403 ? 'PERMISSION_DENIED' : 'MEDIA_HTTP_ERROR', response.status)
    }
    return response
  }

  private async json<T>(subscriptionId: string, path: string, method: 'GET' | 'POST', body: unknown, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const response = await this.request(subscriptionId, path, method, body, 'application/json', signal)
    return parse(schema, await this.readJson(response, signal))
  }

  private mime(response: Response): string {
    return (response.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase()
  }

  private length(response: Response, budget: number): number | null {
    const value = response.headers.get('Content-Length')
    if (value === null) return null
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      this.discard(response)
      throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE')
    }
    if (Number(value) > budget) {
      this.discard(response)
      throw new SepMediaGatewayError('MEDIA_RESPONSE_TOO_LARGE')
    }
    return Number(value)
  }

  private async readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const length = this.length(response, SEP_MEDIA_JSON_BUDGET)
    if (this.mime(response) !== 'application/json') {
      this.discard(response)
      throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await abortable(signal, () => reader.read())
        checkAbort(signal)
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > SEP_MEDIA_JSON_BUDGET) throw new SepMediaGatewayError('MEDIA_RESPONSE_TOO_LARGE')
        chunks.push(chunk.value)
      }
      if (length !== null && length !== size) throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE')
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
    } catch (error) {
      if (signal.aborted) throw new SepMediaGatewayError('MEDIA_ABORTED')
      if (error instanceof SepMediaGatewayError) throw error
      throw new SepMediaGatewayError('MEDIA_INVALID_RESPONSE')
    } finally {
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private discard(response: Response): void {
    void response.body?.cancel().catch(() => undefined)
  }
}
