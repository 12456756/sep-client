import { z } from 'zod'
import { speechAudioSchema, speechBeginSchema, speechRecordingSchema } from '../../../src/shared/speech-contracts'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

const trusted = { trustedMainFrame: true } as const

export const speechRoutes = [
  route(INVOKE_CHANNELS.SPEECH_OPEN_SYSTEM_SETTINGS, NO_INPUT, async ctx => {
    await ctx.speech.openSystemSettings()
    return { success: true }
  }, trusted),
  route(INVOKE_CHANNELS.SPEECH_PERMISSION, NO_INPUT, async ctx => ({ success: true, data: { permission: await ctx.speech.getPermission() } }), trusted),
  route(INVOKE_CHANNELS.SPEECH_SET_ENABLED, z.object({ enabled: z.boolean(), consent: z.boolean().optional() }).strict(), async (ctx, input) => {
    const permission = await ctx.speech.getPermission()
    if (input.enabled && permission !== 'granted' && input.consent !== true) return { success: true, data: { permission } }
    return { success: true, data: { permission: await ctx.speech.setEnabled(input.enabled, async () => input.consent === true) } }
  }, trusted),
  route(INVOKE_CHANNELS.SPEECH_BEGIN, speechBeginSchema, async (ctx, input) => {
    const permission = await ctx.speech.getPermission()
    if (permission === 'prompt' && input.consent !== true) return { success: true, data: { recordingId: input.recordingId, ready: false, permission } }
    return { success: true, data: await ctx.speech.begin(input.recordingId, async () => input.consent === true) }
  }, trusted),
  route(INVOKE_CHANNELS.SPEECH_RECOGNIZE, speechAudioSchema, async (ctx, input) => ({
    success: true, data: await ctx.speech.recognize(input),
  }), trusted),
  route(INVOKE_CHANNELS.SPEECH_CANCEL, speechRecordingSchema, (ctx, input) => {
    ctx.speech.cancel(input.recordingId)
    return { success: true }
  }, trusted),
]
