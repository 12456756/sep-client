import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { config } from '../config'
import { AuthApiError } from './platform-api'
import {
  maxSkillArtifactBytes, skillArtifactAvailableSchema, skillArtifactParamsSchema,
  skillArtifactDownloadPath, type AvailableDescriptor,
} from './skill-artifact-contract'

export async function downloadSkillArtifact(subscriptionId: string, artifact: AvailableDescriptor, accessToken: string): Promise<Buffer> {
  const descriptor = skillArtifactAvailableSchema.safeParse(artifact)
  const params = skillArtifactParamsSchema.safeParse({ subscriptionId, capabilityId: artifact?.capabilityId, versionId: artifact?.versionId })
  if (!descriptor.success || !params.success) throw new Error('Invalid skill artifact download descriptor.')
  const expected = descriptor.data
  if (expected.downloadPath !== skillArtifactDownloadPath(params.data.subscriptionId, expected)) {
    throw new Error('Skill artifact download identity mismatch.')
  }
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) throw new Error('Skill artifact access token is required.')

  const response = await fetch(`${config.SEP_BASE_URL}${expected.downloadPath}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('Skill artifact redirects are forbidden.')
    }
    if (!response.ok) {
      // Preserve the HTTP authority and never retry through a legacy content endpoint.
      throw new AuthApiError({ statusCode: response.status, message: 'Skill artifact download rejected.' }, 'skills')
    }
    if (response.status !== 200) throw new Error('Invalid skill artifact response status.')
    const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    const expectedMime = expected.format === 'zip' ? 'application/zip' : 'text/markdown'
    if (mime !== expectedMime) throw new Error('Skill artifact MIME mismatch.')
    const length = response.headers.get('Content-Length')
    if (length === null || !/^[1-9]\d*$/.test(length) || Number(length) !== expected.byteLength) {
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
      if (byteLength > expected.byteLength || byteLength > maxSkillArtifactBytes) throw new Error('Skill artifact byte limit exceeded.')
      const chunk = Buffer.from(value)
      chunks.push(chunk)
      hash.update(chunk)
    }
    if (byteLength !== expected.byteLength) throw new Error('Skill artifact body length mismatch.')
    if (hash.digest('hex') !== expected.artifactSha256) throw new Error('Skill artifact SHA256 mismatch.')
    return Buffer.concat(chunks, byteLength)
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    } else {
      await response.body?.cancel().catch(() => {})
    }
  }
}
