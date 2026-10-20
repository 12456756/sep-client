/**
 * SYNTHETIC / MOCK ONLY. Parent-process fixture for isolated Electron integration.
 * No Nest, Electron imports, production persistence, model calls, or outbound I/O.
 * Bundle as an additional Electron-Vite main input; importing never starts a server.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import * as fixture from '../src/shared/fixtures/media-video-v1.json'
import {
  videoProfilesResponseSchema, videoQuoteResponseSchema, videoReceiptSchema,
  videoReferenceSchema, videoRequestSchema, videoRequestWithIdentitySchema,
  type VideoReceipt, type VideoRequest,
} from '../src/shared/video-media'
import { SEP_MEDIA_MOCK_PNG_BASE64, SEP_MEDIA_MOCK_PNG_SHA256 } from '../electron/common/platform/sep-media-gateway-contract'
import { MockVideoMediaGateway, MockVideoGatewayError, MOCK_VIDEO_SHA256 } from '../electron/data/mock-video-media-gateway'

/** Fixed fake employment token; never use a real credential with this fixture. */
export const VIDEO_MOCK_FIXTURE_TOKEN = 'synthetic-video-employment-token'
export const VIDEO_MOCK_FIXTURE_BODY_LIMIT = 64 * 1024
const API_PATH = '/api/gateway/v1/media/video'
const POLL_AFTER_MS = 300
const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
type Scenario = 'success' | 'partial' | 'partial-expired'

export interface VideoMockFixtureState {
  revoked: boolean
  disconnected: boolean
  corruptDownload: boolean
  holdQueries: boolean
  /** Captured on each incoming request, e.g. before-restart / after-restart. */
  phase: string
  /** Chosen for each NEW submission; existing jobs keep their original scenario. */
  scenario: Scenario
  counts: {
    /** Every HTTP attempt, including denied and invalid routes. */
    receivedRequests: number
    /** Content GET attempts, including denied ones. */
    receivedContent: number
    /** Endpoint attempt counters, incremented before authorization/fault checks. */
    profiles: number
    references: number
    quotes: number
    submit: number
    findReceipt: number
    getReceipt: number
    /** Successful HTTP content responses (including deliberately corrupt bytes). */
    content: number
    /** Every HTTP response with status >= 400. */
    denied: number
    heldQueries: number
    corruptDownloads: number
  }
}

export interface VideoMockFixture {
  /** SEP API root, including /api; pass directly to SepMockVideoGateway. */
  baseUrl: string
  close(): Promise<void>
  state: VideoMockFixtureState
  evidence(): unknown
}

interface Job {
  scenario: Scenario
  internalReceiptId: string
  receipt: VideoReceipt
}

interface RequestMarker {
  sequence: number
  phase: string
  method: string
  path: string
  status: number | null
  scenario: Scenario
  revoked: boolean
  disconnected: boolean
  holdQueries: boolean
  corruptDownload: boolean
  receiptId?: string
  receiptStatus?: VideoReceipt['status']
  code?: string
}

class FixtureHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new FixtureHttpError(400, 'INVALID_BODY_LENGTH')
  if (length !== undefined && Number(length) > VIDEO_MOCK_FIXTURE_BODY_LIMIT) throw new FixtureHttpError(413, 'REQUEST_BODY_TOO_LARGE')
  const chunks: Buffer[] = []
  let size = 0
  // Keep the socket alive long enough to send 413 for oversized chunked bodies.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > VIDEO_MOCK_FIXTURE_BODY_LIMIT) throw new FixtureHttpError(413, 'REQUEST_BODY_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new FixtureHttpError(415, 'JSON_REQUIRED')
  const bytes = await readBody(request)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw new FixtureHttpError(400, 'INVALID_JSON') }
}

function httpError(error: unknown): FixtureHttpError {
  if (error instanceof FixtureHttpError) return error
  if (error instanceof z.ZodError) return new FixtureHttpError(400, 'INVALID_VIDEO_REQUEST')
  if (error instanceof MockVideoGatewayError) {
    const status = error.code === 'RECEIPT_NOT_FOUND' || error.code === 'OUTPUT_UNAVAILABLE' ? 404
      : ['QUOTE_EXPIRED', 'QUOTE_MISMATCH', 'IDEMPOTENCY_CONFLICT'].includes(error.code) ? 409 : 400
    return new FixtureHttpError(status, error.code)
  }
  return new FixtureHttpError(500, 'SYNTHETIC_FIXTURE_ERROR')
}

