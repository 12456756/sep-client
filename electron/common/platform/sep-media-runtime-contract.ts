import { z } from 'zod'

// Mirrors SEP backend/src/shared/media.dto.ts configuration-stage runtime v1.
const sepMediaRuntimeProfileSchema = z.object({
  profileId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  kind: z.literal('image'),
  displayName: z.string().trim().min(1).max(80),
  configVersion: z.string().trim().min(1).max(80),
  operations: z.array(z.enum(['generate', 'edit'])).min(1).max(2),
  executionMode: z.enum(['async-query', 'sync-response']),
  capabilities: z.object({
    supportsReferenceImage: z.boolean().default(false),
    maxOutputs: z.number().int().min(1).max(8).default(1),
    sizes: z.array(z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/)).min(1).max(32),
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
  }).strict(),
}).strict()

export const sepMediaRuntimeSchema = z.object({
  protocolVersion: z.literal(1),
  executionAvailable: z.boolean(),
  defaultProfileId: z.string().nullable(),
  tools: z.array(z.string()),
  profiles: z.array(sepMediaRuntimeProfileSchema),
}).strict().refine(value => !value.executionAvailable && value.tools.length === 0,
  'Only the implemented configuration-stage SEP media contract is supported.')

export function parseSepMediaRuntime(value: unknown): z.infer<typeof sepMediaRuntimeSchema> {
  const result = sepMediaRuntimeSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid or unsupported SEP media runtime.')
  return result.data
}
