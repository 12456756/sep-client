import { z } from 'zod'
import { imageRequestedSpecSchema, mediaParameterSourcesSchema } from './media-spec-contract'

/** The model supplies specification decisions; the host validates authorization without inventing defaults. */
export const mediaToolGenerationInputSchema = z.object({
  requirementId: z.string().trim().min(1).max(128).optional(),
  creativeBrief: z.string().trim().min(1).max(20_000),
  localAssetIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(16).optional(),
  parameters: z.object({
    aspectRatio: z.string().min(1).max(32).optional(), count: z.number().int().min(1).max(16).optional(),
    size: z.string().min(1).max(64).optional(), quality: z.string().min(1).max(64).optional(),
  }).strict().optional(),
  protocolVersion: z.literal(3).optional(),
  requestedSpec: imageRequestedSpecSchema.optional(),
  parameterSources: mediaParameterSourcesSchema.optional(),
  specRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  // Retain persisted tool calls while allowing new calls to omit host-owned configuration.
  profileId: z.string().min(1).max(256).optional(),
  operation: z.enum(['generate', 'edit']).optional(),
}).strict().refine(value => {
  const ids = value.localAssetIds ?? []
  return new Set(ids).size === ids.length
})
