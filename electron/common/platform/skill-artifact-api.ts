import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { config } from '../config'
import { logger } from '../logger'
import { AuthApiError } from './platform-api'
import { parseRetryAfter, readApiDiagnostic, transportApiDiagnostic } from './api-diagnostic'
import {
  skillArtifactAvailableSchema, skillArtifactParamsSchema,
  skillArtifactDownloadPath, type AvailableDescriptor,
} from './skill-artifact-contract'

const MAX_RATE_LIMIT_RETRIES = 3
const MAX_RETRY_WAIT_MS = 5 * 60_000

export interface SkillArtifactDownloadOptions {
  signal?: AbortSignal
  assertCurrent?: () => void
}

function retryDelay(value: string | null, attempt: number): number {
  if (value !== null && /^\d+(?:\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000)
  // Date.parse also accepts some invalid numeric hints as calendar dates.
  if (value && /[a-z]/i.test(value) && value.includes(',')) {
    const date = Date.parse(value)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return 2000 * 2 ** attempt
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', abort)
    const abort = (): void => { clearTimeout(timer); cleanup(); reject(signal?.reason) }
    const timer = setTimeout(() => { cleanup(); resolve() }, delayMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

async function artifactError(response: Response, accessToken: string, options: SkillArtifactDownloadOptions): Promise<AuthApiError> {
  const diagnostic = await readApiDiagnostic(response, 'skill-artifact', { maxBytes: 64 * 1024, signal: options.signal, secrets: [accessToken] })
  options.signal?.throwIfAborted()
  options.assertCurrent?.()
  return new AuthApiError({ statusCode: response.status, message: '技能包下载失败，请联系平台管理员。',
    requestId: diagnostic.sepRequestId, retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')), diagnostic }, 'skills')
}

async function fetchArtifact(expected: AvailableDescriptor, accessToken: string, options: SkillArtifactDownloadOptions): Promise<Response> {
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted()
    options.assertCurrent?.()
    let response: Response
    try { response = await fetch(`${config.SEP_BASE_URL}${expected.downloadPath}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: 'omit',
      redirect: 'error',
      signal: options.signal,
    }) } catch (error) {
      options.signal?.throwIfAborted()
      options.assertCurrent?.()
      throw new AuthApiError({ statusCode: 0, message: '技能包下载网络连接失败，请检查网络。',
        diagnostic: transportApiDiagnostic(error, 'skill-artifact', [accessToken]) }, 'skills')
    }
    if (response.status !== 429 || response.redirected) return response
    const error = await artifactError(response, accessToken, options)
    options.signal?.throwIfAborted()
    options.assertCurrent?.()
    const delayMs = retryDelay(response.headers.get('Retry-After'), attempt)
    if (attempt >= MAX_RATE_LIMIT_RETRIES || !Number.isFinite(delayMs) || waited + delayMs > MAX_RETRY_WAIT_MS) {
      throw error
    }
    waited += delayMs
    logger.child('skill-artifact').warn('skill artifact rate limited; waiting before retry', {
      capabilityId: expected.capabilityId, versionId: expected.versionId,
      statusCode: 429, retry: attempt + 1, maxRetries: MAX_RATE_LIMIT_RETRIES, delayMs, diagnostic: error.error.diagnostic,
    })
    await waitForRetry(delayMs, options.signal)
  }
}

export async function downloadSkillArtifact(subscriptionId: string, artifact: AvailableDescriptor, accessToken: string, options: SkillArtifactDownloadOptions = {}): Promise<Buffer> {
  const descriptor = skillArtifactAvailableSchema.safeParse(artifact)
  const params = skillArtifactParamsSchema.safeParse({ subscriptionId, capabilityId: artifact?.capabilityId, versionId: artifact?.versionId })
  if (!descriptor.success || !params.success) throw new Error('Invalid skill artifact download descriptor.')
  const expected = descriptor.data
  if (expected.downloadPath !== skillArtifactDownloadPath(params.data.subscriptionId, expected)) {
    throw new Error('Skill artifact download identity mismatch.')
  }
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) throw new Error('Skill artifact access token is required.')

  const response = await fetchArtifact(expected, accessToken, options)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('Skill artifact redirects are forbidden.')
    }
    if (!response.ok) {
      throw await artifactError(response, accessToken, options)
    }
    if (response.status !== 200) throw new Error('Invalid skill artifact response status.')
    const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    const expectedMime = expected.format === 'zip' ? 'application/zip' : 'text/markdown'
    if (mime !== expectedMime) throw new Error('Skill artifact MIME mismatch.')
    const length = response.headers.get('Content-Length')
    const encoding = response.headers.get('Content-Encoding')?.trim().toLowerCase()
    // Fetch decodes compressed bodies; their wire length is not the artifact length.
    if (length !== null && (!/^[1-9]\d*$/.test(length) || !Number.isSafeInteger(Number(length))
      || ((!encoding || encoding === 'identity') && Number(length) !== expected.byteLength))) {
      throw new Error('Skill artifact content length mismatch.')
    }
    if (response.headers.get('X-SHA256') !== expected.artifactSha256) throw new Error('Skill artifact checksum header mismatch.')
    if (!response.body) throw new Error('Skill artifact response body is missing.')

    reader = response.body.getReader()
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    let byteLength = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > expected.byteLength) throw new Error('Skill artifact body exceeds its declared length.')
      const chunk = Buffer.from(value)
      chunks.push(chunk)
      hash.update(chunk)
    }
    if (byteLength !== expected.byteLength) throw new Error('Skill artifact body length mismatch.')
    if (hash.digest('hex') !== expected.artifactSha256) throw new Error('Skill artifact SHA256 mismatch.')
    return Buffer.concat(chunks, byteLength)
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    } else {
      void response.body?.cancel().catch(() => {})
    }
  }
}
