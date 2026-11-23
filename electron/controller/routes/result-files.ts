import { clipboard, dialog, shell } from 'electron'
import { resultFileRequestSchema, resultFileReleaseSchema, resultFileActionSchema } from '../../../src/shared/result-files'
import { AppError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const resultFileRoutes = [
  route(INVOKE_CHANNELS.RESULT_FILE_PREVIEW, resultFileRequestSchema, async (ctx, input) => ({ success: true, data: await ctx.resultFiles.preview(input) }), { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.RESULT_FILE_RELEASE, resultFileReleaseSchema, async (ctx, input) => { await ctx.resultFiles.release(input); return { success: true } }, { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.RESULT_FILE_REVEAL, resultFileRequestSchema, async (ctx, input) => ({ success: true,
    ...(await ctx.resultFiles.reveal(input) ? { archiveFailed: true } : {}) }), { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.RESULT_FILE_SAVE_STATUS, resultFileRequestSchema, async (ctx, input) => ({ success: true,
    data: await ctx.resultFiles.archiveStatus(input) }), { trustedMainFrame: true }),
  route(INVOKE_CHANNELS.RESULT_FILE_ACTION, resultFileActionSchema, async (ctx, input) => {
    switch (input.action) {
      case 'open': await ctx.resultFiles.openDefault(input.file, path => shell.openPath(path)); break
      case 'copy-path': await ctx.resultFiles.copyPath(input.file, path => clipboard.writeText(path)); break
      case 'retry-archive': await ctx.resultFiles.retryArchive(input.file); break
      case 'retry-archive-elsewhere': await ctx.resultFiles.retryArchive(input.file, input.confirmation); break
      case 'save-as': {
        const window = ctx.window()
        if (!window) throw new AppError('INVALID_STATE')
        const saved = await ctx.resultFiles.saveAs(input.file, async name => {
          const selected = await dialog.showSaveDialog(window, { title: '另存为', defaultPath: await ctx.resultFiles.saveDialogPath(input.file, name) })
          return selected.canceled ? null : selected.filePath ?? null
        })
        return { success: true, cancelled: !saved }
      }
      case 'attach': {
        const data = await ctx.resultFiles.withFile(input.file, async (file, scope, assert) => {
          const session = await ctx.attachments.attachResultFile(scope, input.sessionId, file.path, file.name)
          assert()
          return session
        })
        return { success: true, data }
      }
    }
    return { success: true }
  }, { trustedMainFrame: true }),
]