/** Start one parent-owned, in-memory fixture. Only listens on 127.0.0.1:0. */
export async function startVideoMockFixture(): Promise<VideoMockFixture> {
  const namespace = `synthetic-${randomUUID()}`
  const state: VideoMockFixtureState = {
    revoked: false, disconnected: false, corruptDownload: false, holdQueries: false,
    scenario: 'success', phase: 'ready',
    counts: { receivedRequests: 0, receivedContent: 0, profiles: 0, references: 0, quotes: 0,
      submit: 0, findReceipt: 0, getReceipt: 0, content: 0, denied: 0, heldQueries: 0, corruptDownloads: 0 },
  }
  const gateways = { success: new MockVideoMediaGateway('success'), partial: new MockVideoMediaGateway('partial'),
    'partial-expired': new MockVideoMediaGateway('partial-expired') }
  // Quote all scenario gateways so the scenario can be selected at SUBMISSION.
  // Public IDs are unique across gateways, jobs, and concurrent fixture instances.
  const quotes = new Map<string, Record<Scenario, string>>()
  const references = new Map<string, number>()
  const jobs = new Map<string, Job>()
  const byReceipt = new Map<string, Job>()
  const markers: RequestMarker[] = []
  const abort = new AbortController()
  let quoteSequence = 0
  let referenceSequence = 0
  let droppedMarkers = 0
  let submissions = Promise.resolve()

  function wireReceipt(receipt: VideoReceipt, scenario: Scenario): VideoReceipt {
    return videoReceiptSchema.parse({
      ...receipt, receiptId: `${namespace}-${scenario}-${receipt.receiptId}`,
      pollAfterMs: receipt.recovery.canQuery ? POLL_AFTER_MS : null,
      outputs: receipt.outputs.map(output => ({ ...output, outputId: `${namespace}-${scenario}-${output.outputId}` })),
    })
  }

  function checkReferences(ids: string[]): void {
    for (const id of ids) {
      const expiry = references.get(id)
      if (expiry === undefined) throw new FixtureHttpError(400, 'INVALID_REFERENCE')
      if (expiry <= Date.now()) throw new FixtureHttpError(410, 'REFERENCE_EXPIRED')
    }
  }

  async function submit(input: VideoRequest, scenario: Scenario): Promise<VideoReceipt> {
    // Serialize concurrent replays across scenarios, preserving one client-ID ledger.
    let receipt: VideoReceipt | undefined
    const pending = submissions.then(async () => {
      const existing = jobs.get(input.clientRequestId)
      const chosen = existing?.scenario ?? scenario
      if (chosen !== 'success' && chosen !== 'partial' && chosen !== 'partial-expired') throw new FixtureHttpError(400, 'INVALID_SCENARIO')
      const internalQuote = quotes.get(input.quoteId)?.[chosen]
      if (!internalQuote && !existing) throw new FixtureHttpError(409, 'QUOTE_EXPIRED')
      if (!existing) checkReferences(input.referenceIds)
      const internal = await gateways[chosen].submit({ ...input, quoteId: internalQuote ?? input.quoteId }, abort.signal)
      receipt = wireReceipt(internal, chosen)
      const job: Job = existing ?? { scenario: chosen, internalReceiptId: internal.receiptId, receipt }
      job.receipt = receipt
      jobs.set(input.clientRequestId, job)
      byReceipt.set(receipt.receiptId, job)
    })
    submissions = pending.then(() => undefined, () => undefined)
    await pending
    return receipt!
  }

  function json(response: ServerResponse, marker: RequestMarker, status: number, body: unknown): void {
    const bytes = Buffer.from(JSON.stringify(body))
    marker.status = status
    if (status >= 400) state.counts.denied++
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
      'X-SEP-Media-Mock': 'true', 'Cache-Control': 'no-store' })
    response.end(bytes)
  }

  async function handle(request: IncomingMessage, response: ServerResponse, marker: RequestMarker): Promise<void> {
    try {
      if (state.revoked) throw new FixtureHttpError(403, 'MOCK_VIDEO_REVOKED')
      if (state.disconnected) throw new FixtureHttpError(503, 'MOCK_VIDEO_DISCONNECTED')
      if (request.headers.authorization !== `Bearer ${VIDEO_MOCK_FIXTURE_TOKEN}`) throw new FixtureHttpError(401, 'MOCK_AUTH_REQUIRED')
      const { method, path } = marker
      if (path === `${API_PATH}/profiles` && method === 'GET') {
        json(response, marker, 200, videoProfilesResponseSchema.parse({ mock: true, protocolVersion: 1,
          persistence: 'memory', billingStatus: 'MOCK_NOT_CHARGED', profiles: fixture.runtime.profiles }))
        return
      }
      if (path === `${API_PATH}/references` && method === 'POST') {
        const contentType = request.headers['content-type'] ?? ''
        if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new FixtureHttpError(415, 'MULTIPART_REQUIRED')
        const body = await readBody(request)
        let form: FormData
        try { form = await new Response(new Uint8Array(body), { headers: { 'Content-Type': contentType } }).formData() }
        catch { throw new FixtureHttpError(400, 'INVALID_REFERENCE') }
        const file = form.get('file')
        if ([...form.keys()].length !== 1 || !file || typeof file === 'string' || file.type !== 'image/png'
          || file.size !== png.length || !png.equals(Buffer.from(await file.arrayBuffer()))) throw new FixtureHttpError(400, 'INVALID_REFERENCE')
        const referenceId = `${namespace}-reference-${++referenceSequence}`
        const expiry = Date.now() + 86_400_000
        references.set(referenceId, expiry)
        json(response, marker, 201, videoReferenceSchema.parse({ mock: true, referenceId,
          expiresAt: new Date(expiry).toISOString(), mimeType: 'image/png', byteLength: png.length,
          sha256: SEP_MEDIA_MOCK_PNG_SHA256, width: 1, height: 1 }))
        return
      }
      if (path === `${API_PATH}/quotes` && method === 'POST') {
        const input = videoRequestSchema.parse(await readJson(request))
        checkReferences(input.referenceIds)
        const success = await gateways.success.quote(input, abort.signal)
        const partial = await gateways.partial.quote(input, abort.signal)
        const partialExpired = await gateways['partial-expired'].quote(input, abort.signal)
        const quoteId = `${namespace}-quote-${++quoteSequence}`
        quotes.set(quoteId, { success: success.quoteId, partial: partial.quoteId, 'partial-expired': partialExpired.quoteId })
        json(response, marker, 200, videoQuoteResponseSchema.parse({ mock: true, quoteId,
          semanticSha256: success.requestHash, expiresAt: new Date(success.expiresAt).toISOString(),
          pricingStatus: success.status, amountCny: success.amount, pricingVersion: 'mock-video-v1', billingStatus: 'MOCK_NOT_CHARGED' }))
        return
      }
      if (path === `${API_PATH}/requests` && method === 'POST') {
        const input = videoRequestWithIdentitySchema.parse(await readJson(request))
        const receipt = await submit(input, state.scenario)
        marker.scenario = jobs.get(input.clientRequestId)!.scenario
        marker.receiptId = receipt.receiptId
        marker.receiptStatus = receipt.status
        json(response, marker, 202, receipt)
        return
      }
      const find = path.match(/^\/api\/gateway\/v1\/media\/video\/requests\/by-client-id\/([a-zA-Z0-9_-]{1,128})$/)
      const query = path.match(/^\/api\/gateway\/v1\/media\/video\/requests\/([a-zA-Z0-9_-]{1,128})$/)
      if ((find || query) && method === 'GET') {
        const job = find ? jobs.get(find[1]!) : byReceipt.get(query![1]!)
        if (!job) throw new FixtureHttpError(404, 'RECEIPT_NOT_FOUND')
        const gateway = gateways[job.scenario]
        const internal = find || state.holdQueries
          ? await gateway.findReceipt(job.receipt.clientRequestId, abort.signal)
          : await gateway.getReceipt(job.internalReceiptId, abort.signal)
        if (!internal) throw new FixtureHttpError(404, 'RECEIPT_NOT_FOUND')
        if (state.holdQueries && internal.recovery.canQuery) state.counts.heldQueries++
        job.receipt = wireReceipt(internal, job.scenario)
        marker.scenario = job.scenario
        marker.receiptId = job.receipt.receiptId
        marker.receiptStatus = job.receipt.status
        json(response, marker, 200, job.receipt)
        return
      }
      const content = path.match(/^\/api\/gateway\/v1\/media\/video\/requests\/([a-zA-Z0-9_-]{1,128})\/outputs\/([a-zA-Z0-9_-]{1,128})\/content$/)
      if (content && method === 'GET') {
        const job = byReceipt.get(content[1]!)
        const output = job?.receipt.outputs.find(item => item.outputId === content[2])
        if (!job || !output) throw new FixtureHttpError(404, 'OUTPUT_UNAVAILABLE')
        const internalOutputId = output.outputId.slice(`${namespace}-${job.scenario}-`.length)
        const chunks: Uint8Array[] = []
        for await (const chunk of await gateways[job.scenario].content(job.internalReceiptId, internalOutputId, abort.signal)) chunks.push(chunk)
        const bytes = Buffer.concat(chunks)
        if (state.corruptDownload) { bytes[bytes.length - 1] ^= 0xff; state.counts.corruptDownloads++ }
        state.counts.content++
        marker.status = 200
        marker.scenario = job.scenario
        marker.receiptId = job.receipt.receiptId
        marker.receiptStatus = job.receipt.status
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length,
          'X-SEP-Media-Mock': 'true', 'X-SHA256': MOCK_VIDEO_SHA256, 'Cache-Control': 'no-store' })
        response.end(bytes)
        return
      }
      if (method === 'POST' && /^\/api\/gateway\/v1\/media\/video\/requests\/[a-zA-Z0-9_-]{1,128}\/cancel$/.test(path)) throw new FixtureHttpError(409, 'CANCEL_UNSUPPORTED')
      throw new FixtureHttpError(404, 'MOCK_ROUTE_NOT_FOUND')
    } catch (error) {
      request.resume()
      const failure = httpError(error)
      marker.code = failure.code
      if (!response.destroyed && !response.headersSent) json(response, marker, failure.status, { mock: true, error: { code: failure.code } })
    }
  }

  const server = createServer((request, response) => {
    const path = request.url ?? ''
    const method = request.method ?? ''
    const counts = state.counts
    counts.receivedRequests++
    if (method === 'GET' && /^\/api\/gateway\/v1\/media\/video\/requests\/[^/]+\/outputs\/[^/]+\/content$/.test(path)) counts.receivedContent++
    if (method === 'GET' && path === `${API_PATH}/profiles`) counts.profiles++
    if (method === 'POST' && path === `${API_PATH}/references`) counts.references++
    if (method === 'POST' && path === `${API_PATH}/quotes`) counts.quotes++
    if (method === 'POST' && path === `${API_PATH}/requests`) counts.submit++
    if (method === 'GET' && /^\/api\/gateway\/v1\/media\/video\/requests\/by-client-id\/[^/]+$/.test(path)) counts.findReceipt++
    if (method === 'GET' && /^\/api\/gateway\/v1\/media\/video\/requests\/[^/]+$/.test(path)) counts.getReceipt++
    const marker: RequestMarker = { sequence: counts.receivedRequests, phase: state.phase, method,
      // No untrusted URL/query data or body contents in evidence.
      path: path.startsWith(`${API_PATH}/`) && /^[a-zA-Z0-9_/-]+$/.test(path) && path.length <= 512 ? path : '[invalid-route]',
      status: null, scenario: state.scenario, revoked: state.revoked, disconnected: state.disconnected,
      holdQueries: state.holdQueries, corruptDownload: state.corruptDownload }
    if (markers.length === 4096) { markers.shift(); droppedMarkers++ }
    markers.push(marker)
    void handle(request, response, marker)
  })
  server.requestTimeout = 5_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 1_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('MOCK_FIXTURE_LISTEN_FAILED') }
  const baseUrl = `http://127.0.0.1:${address.port}/api`
  let closing: Promise<void> | undefined
  let closed = false
  return {
    baseUrl, state,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        abort.abort()
        server.close(error => { closed = true; if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
      return closing
    },
    evidence() {
      return structuredClone({ mock: true, simulationOnly: true, fixture: 'parent-process-loopback-video',
        persistence: 'parent-process-memory', baseUrl, closed, state,
        receipts: [...jobs.values()].map(job => ({ scenario: job.scenario, receipt: job.receipt })),
        gatewayCalls: { success: gateways.success.calls, partial: gateways.partial.calls, 'partial-expired': gateways['partial-expired'].calls },
        markers, droppedMarkers })
    },
  }
}
