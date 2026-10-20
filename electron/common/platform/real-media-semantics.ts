import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../errors/app-error'
import { resolveSepRealMediaSize } from './sep-media-runtime-contract'

const qualitySchema = z.enum(['low', 'medium', 'high'])

export function realMediaParameters(input: { aspectRatio: string; size?: string; count: number; quality?: string }) {
  const quality = qualitySchema.safeParse(input.quality ?? 'medium')
  let size: string
  try { size = resolveSepRealMediaSize(input) } catch { throw new AppError('INVALID_ARGUMENT') }
  if (!quality.success || !['1024x1024', '1536x1024', '1024x1536'].includes(size)
    || !Number.isInteger(input.count) || input.count < 1 || input.count > 4) throw new AppError('INVALID_ARGUMENT')
  return { size, count: input.count, quality: quality.data }
}

/** SEP's semanticSha256 contract: ordered fields, UTF-8 and resolved defaults. */
export function realMediaSemanticHash(input: {
  profileId: string; configVersion: string; operation: 'generate' | 'edit';
  referenceHashes: string[]; creativeBrief: string;
  parameters: { aspectRatio: string; size?: string; count: number; quality?: string };
}): string {
  return createHash('sha256').update(JSON.stringify({
    profileId: input.profileId, configVersion: input.configVersion, operation: input.operation,
    referenceHashes: input.referenceHashes,
    briefSha256: createHash('sha256').update(input.creativeBrief.trim()).digest('hex'),
    parameters: realMediaParameters(input.parameters),
  })).digest('hex')
}
