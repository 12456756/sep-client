import { z } from 'zod'
import { knowledgeRequestIdSchema, knowledgeRequestSchema } from '../../../src/shared/knowledge-contracts'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const knowledgeRoutes = [
  route(INVOKE_CHANNELS.KNOWLEDGE_REQUEST, knowledgeRequestSchema, async (ctx, input) => ({ success: true, data: await ctx.knowledge.execute(input) })),
  route(INVOKE_CHANNELS.KNOWLEDGE_CANCEL, z.array(knowledgeRequestIdSchema).max(100), (ctx, ids) => { ctx.knowledge.cancel(ids); return { success: true } }),
]
