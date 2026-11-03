import { documentPreviewRequestSchema } from '../../../src/shared/document-preview'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const documentPreviewRoutes = [
  route(INVOKE_CHANNELS.ARRANGE_PREVIEW_DOCUMENT, documentPreviewRequestSchema, async (ctx, input) => ({
    success: true,
    data: await ctx.documentPreviews.preview(input),
  })),
  route(INVOKE_CHANNELS.WORK_OPEN_DELIVERABLE, documentPreviewRequestSchema, async (ctx, input) => {
    await ctx.documentPreviews.openDirectory(input)
    return { success: true }
  }),
]
