import { z } from 'zod'

export const MAX_SPEECH_SECONDS = 30
export const speechPermissionSchema = z.enum(['prompt', 'granted', 'denied'])
export type SpeechPermission = z.infer<typeof speechPermissionSchema>
export const speechRecordingSchema = z.object({ recordingId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) }).strict()
export const speechBeginSchema = speechRecordingSchema.extend({ consent: z.boolean().optional() }).strict()
export const speechAudioSchema = speechRecordingSchema.extend({
  sampleRate: z.number().int().min(8000).max(96000),
  samples: z.instanceof(Float32Array),
}).strict().superRefine((input, ctx) => {
  if (!input.samples.length || input.samples.length > input.sampleRate * MAX_SPEECH_SECONDS) {
    ctx.addIssue({ code: 'custom', path: ['samples'], message: 'Invalid recording length' })
    return
  }
  for (const sample of input.samples) {
    if (!Number.isFinite(sample) || Math.abs(sample) > 1) {
      ctx.addIssue({ code: 'custom', path: ['samples'], message: 'Invalid normalized PCM' })
      return
    }
  }
})
export type SpeechAudio = z.infer<typeof speechAudioSchema>
export const speechStartSchema = speechRecordingSchema.extend({ ready: z.boolean(), permission: speechPermissionSchema }).strict()
export type SpeechStart = z.infer<typeof speechStartSchema>
export const speechResultSchema = speechRecordingSchema.extend({ text: z.string().max(20000), silent: z.boolean() }).strict()
export type SpeechResult = z.infer<typeof speechResultSchema>
