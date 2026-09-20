export type ConversationSyncRole = 'user' | 'assistant'

export interface ConversationMessageToSync {
  taskId: string
  runId: string
  role: ConversationSyncRole
  content: string
  clientConversationId: string
  clientMessageId: string
  subscriptionId: string
  modelId: string
  turnId: string
  createdAt: number
}

export interface ConversationMessageSyncPort {
  enqueue(message: ConversationMessageToSync): void
}
