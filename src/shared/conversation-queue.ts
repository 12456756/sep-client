import { z } from 'zod'

export const CONVERSATION_QUEUE_LIMIT = 10
export const conversationQueueItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  prompt: z.string().trim().min(1),
  createdAt: z.number().finite(),
  attachmentNames: z.array(z.string()),
})
export const conversationQueueViewSchema = z.object({
  paused: z.boolean(),
  items: z.array(conversationQueueItemSchema),
  failed: conversationQueueItemSchema.nullable(),
})
export type ConversationQueueView = z.infer<typeof conversationQueueViewSchema>
