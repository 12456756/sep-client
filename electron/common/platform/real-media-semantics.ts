import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../errors/app-error'
import { resolveSepRealMediaSize } from './sep-media-runtime-contract'
import { imageRequestedSpecSchema, type ImageRequestedSpec, type MediaParameterSources } from '../../../src/shared/media-spec-contract'

const qualitySchema = z.enum(['low', 'medium', 'high'])

export function realMediaParameters(input: ImageRequestedSpec) {
  const quality = qualitySchema.safeParse(input.quality ?? 'medium')
  let size: string
  try { if (!input.aspectRatio) throw new Error(); size = resolveSepRealMediaSize({ ...input, aspectRatio: input.aspectRatio }) } catch { throw new AppError('INVALID_ARGUMENT') }
  if (!quality.success || !['1024x1024', '1536x1024', '1024x1536'].includes(size)
    || input.count === undefined || !Number.isInteger(input.count) || input.count < 1 || input.count > 4) throw new AppError('INVALID_ARGUMENT')
  return { size, count: input.count, quality: quality.data }
}

/** SEP's semanticSha256 contract: ordered fields, UTF-8 and resolved defaults. */
export function realMediaSemanticHash(input: {
  profileId: string; configVersion: string; operation: 'generate' | 'edit';
  referenceHashes: string[]; creativeBrief: string;
  parameters: ImageRequestedSpec;
  protocolVersion?: 3; requestedSpec?: ImageRequestedSpec; parameterSources?: MediaParameterSources; specRevision?: number;
}): string {
  if (input.protocolVersion === 3) {
    const spec = imageRequestedSpecSchema.parse(input.requestedSpec)
    const ordered = (value: object) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)))
    return createHash('sha256').update(JSON.stringify({
      protocolVersion: 3, profileId: input.profileId, configVersion: input.configVersion, operation: input.operation,
      referenceHashes: input.referenceHashes, briefSha256: createHash('sha256').update(input.creativeBrief.trim()).digest('hex'),
      requestedSpec: ordered(spec), parameterSources: ordered(input.parameterSources ?? {}), specRevision: input.specRevision,
    })).digest('hex')
  }
  return createHash('sha256').update(JSON.stringify({
    profileId: input.profileId, configVersion: input.configVersion, operation: input.operation,
    referenceHashes: input.referenceHashes,
    briefSha256: createHash('sha256').update(input.creativeBrief.trim()).digest('hex'),
    parameters: realMediaParameters(input.parameters),
  })).digest('hex')
}
