import { createHash } from 'node:crypto'
import type { MediaGenerationStatus } from '../../src/shared/media'
import type { MediaCapabilities, MediaGatewayPort, MediaOutput, MediaQuote, MediaReceipt, MediaRequest } from '../domain/media'
import { inspectMediaImage } from './media-image'

export const MOCK_MEDIA_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
export const MOCK_MEDIA_PNG = Buffer.from(MOCK_MEDIA_PNG_BASE64, 'base64')
export const MOCK_MEDIA_PNG_SHA256 = createHash('sha256').update(MOCK_MEDIA_PNG).digest('hex')
export const MOCK_MEDIA_CAPABILITIES: MediaCapabilities = {
  protocolVersion: 1,
  tools: ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'],
  profiles: [{
    profileId: 'mock-image', kind: 'image', displayName: 'Local mock image', configVersion: 'mock-v1',
    operations: ['generate', 'edit'], executionMode: 'async-query',
    capabilities: { referenceImage: true, cancel: true, recoverByRequestId: true },
    allowedAspectRatios: ['1:1'], allowedSizes: ['small'], allowedQualities: ['standard'], maxCount: 4,
  }],
}

export interface MockMediaGatewayOptions {
  quote?: Partial<MediaQuote>
  initialStatus?: MediaGenerationStatus
  pollStatuses?: MediaGenerationStatus[]
  submitResponseLost?: boolean
  missingFinds?: number
  contentFailures?: number
}

interface MockReceipt {
  subscriptionId: string
  receipt: MediaReceipt
  outputs: MediaOutput[]
  poll: number
}

/** Fully local fixture adapter. It neither contacts providers nor performs billing. */
export class MockMediaGateway implements MediaGatewayPort {
  readonly calls = {
    uploadReference: [] as { subscriptionId: string; sha256: string; bytes: Uint8Array }[],
    quote: [] as { subscriptionId: string; request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'> }[],
    submit: [] as { subscriptionId: string; request: MediaRequest }[],
    findReceipt: [] as { subscriptionId: string; clientRequestId: string }[],
    getReceipt: [] as { subscriptionId: string; receiptId: string }[],
    content: [] as { subscriptionId: string; receiptId: string; outputId: string }[],
    cancel: [] as { subscriptionId: string; receiptId: string }[],
  }
  contentFailures: number
  private missingFinds: number
  private readonly receipts = new Map<string, MockReceipt>()
  private readonly requests = new Map<string, string>()

  constructor(private readonly options: MockMediaGatewayOptions = {}) {
    this.contentFailures = options.contentFailures ?? 0
    this.missingFinds = options.missingFinds ?? 0
  }

  async uploadReference(subscriptionId: string, input: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp'; sha256: string }, signal: AbortSignal) {
    signal.throwIfAborted()
    const bytes = Buffer.from(input.bytes)
    if (inspectMediaImage(bytes).mime !== input.mime || createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('Mock reference integrity mismatch.')
    this.calls.uploadReference.push({ subscriptionId, sha256: input.sha256, bytes })
    return { referenceId: `mock-reference-${input.sha256}`, sha256: input.sha256, expiresAt: Date.now() + 60_000 }
  }

  async quote(subscriptionId: string, request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<MediaQuote> {
    signal.throwIfAborted()
    this.calls.quote.push({ subscriptionId, request: structuredClone(request) })
    return { quoteId: `mock-quote-${this.calls.quote.length}`, requestHash: request.requestHash, expiresAt: Date.now() + 60_000,
      status: 'quoted', amount: '0', currency: 'MOCK', authorized: true, budgetAuthorized: true, allowUnknownCost: false, ...this.options.quote }
  }

  async submit(subscriptionId: string, request: MediaRequest, signal: AbortSignal): Promise<MediaReceipt> {
    signal.throwIfAborted()
    this.calls.submit.push({ subscriptionId, request: structuredClone(request) })
    const key = JSON.stringify([subscriptionId, request.clientRequestId])
    const existingId = this.requests.get(key)
    if (existingId) return this.result(this.record(subscriptionId, existingId))
    const receiptId = `mock-receipt-${this.receipts.size + 1}`
    const outputs = Array.from({ length: request.parameters.count }, (_, index): MediaOutput => ({
      outputId: `${receiptId}-output-${index + 1}`, mime: 'image/png', size: MOCK_MEDIA_PNG.length,
      width: 1, height: 1, sha256: MOCK_MEDIA_PNG_SHA256, expiresAt: null,
    }))
    const record: MockReceipt = { subscriptionId, outputs, poll: 0, receipt: {
      receiptId, clientRequestId: request.clientRequestId, profileId: request.profileId, configVersion: request.configVersion,
      status: this.options.initialStatus ?? 'QUEUED', pollAfterMs: 0, outputs: [], billingStatus: 'NOT_BILLED_MOCK',
    } }
    this.receipts.set(receiptId, record)
    this.requests.set(key, receiptId)
    if (this.options.submitResponseLost) throw new Error('Mock submit response lost after acceptance.')
    return this.result(record)
  }

  async findReceipt(subscriptionId: string, clientRequestId: string, signal: AbortSignal): Promise<MediaReceipt | null> {
    signal.throwIfAborted()
    this.calls.findReceipt.push({ subscriptionId, clientRequestId })
    if (this.missingFinds > 0) { this.missingFinds--; return null }
    const id = this.requests.get(JSON.stringify([subscriptionId, clientRequestId]))
    return id ? this.result(this.record(subscriptionId, id)) : null
  }

  async getReceipt(subscriptionId: string, receiptId: string, signal: AbortSignal): Promise<MediaReceipt> {
    signal.throwIfAborted()
    this.calls.getReceipt.push({ subscriptionId, receiptId })
    const record = this.record(subscriptionId, receiptId)
    if (!['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(record.receipt.status)) {
      const sequence = this.options.pollStatuses ?? ['RUNNING', 'SUCCEEDED']
      record.receipt.status = sequence[Math.min(record.poll++, sequence.length - 1)] ?? record.receipt.status
    }
    return this.result(record)
  }

  async content(subscriptionId: string, receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    signal.throwIfAborted()
    this.calls.content.push({ subscriptionId, receiptId, outputId })
    const record = this.record(subscriptionId, receiptId)
    if (!['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(record.receipt.status) || !record.outputs.some(output => output.outputId === outputId)) throw new Error('Mock output unavailable.')
    if (this.contentFailures > 0) { this.contentFailures--; throw new Error('Mock download failed.') }
    const bytes = Buffer.from(MOCK_MEDIA_PNG_BASE64, 'base64')
    return (async function* () { signal.throwIfAborted(); yield bytes.subarray(0, 16); signal.throwIfAborted(); yield bytes.subarray(16) })()
  }

  async cancel(subscriptionId: string, receiptId: string, signal: AbortSignal): Promise<MediaReceipt> {
    signal.throwIfAborted()
    this.calls.cancel.push({ subscriptionId, receiptId })
    const record = this.record(subscriptionId, receiptId)
    record.receipt.status = 'CANCELLED'
    return this.result(record)
  }

  private record(subscriptionId: string, receiptId: string): MockReceipt {
    const record = this.receipts.get(receiptId)
    if (!record || record.subscriptionId !== subscriptionId) throw new Error('Mock receipt is not owned by this subscription.')
    return record
  }

  private result(record: MockReceipt): MediaReceipt {
    const deliverable = ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(record.receipt.status)
    return structuredClone({ ...record.receipt, outputs: deliverable ? record.outputs : [] })
  }
}
