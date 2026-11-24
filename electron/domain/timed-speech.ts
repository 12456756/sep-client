import { z } from 'zod'
import { MAX_SPEECH_SECONDS, speechResultSchema, type SpeechAudio } from '../../src/shared/speech-contracts'

const tokenTimes = z.object({
  tokens: z.array(z.string().max(256)).max(3000),
  timestamps: z.array(z.number().min(0).max(MAX_SPEECH_SECONDS)).max(3000),
}).superRefine(({ tokens, timestamps }, ctx) => {
  if (tokens.length !== timestamps.length || timestamps.some((time, i) => i > 0 && time < timestamps[i - 1])) {
    ctx.addIssue({ code: 'custom', message: 'Invalid token timestamps' })
  }
})

export const timedSpeechResultSchema = speechResultSchema.extend(tokenTimes.shape).strict().superRefine((result, ctx) => {
  if (!tokenTimes.safeParse(result).success) ctx.addIssue({ code: 'custom', message: 'Invalid speech timing' })
})

export type TimedSpeechResult = z.infer<typeof timedSpeechResultSchema>

export interface SubtitleRecognizer {
  recognizeTimed(input: SpeechAudio, signal: AbortSignal): Promise<TimedSpeechResult>
  stop(): void
}
