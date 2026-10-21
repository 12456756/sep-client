import { dialog } from 'electron'
import { z } from 'zod'
import { speechAudioSchema, speechRecordingSchema } from '../../../src/shared/speech-contracts'
import { appError } from '../../errors/app-error'
import { INVOKE_CHANNELS } from '../channels'
import type { RequestContext } from '../request-context'
import { NO_INPUT, route } from '../router'

async function askPermission(ctx: RequestContext): Promise<boolean> {
  const window = ctx.window()
  if (!window) throw appError('INTERNAL_ERROR', { message: '窗口已关闭，请重新打开应用。' })
  const result = await dialog.showMessageBox(window, {
    type: 'question', title: '麦克风权限', message: '允许使用麦克风进行语音输入？',
    detail: '语音在本机离线识别。授权后不再重复询问，可在设置中关闭。',
    buttons: ['允许', '不允许'], defaultId: 1, cancelId: 1,
  })
  return result.response === 0
}

const trusted = { trustedMainFrame: true } as const

export const speechRoutes = [
  route(INVOKE_CHANNELS.SPEECH_OPEN_SYSTEM_SETTINGS, NO_INPUT, async ctx => {
    await ctx.speech.openSystemSettings()
    return { success: true }
  }, trusted),
  route(INVOKE_CHANNELS.SPEECH_PERMISSION, NO_INPUT, async ctx => ({ success: true, data: { permission: await ctx.speech.getPermission() } }), trusted),
  route(INVOKE_CHANNELS.SPEECH_SET_ENABLED, z.object({ enabled: z.boolean() }).strict(), async (ctx, input) => ({
    success: true, data: { permission: await ctx.speech.setEnabled(input.enabled, () => askPermission(ctx)) },
  }), trusted),
  route(INVOKE_CHANNELS.SPEECH_BEGIN, speechRecordingSchema, async (ctx, input) => ({
    success: true, data: await ctx.speech.begin(input.recordingId, () => askPermission(ctx)),
  }), trusted),
  route(INVOKE_CHANNELS.SPEECH_RECOGNIZE, speechAudioSchema, async (ctx, input) => ({
    success: true, data: await ctx.speech.recognize(input),
  }), trusted),
  route(INVOKE_CHANNELS.SPEECH_CANCEL, speechRecordingSchema, (ctx, input) => {
    ctx.speech.cancel(input.recordingId)
    return { success: true }
  }, trusted),
]
