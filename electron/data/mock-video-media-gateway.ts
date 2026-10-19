import { createHash } from 'node:crypto'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoRequestSchema, videoRequestWithIdentitySchema, videoReceiptSchema, type VideoGatewayPort, type VideoQuote, type VideoReceipt, type VideoRequest } from '../../src/shared/video-media'

export const MOCK_VIDEO_BYTES = Buffer.from(fixture.mediaFixture.base64, 'base64')
export const MOCK_VIDEO_SHA256 = fixture.mediaFixture.sha256

interface VideoRecord {
  hash: string
  receipt: VideoReceipt
}

export type MockVideoScenario = 'success' | 'failed' | 'partial' | 'partial-expired' | 'submission-unknown' | 'expired' | 'rejected' | 'corrupt-download'

export class MockVideoGatewayError extends Error {
  constructor(readonly code: string) {
    super(`Mock video request failed (${code}).`)
    this.name = 'MockVideoGatewayError'
  }
}

/** Explicit local test fixture. Never enables production execution or billing. */
export class MockVideoMediaGateway implements VideoGatewayPort {
  readonly calls = { quote: 0, submit: 0, findReceipt: 0, getReceipt: 0, content: 0 }
  private readonly records = new Map<string, VideoRecord>()
  private readonly quotes = new Map<string, VideoQuote>()

  constructor(private readonly scenario: MockVideoScenario = 'success', private readonly now: () => number = Date.now) {}

  async quote(input: Omit<VideoRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<VideoQuote> {
    signal.throwIfAborted()
    const request = videoRequestSchema.parse(input)
    this.validateProfile(request)
    this.calls.quote++
    const quote: VideoQuote = { quoteId: `video-quote-${this.calls.quote}`, requestHash: hashRequest(request), expiresAt: this.now() + 60_000, status: 'quoted', amount: '0.000000', currency: 'MOCK' }
    this.quotes.set(quote.quoteId, quote)
    return structuredClone(quote)
  }

  async submit(input: VideoRequest, signal: AbortSignal): Promise<VideoReceipt> {
    signal.throwIfAborted()
    const request = videoRequestWithIdentitySchema.parse(input)
    const { clientRequestId, quoteId, ...body } = request
    const hash = hashRequest(body)
    this.calls.submit++
    const existing = this.records.get(clientRequestId)
    if (existing) {
      if (existing.hash !== hash) throw new MockVideoGatewayError('IDEMPOTENCY_CONFLICT')
      return structuredClone(this.expire(existing.receipt))
    }
    this.validateProfile(body)
    const quote = this.quotes.get(quoteId)
    if (!quote || quote.expiresAt <= this.now()) throw new MockVideoGatewayError('QUOTE_EXPIRED')
    if (quote.requestHash !== hash) throw new MockVideoGatewayError('QUOTE_MISMATCH')
    if (this.scenario === 'rejected') throw new MockVideoGatewayError('MOCK_VIDEO_REJECTED')
    const receipt = videoReceiptSchema.parse({
      ...fixture.receipt, receiptId: `video-receipt-${this.records.size + 1}`, clientRequestId,
      profileId: request.profileId, configVersion: request.configVersion, operation: request.operation,
      status: this.scenario === 'submission-unknown' ? 'SUBMISSION_UNKNOWN' : 'QUEUED', pollAfterMs: 1,
    })
    this.records.set(clientRequestId, { hash, receipt })
    if (this.scenario === 'submission-unknown') throw new MockVideoGatewayError('MOCK_SUBMISSION_UNKNOWN')
    return structuredClone(receipt)
  }

  async findReceipt(clientRequestId: string, signal: AbortSignal): Promise<VideoReceipt | null> {
    signal.throwIfAborted()
    this.calls.findReceipt++
    const record = this.records.get(clientRequestId)
    return record ? structuredClone(this.expire(record.receipt)) : null
  }

  async getReceipt(receiptId: string, signal: AbortSignal): Promise<VideoReceipt> {
    signal.throwIfAborted()
    this.calls.getReceipt++
    const record = this.record(receiptId)
    if (record.receipt.status === 'QUEUED' || record.receipt.status === 'SUBMISSION_UNKNOWN') {
      record.receipt.status = 'RUNNING'
    } else if (record.receipt.status === 'RUNNING') {
      const success = this.scenario !== 'failed'
      record.receipt = videoReceiptSchema.parse({
        ...record.receipt, status: !success ? 'FAILED' : ['partial', 'partial-expired'].includes(this.scenario) ? 'PARTIAL_SUCCEEDED' : 'SUCCEEDED',
        pollAfterMs: null,
        recovery: { canQuery: false, canCancel: false, canDownload: success },
        errorCode: !success ? 'MOCK_VIDEO_FAILED' : this.scenario === 'partial' ? 'MOCK_PARTIAL_OUTPUT' : null,
        outputs: !success ? [] : [{
          ...fixture.output, outputId: `${receiptId}-output-1`,
          expiresAt: new Date(this.now() + (['expired', 'partial-expired'].includes(this.scenario) ? -1 : 86_400_000)).toISOString(),
        }, ...(this.scenario === 'partial-expired' ? [{ ...fixture.output, outputId: `${receiptId}-output-2`, expiresAt: new Date(this.now() + 86_400_000).toISOString() }] : [])],
      })
    }
    return structuredClone(this.expire(record.receipt))
  }

  async content(receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    signal.throwIfAborted()
    this.calls.content++
    const receipt = this.expire(this.record(receiptId).receipt)
    const output = receipt.outputs.find(output => output.outputId === outputId)
    if (!receipt.recovery.canDownload || !output || (output.expiresAt !== null && Date.parse(output.expiresAt) <= this.now())) throw new MockVideoGatewayError('OUTPUT_UNAVAILABLE')
    const bytes = Buffer.from(MOCK_VIDEO_BYTES)
    if (this.scenario === 'corrupt-download') bytes[bytes.length - 1] ^= 0xff
    return (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        signal.throwIfAborted()
        yield bytes.subarray(offset, offset + 1024)
      }
    })()
  }

  private record(receiptId: string): VideoRecord {
    const record = [...this.records.values()].find(item => item.receipt.receiptId === receiptId)
    if (!record) throw new MockVideoGatewayError('RECEIPT_NOT_FOUND')
    return record
  }

  private expire(receipt: VideoReceipt): VideoReceipt {
    if (receipt.recovery.canDownload && receipt.outputs.length > 0 && receipt.outputs.every(output => output.expiresAt !== null && Date.parse(output.expiresAt) <= this.now())) {
      receipt.status = 'RESULT_EXPIRED'
      receipt.errorCode = 'RESULT_EXPIRED'
      receipt.recovery = { canQuery: false, canCancel: false, canDownload: false }
    }
    return receipt
  }

  private validateProfile(request: Omit<VideoRequest, 'clientRequestId' | 'quoteId'>): void {
    const expected = fixture.quoteRequest
    if (request.profileId !== expected.profileId || request.configVersion !== expected.configVersion || request.operation !== expected.operation || JSON.stringify(request.parameters) !== JSON.stringify(videoRequestSchema.parse(expected).parameters)) {
      throw new MockVideoGatewayError('UNSUPPORTED_VIDEO_PARAMETERS')
    }
  }
}

function hashRequest(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}
