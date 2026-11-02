import { z } from 'zod'

export const arrangementMediaSpecRevisionsSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), z.number().int().positive().safe())
  .refine(value => Object.keys(value).length <= 64)

export const arrangementInputReplySchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  text: z.string().trim().min(1).max(4_000),
}).strict()

export const arrangementInputRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  kind: z.literal('media-spec'),
  question: z.string().trim().min(1).max(2_000),
  requirements: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), specRevision: z.number().int().positive().safe().optional() }).strict()).max(64),
}).strict()

export const arrangementClarificationSchema = z.object({
  needsUserInput: z.object({ question: z.string().trim().min(1).max(2_000) }).strict(),
}).strict()

export type ArrangementInputRequest = z.infer<typeof arrangementInputRequestSchema>
export type ArrangementInputReply = z.infer<typeof arrangementInputReplySchema>
