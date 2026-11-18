import { z } from 'zod'

export const mediaFailureCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)
export const mediaFailureSchema = z.object({
  code: mediaFailureCodeSchema,
  stage: z.enum(['image-authorization', 'image-quote', 'image-submit', 'image-query', 'image-save',
    'video-authorization', 'video-quote', 'video-submit', 'video-query', 'video-save']),
  businessCode: mediaFailureCodeSchema.optional(),
  gatewayCode: mediaFailureCodeSchema.optional(),
  reasonCode: mediaFailureCodeSchema.optional(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  message: z.string().max(1000).optional(),
  source: z.enum(['client', 'sep', 'platform', 'adapter', 'pricing', 'sub2api', 'provider', 'upstream', 'authorization']).optional(),
}).strip()

/** Safe request diagnostics with an optional redacted upstream explanation. */
export type MediaFailure = z.infer<typeof mediaFailureSchema>
