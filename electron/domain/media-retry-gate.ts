import { z } from 'zod'

export const mediaRetryGateSchema = z.object({ retryAt: z.number().int().nonnegative(), automatic: z.boolean() }).strict()
export type MediaRetryGate = z.infer<typeof mediaRetryGateSchema>

export function mediaRetryDeferred(gate: MediaRetryGate | undefined, now: number, automatic: boolean): boolean {
  return !!gate && (gate.retryAt > now || (automatic && !gate.automatic))
}
