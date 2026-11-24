import { z } from 'zod'

export const LOCAL_MEDIA_TOOL = 'local_media_process'
const batch = { item: z.number().int().min(1).max(8).optional(), total: z.number().int().min(1).max(8).optional() }
export const localMediaProgressSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('probe'), ...batch }),
  z.object({ phase: z.literal('render'), percent: z.number().int().min(0).max(99).optional(), ...batch }),
  z.object({ phase: z.literal('verify'), ...batch }),
  z.object({ phase: z.literal('save'), ...batch }),
])
export type LocalMediaProgress = z.infer<typeof localMediaProgressSchema>
