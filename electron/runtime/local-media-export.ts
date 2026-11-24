import { localMediaH264Args } from '../domain/local-media-platform'
import { localMediaGifSeconds, type LocalMediaOperation } from '../domain/local-media-tools'

export interface MediaStream {
  index: number
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  duration?: number | string
  nb_frames?: string
  avg_frame_rate?: string
  bit_rate?: number | string
}

interface ExportPlan {
  extension: 'mp4' | 'm4a' | 'mp3' | 'wav' | 'png' | 'gif'
  duration: number | null
  guardBytes: number
  maxBytes?: number
  inputArgs: string[]
  outputArgs: string[]
  videoCodec?: string
  audioCodec?: string
  videoBitrate?: number
  streamDurations?: number[]
  maxDimension?: number
  tolerance?: number
}

const MiB = 1024 ** 2
const minVideoBitrate = 64_000
const audioBitrate = 96_000
const scale = (limit: number) => `scale=w='min(iw,${limit})':h='min(ih,${limit})':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`
const format = {
  wav: { audioCodec: 'pcm_s16le', args: ['-c:a', 'pcm_s16le'], bytesPerSecond: 192_000 },
  mp3: { audioCodec: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '192k'], bytesPerSecond: 24_000 },
  m4a: { audioCodec: 'aac', args: ['-c:a', 'aac', '-b:a', '128k'], bytesPerSecond: 16_000 },
} as const

function streamDuration(stream: MediaStream, fallback: number): number {
  return Number(stream.duration) > 0 ? Number(stream.duration) : fallback
}

function streamFrameDuration(video: MediaStream): number {
  const [numerator, denominator] = (video.avg_frame_rate ?? '').split('/').map(Number)
  return numerator > 0 && denominator > 0 ? denominator / numerator : 0.05
}

export function exportPlan(op: LocalMediaOperation, duration: number, video: MediaStream | undefined, audio: MediaStream[],
  videoBitrate?: number): ExportPlan | undefined {
  if (op.operation === 'extract_audio') {
    const extension = op.format ?? 'm4a'
    const { audioCodec, args, bytesPerSecond } = format[extension]
    const length = streamDuration(audio[0], duration)
    return { extension, duration: length, guardBytes: Math.ceil(length * bytesPerSecond * 1.25 + MiB), inputArgs: [],
      outputArgs: ['-map', `0:${audio[0].index}`, '-vn', ...args, '-ar', '48000', '-ac', '2'], audioCodec, tolerance: 0.12 }
  }
  if (!video) return undefined
  const picture = ['-map', `0:${video.index}`]
  if (op.operation === 'transcode') {
    const maxDimension = op.maxDimension ?? 1920
    const bitrate = videoBitrate ?? (op.maxBytes === undefined ? 4_000_000 : Math.min(4_000_000,
      Math.floor(((op.maxBytes * 0.9 - 2048) * 8 / duration - audioBitrate * audio.length) / 1000) * 1000))
    if (bitrate < minVideoBitrate) throw new Error('指定的大小上限不足以保留完整视频和音轨，请提高上限。')
    // A separate emergency ceiling bounds scratch writes. Crossing it is never considered a successful compression.
    const guardBytes = op.maxBytes === undefined ? Math.ceil(duration * (bitrate + audioBitrate * audio.length) / 8 * 1.4 + 8 * MiB)
      : op.maxBytes + 2 * MiB
    return { extension: 'mp4', duration, guardBytes, maxBytes: op.maxBytes, maxDimension, inputArgs: [], videoBitrate: bitrate,
      outputArgs: [...picture, ...audio.flatMap(track => ['-map', `0:${track.index}`]), '-vf', `${scale(maxDimension)},format=nv12`,
        ...localMediaH264Args(String(bitrate)), '-c:a', 'aac', '-b:a', String(audioBitrate)],
      videoCodec: 'h264', audioCodec: audio.length ? 'aac' : undefined,
      streamDurations: [streamDuration(video, duration), ...audio.map(track => streamDuration(track, duration))],
      tolerance: Math.max(0.12, streamFrameDuration(video) * 1.5),
    }
  }
  const pictureDuration = Math.min(duration, streamDuration(video, duration))
  if (op.operation === 'frame' || op.operation === 'thumbnail_grid') {
    const at = op.operation === 'frame' ? op.at ?? 0 : 0
    if (at >= pictureDuration) throw new Error('抽帧时间必须小于视频画面时长。')
    const filter = op.operation === 'frame' ? scale(1920)
      : `fps=${(9 / pictureDuration).toFixed(9)}:start_time=0:round=up,${scale(320)},tile=3x3:padding=4:margin=4`
    return { extension: 'png', duration: null, guardBytes: 16 * MiB, inputArgs: at ? ['-ss', String(at)] : [],
      outputArgs: [...picture, '-an', '-vf', filter, '-frames:v', '1', '-c:v', 'png', '-f', 'image2', '-update', '1'], videoCodec: 'png' }
  }
  if (op.operation === 'gif') {
    const length = op.end - op.start
    if (length < localMediaGifSeconds.min || length > localMediaGifSeconds.max || op.end > pictureDuration) {
      throw new Error('导出 GIF 片段需在视频画面内，时长为 0.25 到 15 秒。')
    }
    // Bound the clip before palette generation so a long source never gets decoded in full.
    const filter = `[0:${video.index}]fps=10,${scale(480)},split[frames][paletteIn];[paletteIn]palettegen[palette];[frames][palette]paletteuse[out]`
    return { extension: 'gif', duration: length, guardBytes: 48 * MiB, inputArgs: ['-ss', String(op.start), '-t', String(length)],
      outputArgs: ['-filter_complex', filter, '-map', '[out]', '-an', '-loop', '0', '-c:v', 'gif'], videoCodec: 'gif', tolerance: 0.18 }
  }
}

