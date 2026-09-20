import { z } from 'zod'
import { idempotencyKeySchema, personalSkillVersionRequestSchema, skillVersionIdSchema } from '../../../src/shared/platform-supplement-contracts'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

const versionInput = z.object({ capabilityId: skillVersionIdSchema, versionId: skillVersionIdSchema }).strict()
export const skillRoutes = [
  route(INVOKE_CHANNELS.SKILL_LIBRARY_LIST, NO_INPUT, async ctx => ({ success: true, data: await ctx.skills.list() })),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_PREVIEW, versionInput, async (ctx, input) => ({ success: true, data: await ctx.skills.preview(input) })),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_SELECT, versionInput, async (ctx, input) => { await ctx.skills.select(input); return { success: true } }),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_SAVE, z.object({ request: personalSkillVersionRequestSchema, idempotencyKey: idempotencyKeySchema }).strict(), async (ctx, input) => ({ success: true, data: await ctx.skills.save(input) })),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_RETRY, z.object({ capabilityId: skillVersionIdSchema, idempotencyKey: idempotencyKeySchema }).strict(), async (ctx, input) => ({ success: true, data: await ctx.skills.retry(input) })),
]
