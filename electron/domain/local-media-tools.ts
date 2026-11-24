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
export const localMediaAudioFormats = ['m4a', 'mp3', 'wav'] as const
export const localMediaExportDimensions = [480, 720, 1080, 1920] as const
export const localMediaMaxBytes = 1024 ** 3
export const localMediaGifSeconds = { min: 0.25, max: 15 }
export const localMediaCorners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
export const localMediaSpeed = { min: 0.5, max: 2 }
export const localMediaFreezeMax = 15
export const localMediaOverlaySize = { min: 0.1, max: 0.5 }
export const localMediaAnalysisModes = ['silence', 'scenes', 'both'] as const
const transcodeOptions = {
  maxBytes: z.number().int().min(1).max(localMediaMaxBytes).optional(),
  maxDimension: z.literal(localMediaExportDimensions).optional(),
}
const gain = z.number().min(0).max(1)
const fadeSeconds = z.number().min(0.1).max(5)
const framing = { fit: z.enum(localMediaFits).optional(), rotation: z.literal(localMediaRotations).optional() }
const overlay = { attachmentId: id, position: z.enum(localMediaCorners).optional(),
  size: z.number().min(localMediaOverlaySize.min).max(localMediaOverlaySize.max).optional() }
const timelineClip = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), attachmentId: id,
    ...framing, duration: z.number().min(localMediaPhotoSeconds.min).max(localMediaPhotoSeconds.max),
    motion: z.enum(localMediaMotions).optional(),
  }).strict(),
  z.object({ kind: z.literal('video'), attachmentId: id, ...framing,
    start: timestamp.optional(), end: timestamp.optional(), volume: gain.optional(),
    speed: z.number().min(localMediaSpeed.min).max(localMediaSpeed.max).optional(),
    freeze: z.number().min(0.1).max(localMediaFreezeMax).optional(),
  }).strict(),
])
export type LocalMediaTimelineClip = z.infer<typeof timelineClip>
const composeOperation = z.object({ operation: z.literal('compose'), clips: z.array(timelineClip).min(1).max(localMediaMaxClips),
  aspect: z.enum(localMediaCanvases).optional(), resolution: z.literal(localMediaResolutions).optional(),
  transitions: z.array(z.union([z.literal('cut'), fadeSeconds])).max(localMediaMaxClips - 1).optional(),
  fadeIn: fadeSeconds.optional(), fadeOut: fadeSeconds.optional(),
  music: z.object({ attachmentId: id, volume: gain.optional() }).strict().optional(),
  intro: timelineClip.optional(), outro: timelineClip.optional(),
  watermark: z.object({ ...overlay, opacity: z.number().min(0.1).max(1).optional() }).strict().optional(),
  pip: z.object({ ...overlay, at: timestamp.optional(), start: timestamp.optional(), end: timestamp.optional() }).strict().optional(),
  audio: z.object({ denoise: z.boolean().optional(), normalize: z.boolean().optional(), duckMusic: z.boolean().optional() }).strict().optional(),
  dryRun: z.boolean().optional(),
}).strict()
export type LocalMediaCompose = z.infer<typeof composeOperation>

export function localMediaTimeline(op: LocalMediaCompose): LocalMediaTimelineClip[] {
  return [...(op.intro ? [op.intro] : []), ...op.clips, ...(op.outro ? [op.outro] : [])]
}

export const localMediaOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('probe'), attachmentId: id }).strict(),
  z.object({ operation: z.literal('analyze'), attachmentId: id, mode: z.enum(localMediaAnalysisModes).optional() }).strict(),
  z.object({ operation: z.literal('subtitle'), attachmentId: id }).strict(),
  z.object({ operation: z.literal('trim'), attachmentId: id, start: timestamp, end: timestamp }).strict(),
  z.object({ operation: z.literal('join'), attachmentIds: z.array(id).min(2).max(localMediaMaxClips) }).strict(),
  composeOperation,
  z.object({ operation: z.literal('extract_audio'), attachmentId: id, format: z.enum(localMediaAudioFormats).optional() }).strict(),
  z.object({ operation: z.literal('transcode'), attachmentId: id, ...transcodeOptions }).strict(),
  z.object({ operation: z.literal('batch_transcode'), attachmentIds: z.array(id).min(1).max(localMediaMaxClips), ...transcodeOptions }).strict(),
  z.object({ operation: z.literal('frame'), attachmentId: id, at: timestamp.optional() }).strict(),
  z.object({ operation: z.literal('thumbnail_grid'), attachmentId: id }).strict(),
  z.object({ operation: z.literal('gif'), attachmentId: id, start: timestamp, end: timestamp }).strict(),
])
export type LocalMediaOperation = z.infer<typeof localMediaOperation>

export interface LocalMediaTool {
  execute(input: unknown, signal?: AbortSignal, onProgress?: (progress: LocalMediaProgress) => void): Promise<unknown>
}
