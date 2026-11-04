import { dialog } from 'electron'
import { z } from 'zod'
import { SKILL_IMPORT_ID, SkillImportCancelInputSchema, SkillImportConsentInputSchema, SkillImportDeviceRevokeInputSchema } from '../../../src/shared/skill-import-contracts'
import { appError } from '../../errors/app-error'
import type { SkillImportService } from '../../service/skill-import-service'
import { INVOKE_CHANNELS } from '../channels'
import type { RequestContext } from '../request-context'
import { NO_INPUT, route } from '../router'

const options = { trustedMainFrame: true, errorShape: 'ipc' } as const
function service(ctx: RequestContext): SkillImportService {
  if (!ctx.skillImport) throw appError('SERVICE_UNAVAILABLE', { message: '本机导入暂不可用' })
  return ctx.skillImport
}
export const skillImportRoutes = [
  route(INVOKE_CHANNELS.SKILL_IMPORT_STATE, NO_INPUT, async ctx => ({ success: true, data: await service(ctx).getState() }), options),
  route(INVOKE_CHANNELS.SKILL_IMPORT_CONSENT, SkillImportConsentInputSchema, async (ctx, input) => {
    await service(ctx).confirmConsent(input)
    return { success: true }
  }, options),
  route(INVOKE_CHANNELS.SKILL_IMPORT_SELECT_ROOT, NO_INPUT, async ctx => {
    const window = ctx.window()
    if (!window || window.isDestroyed()) throw appError('SERVICE_UNAVAILABLE')
    const result = await dialog.showOpenDialog(window, { title: '选择 Skills 项目或工作区', properties: ['openDirectory'] })
    if (!result.canceled && result.filePaths[0]) await service(ctx).addProjectRoot(result.filePaths[0])
    return { success: true }
  }, options),
  route(INVOKE_CHANNELS.SKILL_IMPORT_REMOVE_ROOT, z.object({ rootId: SKILL_IMPORT_ID }).strict(), async (ctx, input) => {
    await service(ctx).removeRoot(input.rootId)
    return { success: true }
  }, options),
  route(INVOKE_CHANNELS.SKILL_IMPORT_CANCEL, SkillImportCancelInputSchema, async (ctx, input) => {
    await service(ctx).cancel(input.sessionId)
    return { success: true }
  }, options),
  route(INVOKE_CHANNELS.SKILL_IMPORT_REVOKE, SkillImportDeviceRevokeInputSchema, async (ctx, input) => {
    await service(ctx).revokeDevice(input.deviceId, input.instanceId)
    return { success: true }
  }, options),
  route(INVOKE_CHANNELS.SKILL_IMPORT_VISIBLE, z.object({ visible: z.boolean() }).strict(), (ctx, input) => {
    service(ctx).setVisible(input.visible)
    return { success: true }
  }, options),
]
