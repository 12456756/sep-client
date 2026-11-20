import { dialog } from 'electron'
import { documentPreviewRequestSchema, resultDocumentRequestSchema } from '../../../src/shared/document-preview'
import { AppError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const documentPreviewRoutes = [
  route(INVOKE_CHANNELS.ARRANGE_PREVIEW_DOCUMENT, documentPreviewRequestSchema, async (ctx, input) => ({
    success: true,
    data: await ctx.documentPreviews.preview(input),
  })),
  route(INVOKE_CHANNELS.WORK_OPEN_DELIVERABLE, resultDocumentRequestSchema, async (ctx, input) => {
    await ctx.documentPreviews.openDirectory(input)
    return { success: true }
  }),
  route(INVOKE_CHANNELS.WORK_SAVE_WORD_COPY, documentPreviewRequestSchema, async (ctx, input) => {
    const window = ctx.window()
    if (!window) throw new AppError('INVALID_STATE')
    const saved = await ctx.documentPreviews.saveCopy(input, async (name, format) => {
      const selected = await dialog.showSaveDialog(window, { title: '另存 Word 文件', defaultPath: name,
        filters: [{ name: 'Word', extensions: [format] }] })
      return selected.canceled ? null : selected.filePath ?? null
    })
    return { success: true, cancelled: !saved }
  }, { trustedMainFrame: true }),
]
