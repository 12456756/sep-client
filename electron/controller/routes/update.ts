import type { IpcCommandResult, UpdateStateResult } from '../../../src/shared/ipc'
import type { AppUpdater } from '../../bootstrap/app-updater'
import { appError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import type { RequestContext } from '../request-context'
import { NO_INPUT, route } from '../router'

function requireUpdater(ctx: RequestContext): AppUpdater {
  if (!ctx.updater) {
    throw appError('SERVICE_UNAVAILABLE', { message: '自动更新服务暂不可用' })
  }
  return ctx.updater
}

export const updateRoutes = [
  route(INVOKE_CHANNELS.UPDATE_GET_STATE, NO_INPUT, (ctx): UpdateStateResult => ({
    success: true,
    state: requireUpdater(ctx).getState(),
  }), { errorShape: 'ipc' }),

  route(INVOKE_CHANNELS.UPDATE_CHECK, NO_INPUT, async (ctx): Promise<IpcCommandResult> => {
    await requireUpdater(ctx).check()
    return { success: true }
  }, { errorShape: 'ipc' }),

  route(INVOKE_CHANNELS.UPDATE_DOWNLOAD, NO_INPUT, async (ctx): Promise<IpcCommandResult> => {
    await requireUpdater(ctx).download()
    return { success: true }
  }, { errorShape: 'ipc' }),

  route(INVOKE_CHANNELS.UPDATE_CANCEL, NO_INPUT, async (ctx): Promise<IpcCommandResult> => {
    await requireUpdater(ctx).cancel()
    return { success: true }
  }, { errorShape: 'ipc' }),

  route(INVOKE_CHANNELS.UPDATE_INSTALL, NO_INPUT, async (ctx): Promise<IpcCommandResult> => {
    await requireUpdater(ctx).install()
    return { success: true }
  }, { errorShape: 'ipc' }),
]
