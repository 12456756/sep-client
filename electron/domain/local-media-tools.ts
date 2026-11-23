import { z } from 'zod'
import type { LocalMediaProgress } from '../../src/shared/local-media-progress'

export { LOCAL_MEDIA_TOOL } from '../../src/shared/local-media-progress'
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const timestamp = z.number().min(0).max(86400)
export const localMediaMotions = ['still', 'zoom-in', 'pan-left', 'pan-right'] as const
export const localMediaCanvases = ['16:9', '9:16', '1:1'] as const
export const localMediaMaxClips = 8
export const localMediaPhotoSeconds = { min: 0.1, max: 300 }
export const localMediaRotations = [90, 180, 270] as const
export const localMediaFits = ['pad', 'crop'] as const
export const localMediaResolutions = [720, 1080] as const
const gain = z.number().min(0).max(1)
const fadeSeconds = z.number().min(0.1).max(5)
const framing = { fit: z.enum(localMediaFits).optional(), rotation: z.literal(localMediaRotations).optional() }
const timelineClip = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), attachmentId: id,
    ...framing, duration: z.number().min(localMediaPhotoSeconds.min).max(localMediaPhotoSeconds.max),
    motion: z.enum(localMediaMotions).optional(),
  }).strict(),
  z.object({ kind: z.literal('video'), attachmentId: id, ...framing,
    start: timestamp.optional(), end: timestamp.optional(), volume: gain.optional(),
  }).strict(),
])
export type LocalMediaTimelineClip = z.infer<typeof timelineClip>
const composeOperation = z.object({ operation: z.literal('compose'), clips: z.array(timelineClip).min(1).max(localMediaMaxClips),
  aspect: z.enum(localMediaCanvases).optional(), resolution: z.literal(localMediaResolutions).optional(),
  transitions: z.array(z.union([z.literal('cut'), fadeSeconds])).max(localMediaMaxClips - 1).optional(),
  fadeIn: fadeSeconds.optional(), fadeOut: fadeSeconds.optional(),
  music: z.object({ attachmentId: id, volume: gain.optional() }).strict().optional(),
  dryRun: z.boolean().optional(),
}).strict()
export type LocalMediaCompose = z.infer<typeof composeOperation>

export const localMediaOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('probe'), attachmentId: id }).strict(),
  z.object({ operation: z.literal('trim'), attachmentId: id, start: timestamp, end: timestamp }).strict(),
  z.object({ operation: z.literal('join'), attachmentIds: z.array(id).min(2).max(localMediaMaxClips) }).strict(),
  composeOperation,
  z.object({ operation: z.literal('extract_audio'), attachmentId: id }).strict(),
  z.object({ operation: z.literal('transcode'), attachmentId: id }).strict(),
])

export interface LocalMediaTool {
  execute(input: unknown, signal?: AbortSignal, onProgress?: (progress: LocalMediaProgress) => void): Promise<unknown>
}
