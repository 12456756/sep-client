import { z } from 'zod'

export const mediaUpstreamErrorSchema = z.object({
  status: z.number().int().min(0).max(599),
  body: z.json(),
  headers: z.record(z.string(), z.string().max(8192)).optional(),
}).strip()
export type MediaUpstreamError = z.infer<typeof mediaUpstreamErrorSchema>

export function mediaUpstreamMessages(value: unknown, depth = 0): string[] {
  if (depth > 6) return []
  if (typeof value === 'string') return value.trim() ? [value.trim().slice(0, 1000)] : []
  if (Array.isArray(value)) return value.slice(0, 16).flatMap(child => mediaUpstreamMessages(child, depth + 1)).slice(0, 16)
  if (!value || typeof value !== 'object') return []
  const item = value as Record<string, unknown>
  // Later reconciliation diagnostics must not replace the original generation reason.
  return [item.error, item.message, item.reason, item.detail, item.errors, item.body]
    .flatMap(child => mediaUpstreamMessages(child, depth + 1)).slice(0, 16)
}

export function mediaUpstreamMessage(value: unknown): string | null {
  return [...new Set(mediaUpstreamMessages(value))].join('; ').slice(0, 1000) || null
}
