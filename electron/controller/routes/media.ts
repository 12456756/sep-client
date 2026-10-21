import { dialog } from 'electron'
import { z } from 'zod'
import { mediaGenerationInputSchema, mediaId } from '../../common/platform/media-contract'
import { appError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

const assetInput = z.object({ taskId: mediaId, assetId: mediaId }).strict()
const jobInput = z.object({ taskId: mediaId, jobId: mediaId }).strict()

export const mediaRoutes = [
  route(INVOKE_CHANNELS.MEDIA_GET_TASK, mediaId, async (ctx, taskId) => ({ success: true, data: await ctx.media.getTaskMedia(taskId) })),
  route(INVOKE_CHANNELS.MEDIA_SET_REFERENCE_SELECTION, z.object({ taskId: mediaId, assetIds: z.array(mediaId).max(16) }).strict(), async (ctx, input) => {
    await ctx.media.setReferenceSelection(input.taskId, input.assetIds)
    return { success: true }
  }),
  route(INVOKE_CHANNELS.MEDIA_IMPORT_REFERENCES, mediaId, async (ctx, taskId) => {
    // Authorize before opening a dialog; renderer cannot nominate filesystem paths.
    const selection = await ctx.media.nativeSelection(taskId)
    const window = ctx.window()
    if (!window) throw appError('INTERNAL_ERROR')
    const result = await dialog.showOpenDialog(window, { title: '导入商品参考图', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (result.canceled) return { success: true, data: [] }
    if (result.filePaths.length > 16) throw appError('INVALID_ARGUMENT')
    return { success: true, data: await selection.import(result.filePaths) }
  }),
  route(INVOKE_CHANNELS.MEDIA_GENERATE, z.object({ taskId: mediaId, input: mediaGenerationInputSchema }).strict(), async (ctx, input) => ({ success: true, data: await ctx.media.generateTaskMedia(input.taskId, input.input) })),
  route(INVOKE_CHANNELS.MEDIA_PREVIEW, assetInput, async (ctx, input) => ({ success: true, data: await ctx.media.preview(input.taskId, input.assetId) })),
  route(INVOKE_CHANNELS.MEDIA_EXPORT, assetInput, async (ctx, input) => {
    const selection = await ctx.media.nativeSelection(input.taskId)
    const preview = await ctx.media.preview(input.taskId, input.assetId)
    const window = ctx.window()
    if (!window) throw appError('INTERNAL_ERROR')
    const extension = preview.mime === 'image/jpeg' ? 'jpg' : preview.mime === 'image/webp' ? 'webp' : 'png'
    const selected = await dialog.showSaveDialog(window, { title: '导出图片', defaultPath: `${input.assetId}.${extension}`, filters: [{ name: '图片', extensions: [extension] }] })
    if (selected.canceled || !selected.filePath) return { success: true, cancelled: true }
    await selection.export(input.assetId, selected.filePath)
    return { success: true, cancelled: false }
  }),
  route(INVOKE_CHANNELS.MEDIA_RETRY_SAVE, jobInput, async (ctx, input) => { await ctx.media.retrySave(input.taskId, input.jobId); return { success: true } }),
  route(INVOKE_CHANNELS.MEDIA_CANCEL, jobInput.extend({ cancelUpstream: z.boolean() }), async (ctx, input) => { await ctx.media.cancel(input.taskId, input.jobId, input.cancelUpstream); return { success: true } }),
  route(INVOKE_CHANNELS.MEDIA_RESUME, jobInput, async (ctx, input) => { await ctx.media.resume(input.taskId, input.jobId); return { success: true } }),
  route(INVOKE_CHANNELS.MEDIA_REDO, jobInput, async (ctx, input) => ({ success: true, data: await ctx.media.redo(input.taskId, input.jobId) })),
]
