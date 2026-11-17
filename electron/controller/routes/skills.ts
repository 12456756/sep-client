import { z } from 'zod'
import { idempotencyKeySchema, personalSkillVersionRequestSchema, skillVersionIdSchema } from '../../../src/shared/platform-supplement-contracts'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'
import { skillLibraryQuerySchema } from '../../../src/shared/skill-library'
import { reportFailure } from '../../errors/error-reporter'
import { skillRewriteCancelSchema, skillRewriteInputSchema } from '../../../src/shared/skill-rewrite'

const versionInput = z.object({ capabilityId: skillVersionIdSchema, versionId: skillVersionIdSchema }).strict()
export const skillRoutes = [
  route(INVOKE_CHANNELS.SKILL_LIBRARY_REWRITE, skillRewriteInputSchema, async (ctx, input) => ({ success: true, data: await ctx.skills.rewrite(input) })),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_CANCEL_REWRITE, skillRewriteCancelSchema, (ctx, input) => { ctx.skills.cancelRewrite(input); return { success: true } }),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_LIST, skillLibraryQuerySchema.optional(), async (ctx, input) => {
    try {
      const { items, ...metadata } = await ctx.skills.listWithDiagnostics(input ?? { mode: 'auto' })
      return { success: true, data: items, ...metadata }
    } catch (error) {
      const failure = reportFailure(INVOKE_CHANNELS.SKILL_LIBRARY_LIST, error, { authenticated: true })
      // A failed refresh may still have completed catalogs. Never return another identity's cache.
      if (failure.error.code === 'INVALID_STATE') return failure
      const { items, ...metadata } = ctx.skills.cached()
      return { ...failure, data: items, ...metadata }
    }
  }),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_PREVIEW, versionInput, async (ctx, input) => ({ success: true, data: await ctx.skills.preview(input) })),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_SELECT, versionInput, async (ctx, input) => ({ success: true, data: await ctx.skills.select(input) })),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_SAVE, z.object({ request: personalSkillVersionRequestSchema, idempotencyKey: idempotencyKeySchema }).strict(), async (ctx, input) => ({ success: true, data: await ctx.skills.save(input) })),
  route(INVOKE_CHANNELS.SKILL_LIBRARY_RETRY, z.object({ capabilityId: skillVersionIdSchema, idempotencyKey: idempotencyKeySchema }).strict(), async (ctx, input) => ({ success: true, data: await ctx.skills.retry(input) })),
]
