import { dialog } from 'electron'
import { z } from 'zod'
import { videoGenerationInputSchema } from '../../../src/shared/video-host'
import { videoLocalIdSchema } from '../../domain/video-media'
import { AppError, appError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import type { RequestContext } from '../request-context'
import { route } from '../router'

const taskId = videoLocalIdSchema
const jobInput = z.object({ taskId, jobId: videoLocalIdSchema }).strict()
const outputInput = jobInput.extend({ outputId: videoLocalIdSchema })
const options = { errorShape: 'ipc' as const }
function host(ctx: RequestContext) {
  if (!ctx.video) throw appError('SERVICE_UNAVAILABLE')
  return ctx.video
}
function track(ctx: RequestContext, taskId: string): void {
  // Tracking failures are persisted by the service. UI reads never wake recovery.
  void host(ctx).track(taskId).catch(() => undefined)
}

export const videoRoutes = [
  route(INVOKE_CHANNELS.VIDEO_GET_TASK, taskId, async (ctx, id) => {
    if (!ctx.video) return { success: true, data: null }
    try { return { success: true, data: await ctx.video.getTaskVideo(id) } } catch (error) {
      // Missing/revoked video capability hides this optional feature. Persistence
      // failures and authentication errors must retain their ordinary IPC errors.
      if (error instanceof AppError && error.code === 'PERMISSION_DENIED') return { success: true, data: null }
      throw error
    }
  }, options),
  route(INVOKE_CHANNELS.VIDEO_GET_REFERENCES, taskId, async (ctx, id) => ({ success: true, data: await host(ctx).getReferences(id) }), options),
  route(INVOKE_CHANNELS.VIDEO_IMPORT_REFERENCES, taskId, async (ctx, id) => {
    const selection = await host(ctx).nativeSelection(id)
    const window = ctx.window()
    if (!window) throw appError('INTERNAL_ERROR')
    const result = await dialog.showOpenDialog(window, { title: '选择视频参考图', properties: ['openFile'], filters: [{ name: '参考图片', extensions: ['png'] }] })
    if (result.canceled) return { success: true, data: [] }
    return { success: true, data: await selection.import(result.filePaths) }
  }, options),
  route(INVOKE_CHANNELS.VIDEO_GENERATE, z.object({ taskId, input: videoGenerationInputSchema }).strict(), async (ctx, input) => {
    const data = await host(ctx).generate(input.taskId, input.input)
    track(ctx, input.taskId)
    return { success: true, data }
  }, options),
  route(INVOKE_CHANNELS.VIDEO_PREVIEW, outputInput, async (ctx, input) => ({ success: true, data: await host(ctx).preview(input.taskId, input.jobId, input.outputId) }), options),
  route(INVOKE_CHANNELS.VIDEO_EXPORT, outputInput, async (ctx, input) => {
    const selection = await host(ctx).nativeSelection(input.taskId)
    const preview = await host(ctx).preview(input.taskId, input.jobId, input.outputId)
    const window = ctx.window()
    if (!window) throw appError('INTERNAL_ERROR')
    const extension = preview.mime === 'video/webm' ? 'webm' : 'mp4'
    const selected = await dialog.showSaveDialog(window, { title: '导出视频', defaultPath: `${input.outputId}.${extension}`, filters: [{ name: '视频', extensions: [extension] }] })
    if (selected.canceled || !selected.filePath) return { success: true, cancelled: true }
    await selection.export(input.jobId, input.outputId, selected.filePath)
    return { success: true, cancelled: false }
  }, options),
  route(INVOKE_CHANNELS.VIDEO_RESUME, jobInput, async (ctx, input) => {
    await host(ctx).resume(input.taskId, input.jobId)
    track(ctx, input.taskId)
    return { success: true }
  }, options),
  route(INVOKE_CHANNELS.VIDEO_RETRY_SAVE, jobInput, async (ctx, input) => {
    await host(ctx).retrySave(input.taskId, input.jobId)
    track(ctx, input.taskId)
    return { success: true }
  }, options),
]