export function lowerVideoBitrate(plan: ExportPlan, actualBytes: number): number | undefined {
  const { maxBytes, videoBitrate, duration, streamDurations } = plan
  if (maxBytes === undefined || !duration || !streamDurations || videoBitrate === undefined || videoBitrate <= minVideoBitrate || actualBytes <= maxBytes) return
  const audioBytes = duration * audioBitrate / 8 * (streamDurations.length - 1)
  const factor = Math.min(0.85, Math.max(0.25, (maxBytes - audioBytes) * 0.9 / Math.max(1, actualBytes - audioBytes)))
  return Math.max(minVideoBitrate, Math.floor(videoBitrate * factor / 1000) * 1000)
}

export function verifyExport(plan: ExportPlan, size: number, duration: number | null, streams: MediaStream[]): void {
  const tolerance = plan.tolerance ?? 0.12
  const video = streams.find(stream => stream.codec_type === 'video')
  const audio = streams.filter(stream => stream.codec_type === 'audio')
  const audioCount = plan.audioCodec ? (plan.streamDurations ? plan.streamDurations.length - 1 : 1) : 0
  if (!size || size >= plan.guardBytes || (plan.maxBytes !== undefined && size > plan.maxBytes) ||
    (plan.duration !== null && (duration === null || Math.abs(duration - plan.duration) > tolerance)) ||
    (plan.videoCodec ? video?.codec_name !== plan.videoCodec || !video.width || !video.height ||
      (plan.maxDimension !== undefined && Math.max(video.width, video.height) > plan.maxDimension) : video !== undefined) ||
    audio.length !== audioCount || audio.some(track => track.codec_name !== plan.audioCodec) ||
    (plan.streamDurations && [video!, ...audio].some((track, i) => !track || !Number(track.duration) ||
      Math.abs(Number(track.duration) - plan.streamDurations![i]) > tolerance))) {
    throw new Error('成品校验未通过，未交付不完整的文件。')
  }
}
