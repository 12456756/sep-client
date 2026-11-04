import { join } from 'node:path'
import { z } from 'zod'
import { attachmentRefSchema } from '../../src/shared/attachment-contracts'
import { knowledgeSelectionSchema } from '../../src/shared/knowledge-selection'
import { conversationQueueItemSchema } from '../../src/shared/conversation-queue'
import { diagnoseJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'

const entrySchema = conversationQueueItemSchema.extend({
  requestKey: z.string().length(64).optional(),
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  status: z.enum(['waiting', 'active', 'completed', 'failed', 'cancelled']),
  attachmentRefs: z.array(attachmentRefSchema).optional(),
  knowledge: knowledgeSelectionSchema.optional(),
  mode: z.enum(['strict', 'confirm_rebuild', 'auto_rebuild_from_task_history']).optional(),
  confirmed: z.boolean().optional(),
})
const queueSchema = z.object({
  version: z.literal(1), taskId: z.string(), owner: z.object({ memberId: z.string(), enterpriseId: z.string() }),
  paused: z.boolean(), priorityInterruptRunId: z.string().optional(), entries: z.array(entrySchema),
})
export type ConversationQueueEntry = z.infer<typeof entrySchema>
export type ConversationQueueRecord = z.infer<typeof queueSchema>
export interface ConversationQueueStorePort {
  get(scope: TaskOwnerScope, taskId: string): Promise<ConversationQueueRecord | null>
  save(scope: TaskOwnerScope, record: ConversationQueueRecord): Promise<void>
}

export class ConversationQueueStore implements ConversationQueueStorePort {
  private readonly paths: ScopePath
  constructor(root: string) { this.paths = new ScopePath(root) }

  async get(scope: TaskOwnerScope, taskId: string): Promise<ConversationQueueRecord | null> {
    const result = await diagnoseJsonWithBackup(join(this.paths.taskDir(scope, taskId), 'conversation', 'queue.json'), value => {
      const parsed = queueSchema.safeParse(value)
      return parsed.success && parsed.data.taskId === taskId && parsed.data.owner.memberId === scope.memberId &&
        parsed.data.owner.enterpriseId === scope.enterpriseId ? parsed.data : null
    })
    if (result.state === 'unavailable') throw new Error('CONVERSATION_QUEUE_UNAVAILABLE')
    return result.state === 'found' ? result.value : null
  }

  async save(scope: TaskOwnerScope, record: ConversationQueueRecord): Promise<void> {
    const parsed = queueSchema.parse(record)
    if (parsed.owner.memberId !== scope.memberId || parsed.owner.enterpriseId !== scope.enterpriseId) throw new Error('CONVERSATION_QUEUE_OWNER_MISMATCH')
    await writeJsonAtomic(join(this.paths.taskDir(scope, parsed.taskId), 'conversation', 'queue.json'), parsed)
  }
}
