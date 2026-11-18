import { z } from 'zod'

const text = z.string().max(65536)
const errorBody = z.object({ message: text.optional(), code: z.union([z.string().max(256), z.number().finite()]).optional(), type: z.string().max(256).optional() }).strip()
export const mediaUpstreamErrorSchema = z.object({
  status: z.number().int().min(0).max(599),
  body: z.union([text, errorBody.extend({ error: z.union([text, errorBody]).optional() }).strip()]),
}).strip()
export type MediaUpstreamError = z.infer<typeof mediaUpstreamErrorSchema>

export function mediaUpstreamMessage(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().slice(0, 1000) || null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  return mediaUpstreamMessage(item.error) ?? (typeof item.message === 'string' ? mediaUpstreamMessage(item.message) : null)
}
