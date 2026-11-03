import { z } from 'zod'

export const CONVERSATION_QUEUE_LIMIT = 10
export const conversationQueueItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  prompt: z.string().trim().min(1),
  createdAt: z.number().finite(),
  attachmentNames: z.array(z.string()),
  recoveryConfirmationRequired: z.boolean().optional(),
})
export const conversationQueueInputSchema = z.discriminatedUnion('action', [
  z.object({ taskId: z.string().min(1), action: z.literal('get') }).strict(),
  z.object({ taskId: z.string().min(1), action: z.literal('resume') }).strict(),
  z.object({
    taskId: z.string().min(1), action: z.literal('recover'),
    messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), confirmRecovery: z.literal(true),
  }).strict(),
])
export type ConversationQueueInput = z.infer<typeof conversationQueueInputSchema>
export const conversationQueueViewSchema = z.object({
  preparing: z.boolean().optional(),
  paused: z.boolean(),
  items: z.array(conversationQueueItemSchema),
  failed: conversationQueueItemSchema.nullable(),
})
export type ConversationQueueView = z.infer<typeof conversationQueueViewSchema>
