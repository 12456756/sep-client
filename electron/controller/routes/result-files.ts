import { resultFileRequestSchema, resultFileReleaseSchema } from '../../../src/shared/result-files'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const resultFileRoutes = [
  route(INVOKE_CHANNELS.RESULT_FILE_PREVIEW, resultFileRequestSchema, async (ctx, input) => ({ success: true, data: await ctx.resultFiles.preview(input) }), { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.RESULT_FILE_RELEASE, resultFileReleaseSchema, async (ctx, input) => { await ctx.resultFiles.release(input); return { success: true } }, { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.RESULT_FILE_REVEAL, resultFileRequestSchema, async (ctx, input) => { await ctx.resultFiles.reveal(input); return { success: true } }, { trustedMainFrame: true }),
]
