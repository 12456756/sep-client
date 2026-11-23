import { z } from 'zod'

export const LOCAL_MEDIA_TOOL = 'local_media_process'
export const localMediaProgressSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('probe') }),
  z.object({ phase: z.literal('render'), percent: z.number().int().min(0).max(99).optional() }),
  z.object({ phase: z.literal('verify') }),
  z.object({ phase: z.literal('save') }),
])
export type LocalMediaProgress = z.infer<typeof localMediaProgressSchema>
