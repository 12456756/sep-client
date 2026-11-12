import { z } from 'zod'
import { skillVersionIdSchema } from './platform-supplement-contracts'

const content = z.string().max(100_000).refine(value => value.trim().length > 0)
const prompt = z.string().trim().min(1).max(8_000)
export const skillRewriteCancelSchema = z.object({ requestId: z.string().uuid() }).strict()
export const skillRewriteInputSchema = skillRewriteCancelSchema.extend({
  capabilityId: skillVersionIdSchema,
  versionId: skillVersionIdSchema,
  modelId: z.string().trim().min(1).max(256),
  content,
  prompt,
  history: z.array(z.object({
    prompt, content, status: z.enum(['pending', 'accepted', 'ignored', 'superseded', 'undone', 'stale']),
  }).strict()).max(3),
}).strict()

export const skillRewriteOutputSchema = z.object({
  body: content,
  summary: z.string().trim().min(1).max(2_000),
  changes: z.array(z.object({
    kind: z.enum(['add', 'change', 'remove']),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(2_000),
  }).strict()).min(1).max(20),
}).strict()

export type SkillRewriteInput = z.infer<typeof skillRewriteInputSchema>
export type SkillRewriteOutput = z.infer<typeof skillRewriteOutputSchema>
export interface SkillRewriteResult extends Omit<SkillRewriteOutput, 'body'> {
  requestId: string
  content: string
}

/** Keep the metadata bytes intact; the model may replace only the Markdown body. */
export function splitSkillRewriteSource(source: string): { metadata: string; body: string } {
  const match = /^(?:\uFEFF)?(?:[\t ]*\r?\n)*---[\t ]*\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/.exec(source)
  const metadata = match?.[0] ?? ''
  return { metadata, body: source.slice(metadata.length) }
}
