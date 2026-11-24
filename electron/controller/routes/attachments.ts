import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import { z } from 'zod'
import { attachmentImportLimits, attachmentImportTargetSchema, attachmentPreviewRequestSchema, pastedAttachmentFolderPath } from '../../../src/shared/attachment-contracts'
import { AppError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const sessionInput = z.object({ sessionId: id }).strict()
const operationInput = sessionInput.extend({ operationId: id })
const localPaths = z.array(z.string().min(1).max(4096)).min(1).max(attachmentImportLimits.maxImportFiles)
const trusted = { trustedMainFrame: true }

export const attachmentRoutes = [
  route(INVOKE_CHANNELS.ATTACHMENT_BEGIN, z.object({ target: attachmentImportTargetSchema, idempotencyKey: id.optional() }).strict(), async (ctx, input) => {
    if (input.target.kind === 'draft' || input.target.kind === 'draft-node') {
      const draft = await ctx.arrangements.getDraft(input.target.draftId)
      if (draft.revision !== input.target.expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
      if (draft.confirmedWorkPlanId || draft.status === 'planning') throw new AppError('INVALID_STATE')
      const target = input.target
      if (target.kind === 'draft-node' && !draft.nodes.some(node => node.id === target.nodeId)) throw new AppError('NOT_FOUND')
    } else if (input.target.kind === 'conversation') {
      if (!await ctx.tasks.get(input.target.taskId)) throw new AppError('NOT_FOUND')
    }
    return { success: true, data: await ctx.attachments.beginSession(input.target) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_LIST, sessionInput, async (ctx, input) => ({ success: true, data: await ctx.attachments.listSession(input.sessionId) }), trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_SELECT, sessionInput.extend({ single: z.boolean().optional() }), async (ctx, input) => {
    const session = await ctx.attachments.listSession(input.sessionId)
    if (!session || session.status !== 'open') throw new AppError('INVALID_STATE')
    const window = ctx.window()
    if (!window) throw new AppError('INTERNAL_ERROR')
    const selected = await dialog.showOpenDialog(window, { title: input.single ? '引用文件' : '添加附件', properties: input.single ? ['openFile'] : ['openFile', 'multiSelections'] })
    if (selected.canceled) return { success: true, cancelled: true, data: session }
    if (selected.filePaths.length > (input.single ? 1 : attachmentImportLimits.maxImportFiles)) throw new AppError('INVALID_ARGUMENT', { message: input.single ? '请选择一个文件。' : '每次最多导入 10 个附件。' })
    await ctx.attachments.importSelectedFiles(input.sessionId, randomUUID(), selected.filePaths)
    return { success: true, data: await ctx.attachments.listSession(input.sessionId) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_IMPORT_FILES, operationInput.extend({ paths: localPaths }).strict(), async (ctx, input) => {
    await ctx.attachments.importFiles(input.sessionId, input.operationId, input.paths, 'paste-file')
    return { success: true, data: await ctx.attachments.listSession(input.sessionId) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_IMPORT_DROP, operationInput.extend({ composerId: id, paths: localPaths }).strict(), async (ctx, input) => {
    await ctx.attachments.importDroppedFiles(input.sessionId, input.operationId, input.composerId, input.paths)
    return { success: true, data: await ctx.attachments.listSession(input.sessionId) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_FOLDER_PREVIEW, sessionInput.extend({ path: z.string().max(4096).refine(value => pastedAttachmentFolderPath(value) === value) }).strict(), async (ctx, input) => {
    if (process.platform !== 'win32') throw new AppError('INVALID_STATE')
    return { success: true, data: await ctx.attachments.previewFolder(input.sessionId, input.path) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_FOLDER_IMPORT, sessionInput.extend({ previewId: id,
    candidateIds: z.array(id).min(1).max(attachmentImportLimits.maxImportFiles).refine(ids => new Set(ids).size === ids.length),
  }).strict(), async (ctx, input) => {
    if (process.platform !== 'win32') throw new AppError('INVALID_STATE')
    return { success: true, data: await ctx.attachments.importFolderSelection(input.sessionId, input.previewId, input.candidateIds) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_IMPORT_IMAGE, operationInput.extend({
    name: z.string().min(1).max(255), type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= attachmentImportLimits.maxFileBytes),
  }).strict(), async (ctx, input) => {
    await ctx.attachments.importImageForSession(input.sessionId, input.operationId, input.bytes, input.name, input.type)
    return { success: true, data: await ctx.attachments.listSession(input.sessionId) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_PREVIEW, attachmentPreviewRequestSchema, async (ctx, input) => {
    if ('sessionId' in input) {
      return { success: true, data: await ctx.attachments.previewDraftAttachment(input.sessionId, input.attachmentId, input.sha256) }
    }
    await ctx.tasks.get(input.taskId)
    return { success: true, data: await ctx.attachments.previewTaskAttachment(input.taskId, input.attachmentId, input.sha256) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_REMOVE, sessionInput.extend({ attachmentId: id, expectedRevision: z.number().int().nonnegative().optional() }).strict(), async (ctx, input) => ({
    success: true, data: await ctx.attachments.removeFromSession(input.sessionId, input.attachmentId, input.expectedRevision),
  }), trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_CANCEL, sessionInput, async (ctx, input) => ({ success: true, cancelled: await ctx.attachments.cancelSession(input.sessionId) }), trusted),
]
