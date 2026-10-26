import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import { z } from 'zod'
import { attachmentImportLimits, attachmentImportTargetSchema } from '../../../src/shared/attachment-contracts'
import { AppError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const sessionInput = z.object({ sessionId: id }).strict()
const operationInput = sessionInput.extend({ operationId: id })
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
  route(INVOKE_CHANNELS.ATTACHMENT_SELECT, sessionInput, async (ctx, input) => {
    const session = await ctx.attachments.listSession(input.sessionId)
    if (!session || session.status !== 'open') throw new AppError('INVALID_STATE')
    const window = ctx.window()
    if (!window) throw new AppError('INTERNAL_ERROR')
    const selected = await dialog.showOpenDialog(window, { title: '添加附件', properties: ['openFile', 'multiSelections'] })
    if (selected.canceled) return { success: true, cancelled: true, data: session }
    if (selected.filePaths.length > attachmentImportLimits.maxFiles) throw new AppError('INVALID_ARGUMENT')
    await ctx.attachments.importFiles(input.sessionId, randomUUID(), selected.filePaths, 'picker')
    return { success: true, data: await ctx.attachments.listSession(input.sessionId) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_IMPORT_FILES, operationInput.extend({ paths: z.array(z.string().min(1).max(4096)).min(1).max(attachmentImportLimits.maxFiles) }).strict(), async (ctx, input) => {
    await ctx.attachments.importFiles(input.sessionId, input.operationId, input.paths, 'paste-file')
    return { success: true, data: await ctx.attachments.listSession(input.sessionId) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_IMPORT_IMAGE, operationInput.extend({
    name: z.string().min(1).max(255), type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= attachmentImportLimits.maxFileBytes),
  }).strict(), async (ctx, input) => {
    await ctx.attachments.importImageForSession(input.sessionId, input.operationId, input.bytes, input.name, input.type)
    return { success: true, data: await ctx.attachments.listSession(input.sessionId) }
  }, trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_REMOVE, sessionInput.extend({ attachmentId: id, expectedRevision: z.number().int().nonnegative().optional() }).strict(), async (ctx, input) => ({
    success: true, data: await ctx.attachments.removeFromSession(input.sessionId, input.attachmentId, input.expectedRevision),
  }), trusted),
  route(INVOKE_CHANNELS.ATTACHMENT_CANCEL, sessionInput, async (ctx, input) => ({ success: true, cancelled: await ctx.attachments.cancelSession(input.sessionId) }), trusted),
]
