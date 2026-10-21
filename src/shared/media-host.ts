import { z } from 'zod'

/** The model describes the image request; the host resolves the authorized profile and defaults. */
export const mediaToolGenerationInputSchema = z.object({
  creativeBrief: z.string().trim().min(1).max(20_000),
  localAssetIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(16).optional(),
  parameters: z.object({
    aspectRatio: z.string().min(1).max(32).optional(), count: z.number().int().min(1).max(16).optional(),
    size: z.string().min(1).max(64).optional(), quality: z.string().min(1).max(64).optional(),
  }).strict().optional(),
  // Retain persisted tool calls while allowing new calls to omit host-owned configuration.
  profileId: z.string().min(1).max(256).optional(),
  operation: z.enum(['generate', 'edit']).optional(),
}).strict().refine(value => {
  const ids = value.localAssetIds ?? []
  return new Set(ids).size === ids.length
})
