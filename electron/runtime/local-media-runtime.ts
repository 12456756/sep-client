import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, link, lstat, mkdtemp, realpath, rm, rmdir, statfs, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, parse } from 'node:path'
import { z } from 'zod'
import type { ResolvedAttachmentInput } from '../domain/attachment-input'
import { localMediaExecutable, localMediaH264Args } from '../domain/local-media-platform'
import { localMediaOperation, type LocalMediaOperation, type LocalMediaTool } from '../domain/local-media-tools'
import { compositionFilters, compositionFps, compositionInputLimits, compositionInputs, compositionLoudness, resolveComposition } from './local-media-composition'
import { localMediaCandidates, measuredLoudness } from './local-media-analysis'
import { exportPlan, lowerVideoBitrate, verifyExport } from './local-media-export'
import { generateSubtitles, subtitleMaxSeconds, subtitleOutputLimit, subtitleSampleRate } from './local-media-subtitles'
import type { SubtitleRecognizer } from '../domain/timed-speech'
import { logger } from '../common/logger'
import { attachmentAudioVideoType } from '../../src/shared/attachment-media-formats'

const log = logger.child('local-media')
const MiB = 1024 ** 2
const formats = 'mov,mp4,m4a,matroska,webm,mp3,wav,flac,ogg,aac,gif'
const inputOptions = ['-protocol_whitelist', 'file', '-format_whitelist', formats]
const missingAttachmentMessage = '请通过输入框的「+」添加图片或音视频附件，或从文件夹预览中选择并导入素材。'
const missingComponentMessage = '当前客户端的本地音视频组件未就绪，请联系维护人员检查客户端资源。该工具不依赖 Bash 或 Python。'
const positiveString = z.string().transform(Number).pipe(z.number().positive().max(86400))
const positiveNumber = z.coerce.number().positive().optional().catch(undefined)
const probeSchema = z.object({ format: z.object({ duration: positiveString.optional(), format_name: z.string(), bit_rate: positiveNumber }), streams: z.array(z.object({
  index: z.number().int().nonnegative(), duration: positiveString.optional().catch(undefined),
  codec_type: z.string(), codec_name: z.string().optional(), width: z.number().int().optional(), height: z.number().int().optional(),
  pix_fmt: z.string().optional(), avg_frame_rate: z.string().optional(), nb_frames: z.string().optional(),
  bit_rate: positiveNumber, channels: positiveNumber, sample_rate: positiveNumber,
  display_aspect_ratio: z.string().optional(), side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).optional(),
})).max(64) })
type MediaProbe = z.infer<typeof probeSchema> & { streamSignature: string }
type SingleOperation = Exclude<LocalMediaOperation, { operation: 'list' | 'batch_transcode' }>
type MediaResult = { file: string; durationSeconds: number | null; bytes: number }
const unsupportedAttachment = '素材不属于本会话或格式不受支持。'

function mediaError(error: unknown, writingTo: 'scratch' | 'output' = 'scratch'): string {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'ENOSPC' || error.code === 'EDQUOT') return writingTo === 'scratch'
      ? '音视频临时目录空间不足，请更改位置或释放空间。' : '成果目录空间不足，请释放空间后重试。'
    if (['EPERM', 'EACCES', 'EXDEV', 'ENOTSUP', 'ENOENT'].includes(String(error.code))) return '无法在所选目录处理或保存文件，请检查目录是否可写。'
  }
  return error instanceof Error && /^[\p{Script=Han}]/u.test(error.message) ? error.message : '本地音视频处理失败，请检查素材后重试。'
}

function frameRate(value?: string): number | null {
  const [n, d] = (value ?? '').split('/').map(Number)
  return n > 0 && d > 0 ? n / d : null
}
const imageDemuxers = { 'image/jpeg': 'jpeg_pipe', 'image/png': 'png_pipe', 'image/webp': 'webp_pipe' } as const
type ImageDemuxer = typeof imageDemuxers[keyof typeof imageDemuxers]

function imageDemuxer(input: ResolvedAttachmentInput): ImageDemuxer | undefined {
  const ext = extname(input.displayName).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : undefined
  return mime && input.mediaType === mime ? imageDemuxers[mime] : undefined
}

function inputKind(input: ResolvedAttachmentInput): 'image' | 'video' | 'audio' | undefined {
  if (!input.readPath) return undefined
  if (imageDemuxer(input)) return 'image'
  if (input.mediaType !== 'application/octet-stream' && !/^(audio|video)\//.test(input.mediaType)) return undefined
  const mediaType = attachmentAudioVideoType(extname(input.displayName))
  return mediaType?.startsWith('video/') ? 'video' : mediaType ? 'audio' : undefined
}

function mediaInputOptions(image?: ImageDemuxer): string[] {
  return image ? ['-protocol_whitelist', 'file', '-format_whitelist', image, '-f', image] : inputOptions
}

export function assertLocalMediaDiskSpace(sameVolume: boolean, scratchFree: bigint, outputFree: bigint, scratchBytes: number, outputBytes: number): void {
  const reserve = 16 * MiB
  if (scratchFree < BigInt(scratchBytes + reserve)) throw new Error('音视频临时目录空间不足，请更改位置或释放空间。')
  if (outputFree < BigInt(outputBytes + (sameVolume ? scratchBytes : 0) + reserve)) {
    throw new Error('成果目录空间不足，请释放空间后重试。')
  }
}

async function sameMediaVolume(temp: string, output: string): Promise<boolean> {
  const [scratch, result] = await Promise.all([lstat(temp, { bigint: true }), lstat(output, { bigint: true })])
  if (process.platform === 'win32' && (!scratch.dev || !result.dev)) return parse(temp).root.toLowerCase() === parse(output).root.toLowerCase()
  return scratch.dev === result.dev
}

interface BindOptions {
  attachments: readonly ResolvedAttachmentInput[]
  resolveAttachment: (input: ResolvedAttachmentInput) => Promise<ResolvedAttachmentInput | undefined>
  assertActive: (signal?: AbortSignal) => void
  runSignal: AbortSignal
  artifactPath: string
  artifactRelativePath: string
  checkArtifact: () => Promise<boolean>
  authorize: (input: unknown) => Promise<boolean>
}

export function localMediaInput(input: ResolvedAttachmentInput): boolean {
  return inputKind(input) !== undefined
}

export class LocalMediaRuntime {
  private busy = false

  constructor(private readonly binDir: string, private readonly prepareTemp: () => Promise<string>,
    private readonly createSubtitleRecognizer?: () => Promise<SubtitleRecognizer>) {}

  bind(options: BindOptions): LocalMediaTool {
    const enabled = new Map(options.attachments.filter(localMediaInput).map(input => [input.attachmentId, input]))
    return { execute: (input, signal, onProgress) => this.execute(input, signal, options, enabled, onProgress) }
  }

  private async hasExecutables(): Promise<boolean> {
    const files = await Promise.all((['ffmpeg', 'ffprobe'] as const).map(async tool => {
      const file = await lstat(join(this.binDir, localMediaExecutable(tool))).catch(() => undefined)
      return !!file?.isFile() && (process.platform === 'win32' || !!(file.mode & 0o111))
    }))
    return files.every(Boolean)
  }

  private async execute(input: unknown, toolSignal: AbortSignal | undefined, ctx: BindOptions,
    available: ReadonlyMap<string, ResolvedAttachmentInput>, onProgress: Parameters<LocalMediaTool['execute']>[2]): Promise<unknown> {
    const parsed = localMediaOperation.safeParse(input)
    if (!parsed.success) throw new Error('音视频参数不正确。')
    const op = parsed.data
    const signal = toolSignal ? AbortSignal.any([toolSignal, ctx.runSignal]) : ctx.runSignal
    ctx.assertActive(signal)
    if (op.operation === 'list') {
      const files = [...available.values()].map(item => ({ attachmentId: item.attachmentId, displayName: item.displayName, kind: inputKind(item) }))
      if (!files.length) return { files, message: missingAttachmentMessage }
      const ready = await this.hasExecutables()
      ctx.assertActive(signal)
      return ready ? { files } : { files, message: missingComponentMessage }
    }
    if (!available.size) throw new Error(missingAttachmentMessage)
    const batch = op.operation === 'batch_transcode'
    const inputs = op.operation === 'compose' ? compositionInputs(op) : undefined
    const ids = op.operation === 'compose' ? (inputs ?? []).map(source => source.id)
      : batch ? [...new Set(op.attachmentIds)]
      : op.operation === 'join' ? op.attachmentIds : [op.attachmentId]
    const originals = ids.map(id => available.get(id)).filter(item => item !== undefined)
    if (!originals.length || (!batch && originals.length !== ids.length)) throw new Error(unsupportedAttachment)
    const mismatch = inputs?.find((source, index) => source.kind !== inputKind(originals[index]))
    if (mismatch) {
      throw new Error({
        clip: '合成只支持图片和视频，请检查片段类型是否与所选素材一致。',
        music: '配乐请选择本会话中的音频附件。',
        watermark: '水印请选择本会话中的图片附件。',
        pip: '画中画请选择本会话中的视频附件。',
      }[mismatch.role])
    }
    if (!batch && op.operation !== 'compose' && op.operation !== 'probe' && originals.some(item => !!imageDemuxer(item))) {
      if (op.operation === 'subtitle') throw new Error('生成字幕需要包含语音的音频或视频附件。')
      throw new Error(op.operation === 'analyze' ? '静音和场景检测需要音频或视频素材。' : '图片请使用合成功能，先指定每张图的显示时长。')
    }
    if (op.operation === 'subtitle' && !this.createSubtitleRecognizer) throw new Error('本地字幕组件未就绪，请检查客户端安装资源。')
    if (op.operation === 'trim' && op.end <= op.start) throw new Error('结束时间必须大于开始时间。')
    if (!await this.hasExecutables()) throw new Error(missingComponentMessage)
    ctx.assertActive(signal)
    if (op.operation !== 'probe' && op.operation !== 'analyze' && op.operation !== 'compose' && !await ctx.authorize({ ...op, files: originals.map(item => item.displayName) })) {
      throw new Error('未授权本次音视频处理。')
    }
    ctx.assertActive(signal)
    if (this.busy) throw new Error('已有音视频任务正在执行，请稍后重试。')
    this.busy = true
    try {
      if (!batch) return await this.runSingle(op, originals, signal, ctx, onProgress)
      const results = []
      for (const [index, attachmentId] of ids.entries()) {
        ctx.assertActive(signal)
        const item = available.get(attachmentId)
        const identity = { attachmentId, ...(item && { name: item.displayName }) }
        try {
          if (!item) throw new Error(unsupportedAttachment)
          if (imageDemuxer(item)) throw new Error('图片不支持视频批量转码。')
          const result = await this.runSingle({ operation: 'transcode', attachmentId, maxBytes: op.maxBytes, maxDimension: op.maxDimension },
            [item], signal, ctx, onProgress && (progress => onProgress({ ...progress, item: index + 1, total: ids.length }))) as MediaResult
          results.push({ ...identity, status: 'ok', ...result })
        } catch (error) {
          ctx.assertActive(signal)
          results.push({ ...identity, status: 'failed', error: mediaError(error) })
        }
      }
      return { results }
    } finally { this.busy = false }
  }

  private async runSingle(op: SingleOperation, originals: readonly ResolvedAttachmentInput[], signal: AbortSignal, ctx: BindOptions,
    onProgress: Parameters<LocalMediaTool['execute']>[2]): Promise<unknown> {
    let work: string | undefined
    let writingTo: 'scratch' | 'output' = 'scratch'
    try {
      onProgress?.({ phase: 'probe' })
      const paths: string[] = []
      const probes: MediaProbe[] = []
      const images = originals.map(imageDemuxer)
      const probed = new Map<string, { path: string; probe: MediaProbe }>()
      for (const [index, original] of originals.entries()) {
        const cached = probed.get(original.attachmentId)
        if (cached) { paths.push(cached.path); probes.push(cached.probe); continue }
        const item = await ctx.resolveAttachment(original)
        ctx.assertActive(signal)
        if (!item?.readPath || !isAbsolute(item.readPath)) throw new Error('素材无法读取。')
        const probe = await this.probe(item.readPath, signal, images[index], op.operation !== 'join')
        probed.set(original.attachmentId, { path: item.readPath, probe })
        paths.push(item.readPath)
        probes.push(probe)
      }
      const media = probes.map(({ streams }) => ({
        video: streams.find(item => item.codec_type === 'video' && item.disposition?.attached_pic !== 1),
        audio: streams.find(item => item.codec_type === 'audio'),
      }))
      if (op.operation === 'probe') {
        const { video, audio } = media[0]
        const rotation = video?.side_data_list?.find(side => side.rotation !== undefined)?.rotation ?? 0
        const swaps = Math.abs(rotation) % 180 === 90
        const ratio = video?.display_aspect_ratio?.split(':').map(Number)
        return { kind: inputKind(originals[0]), durationSeconds: images[0] ? null : probes[0].format.duration,
          format: probes[0].format.format_name, bitrate: probes[0].format.bit_rate ?? null, audio: !!audio,
          audioTracks: probes[0].streams.filter(stream => stream.codec_type === 'audio'),
          video: video && { ...video, rotation, displayWidth: swaps ? video.height : video.width, displayHeight: swaps ? video.width : video.height,
            aspectRatio: ratio?.length === 2 && ratio.every(n => n > 0) ? (swaps ? [...ratio].reverse() : ratio).join(':') : null,
            frameRate: frameRate(video.avg_frame_rate) },
        }
      }
      const composition = op.operation === 'compose' ? resolveComposition(op, media.map((item, index) => ({ ...item,
        name: originals[index].displayName, duration: probes[index].format.duration }))) : undefined
      const duration = composition ? composition.summary.durationSeconds
        : probes.reduce((sum, item) => sum + item.format.duration!, 0)
      if (op.operation === 'subtitle' && duration > subtitleMaxSeconds) throw new Error('暂不支持为超过 60 分钟的素材生成字幕，请先分段。')
      if (duration > 3600) throw new Error('暂不支持总时长超过 60 分钟的音视频处理。')
      if (op.operation === 'analyze') {
        const mode = op.mode ?? 'both'
        const audio = mode !== 'scenes' ? media[0].audio : undefined
        const video = mode !== 'silence' ? media[0].video : undefined
        if (!audio && !video) throw new Error(mode === 'silence' ? '素材没有可检测静音的音轨。' : '素材没有可检测场景的视频画面。')
        const collector = localMediaCandidates(duration)
        const soundArgs = audio ? ['-map', `0:${audio.index}`, '-af', 'silencedetect@candidate=noise=-35dB:duration=0.5'] : ['-an']
        const pictureArgs = video ? ['-map', `0:${video.index}`, '-vf',
          "scale=w='min(iw,320)':h='min(ih,320)':force_original_aspect_ratio=decrease:force_divisible_by=2,select='gt(scene,0.35)',showinfo@candidate=checksum=0",
          '-fps_mode', 'passthrough'] : ['-vn']
        await this.run('ffmpeg', ['-nostdin', '-xerror', '-filter_threads', '2', ...inputOptions, ...compositionInputLimits, '-i', paths[0],
          ...soundArgs, ...pictureArgs, '-t', String(duration), '-f', 'null', '-'], signal, 5 * 60_000, undefined,
        { logLevel: 'info', onLogLine: collector.read })
        ctx.assertActive(signal)
        return { durationSeconds: duration, silenceAnalyzed: !!audio, scenesAnalyzed: !!video, ...collector.result() }
      }
      const subtitle = op.operation === 'subtitle'
      if (subtitle && !media[0].audio) throw new Error('素材没有可识别字幕的音轨。')
      if (op.operation === 'trim' && op.end > duration + 0.05) throw new Error('结束时间超过素材时长。')
      const audio = op.operation === 'extract_audio' || (op.operation === 'trim' && !media[0].video)
      if (!subtitle && !composition && (audio ? !media[0].audio : media.some(item => !item.video))) {
        throw new Error(audio ? '素材没有可处理的音轨。' : '素材没有可处理的视频画面。')
      }
      const isJoin = op.operation === 'join'
      if (isJoin && !probes.every((item, index) => item.format.format_name.includes('mp4') &&
        item.streams.length <= 2 && media[index].video?.codec_name === 'h264' &&
        item.streamSignature === probes[0].streamSignature &&
        item.streams.every(stream => stream.codec_type === 'video' || (stream.codec_type === 'audio' && stream.codec_name === 'aac')))) {
        throw new Error('仅支持直接拼接编码、分辨率和音轨配置相同的 H.264 MP4 片段。')
      }
      const audioTracks = probes[0].streams.filter(stream => stream.codec_type === 'audio')
      const planExport = (bitrate?: number) => exportPlan(op, duration, media[0].video, audioTracks, bitrate)
      const exportArgs = (spec: NonNullable<ReturnType<typeof planExport>>) =>
        [...inputOptions, ...compositionInputLimits, ...spec.inputArgs, '-i', paths[0], ...spec.outputArgs]
      let exportSpec = planExport()
      const outputDuration = exportSpec?.duration ?? (op.operation === 'trim' ? op.end - op.start : duration)
      const inputBytes = originals.reduce((sum, item) => sum + item.byteLength, 0)
      const fullHD = composition?.summary.resolution === 1080
      const maxBytes = exportSpec?.guardBytes ?? Math.ceil(isJoin ? inputBytes + duration * 32000 + 8 * MiB : outputDuration * (audio ? 32000 : fullHD ? 1130000 : 600000) * 1.3 + 8 * MiB)
      if (op.operation === 'compose' && composition) {
        ctx.assertActive(signal)
        if (op.dryRun) return { plan: composition.summary, estimatedBytesUpperBound: maxBytes }
        if (!await ctx.authorize({ operation: 'compose', plan: composition.summary })) {
          throw new Error('未授权本次音视频处理。')
        }
        ctx.assertActive(signal)
      }
      const temp = await this.prepareTemp()
      writingTo = 'output'
      if (!await ctx.checkArtifact()) throw new Error('成果目录不可用。')
      const output = await realpath(ctx.artifactPath)
      await rmdir(await mkdtemp(join(output, '.csep-write-')))
      const pcmLimit = Math.ceil(duration + 1) * subtitleSampleRate * 2
      const totalInTemp = subtitle ? pcmLimit + subtitleOutputLimit : maxBytes + (isJoin ? inputBytes : 0)
      const [scratchSpace, resultSpace, sameVolume] = await Promise.all([statfs(temp, { bigint: true }), statfs(output, { bigint: true }), sameMediaVolume(temp, output)])
      assertLocalMediaDiskSpace(sameVolume, scratchSpace.bavail * scratchSpace.bsize, resultSpace.bavail * resultSpace.bsize,
        totalInTemp, subtitle ? subtitleOutputLimit : exportSpec?.maxBytes ?? maxBytes)
      ctx.assertActive(signal)
      writingTo = 'scratch'
      work = await mkdtemp(join(temp, 'csep-media-'))
      if (subtitle) {
        const pcm = join(work, 'speech.pcm')
        onProgress?.({ phase: 'render' })
        await this.run('ffmpeg', ['-nostdin', '-n', '-xerror', '-filter_threads', '2', ...inputOptions, '-threads', '2', '-i', paths[0],
          '-map', `0:${media[0].audio!.index}`, '-vn', '-sn', '-dn', '-af', `aresample=${subtitleSampleRate}:async=1:first_pts=0`,
          '-ac', '1', '-c:a', 'pcm_s16le', '-t', String(duration), '-fs', String(pcmLimit), '-f', 's16le', pcm], signal, 5 * 60_000, work)
        ctx.assertActive(signal)
        onProgress?.({ phase: 'subtitle', percent: 0 })
        const result = await generateSubtitles(pcm, duration, this.createSubtitleRecognizer!, signal, percent => {
          ctx.assertActive(signal)
          onProgress?.({ phase: 'subtitle', percent })
        })
        ctx.assertActive(signal)
        const target = join(work, 'result.srt')
        await writeFile(target, result.srt, { flag: 'wx', encoding: 'utf8' })
        onProgress?.({ phase: 'verify' })
        const bytes = (await lstat(target)).size
        if (bytes !== Buffer.byteLength(result.srt)) throw new Error('字幕文件校验未通过。')
        writingTo = 'output'
        const file = await this.publish(target, 'subtitle', 'srt', output, ctx, signal, onProgress)
        return { file, durationSeconds: duration, bytes, cueCount: result.cueCount, reviewRequired: true }
      }
      const extension = exportSpec?.extension ?? (audio ? 'm4a' : 'mp4')
      const target = join(work, `result.${extension}`)
      let args: string[]
      if (isJoin) {
        const names = paths.map((_, index) => `clip${index}.mp4`)
        for (const [index, path] of paths.entries()) {
          ctx.assertActive(signal)
          await copyFile(path, join(work, names[index]), constants.COPYFILE_EXCL)
        }
        const list = join(work, 'clips.ffconcat')
        await writeFile(list, `ffconcat version 1.0\n${names.map(name => `file ${name}\n`).join('')}`, { flag: 'wx' })
        args = ['-protocol_whitelist', 'file', '-format_whitelist', 'concat,mov,mp4,m4a', '-f', 'concat', '-safe', '1', '-i', list,
          '-map', '0:V:0', '-map', '0:a:0?', '-c:v', 'copy', ...(media[0].audio ? ['-af', 'asetpts=N/SR/TB', '-c:a', 'aac', '-b:a', '128k'] : [])]
      } else if (composition) {
        args = [...paths.flatMap((path, index) => [...mediaInputOptions(images[index]), ...compositionInputLimits, '-i', path]),
          '-filter_complex', compositionFilters(composition), '-map', '[vout]', '-map', '[aout]',
          '-r', String(compositionFps), ...localMediaH264Args(fullHD ? '8M' : '4M'), '-c:a', 'aac', '-b:a', '128k']
      } else if (exportSpec) {
        args = exportArgs(exportSpec)
      } else {
        args = [...inputOptions, '-threads', '2', ...(op.operation === 'trim' ? ['-ss', String(op.start)] : []), '-i', paths[0],
          ...(op.operation === 'trim' ? ['-t', String(outputDuration)] : []),
          ...(audio ? ['-map', '0:a:0', '-vn'] : ['-map', '0:V:0', '-map', '0:a:0?', '-vf', "scale=w='min(iw,1920)':h='min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=nv12", ...localMediaH264Args('4M')]),
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
      }
      onProgress?.({ phase: 'render' })
      let lastPercent = -10
      const renderProgress = onProgress && exportSpec?.maxBytes === undefined ? (microseconds: number) => {
        const percent = Math.min(99, Math.floor(microseconds / 1e4 / (outputDuration ?? duration)))
        if (percent >= lastPercent + 10 && !signal.aborted) {
          lastPercent = percent
          onProgress({ phase: 'render', percent })
        }
      } : undefined
      const deadline = Date.now() + 15 * 60_000
      let size: number
      for (let attempt = 0; ; attempt++) {
        const timeLeft = deadline - Date.now()
        if (timeLeft <= 0) throw new Error('音视频处理超时。')
        await this.run('ffmpeg', ['-nostdin', '-n', '-xerror', '-filter_threads', '2', '-filter_complex_threads', '2', ...args,
          '-map_metadata', '-1', '-map_chapters', '-1', '-fs', String(maxBytes),
          ...(extension === 'm4a' || extension === 'mp4' ? ['-movflags', '+faststart'] : []), target], signal, timeLeft, work, { onTime: renderProgress })
        size = (await lstat(target)).size
        if (exportSpec?.maxBytes === undefined || size <= exportSpec.maxBytes) break
        const bitrate = attempt < 2 ? lowerVideoBitrate(exportSpec, size) : undefined
        if (bitrate === undefined) throw new Error('成品超过指定大小，未保存。请提高上限或降低分辨率。')
        ctx.assertActive(signal)
        await unlink(target)
        exportSpec = planExport(bitrate)!
        args = exportArgs(exportSpec)
      }
      onProgress?.({ phase: 'verify' })
      const verified = await this.probe(target, signal, extension === 'png' ? 'png_pipe' : undefined, false, work)
      const verifiedDuration = extension === 'png' ? null : verified.format.duration!
      if (exportSpec) verifyExport(exportSpec, size, verifiedDuration, verified.streams)
      else if (!size || size >= maxBytes || verifiedDuration === null || Math.abs(verifiedDuration - outputDuration) > (composition ? 0.075 : Math.max(0.75, outputDuration * 0.01)) ||
        (composition && (!verified.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264' &&
          stream.width === composition.width && stream.height === composition.height && stream.avg_frame_rate === `${compositionFps}/1` &&
          Number(stream.nb_frames) === composition.total) || !verified.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac' &&
          stream.duration !== undefined && Math.abs(stream.duration - outputDuration) <= 0.075))) ||
        !verified.streams.some(stream => stream.codec_type === (audio ? 'audio' : 'video'))) throw new Error('成品校验未通过，未交付不完整的文件。')
      const loudness = composition?.audio.normalize ? measuredLoudness(await this.run('ffmpeg', ['-nostdin', '-xerror', ...inputOptions,
        '-i', target, '-map', '0:a:0', '-vn', '-af', `${compositionLoudness}:print_format=json`, '-f', 'null', '-'],
        signal, 5 * 60_000, work, { logLevel: 'info', returnStderr: true })) : undefined
      ctx.assertActive(signal)
      writingTo = 'output'
      const file = await this.publish(target, op.operation, extension, output, ctx, signal, onProgress)
      return { file, durationSeconds: verifiedDuration, bytes: size,
        ...(loudness && { loudness: { targetLufs: -16, ...loudness } }) }
    } catch (error) {
      if (signal.aborted) throw new Error('音视频处理已取消。')
      throw new Error(mediaError(error, writingTo))
    } finally {
      try {
        // FFmpeg receives an explicit work directory; remove only the private directory created for this run.
        if (work && basename(work).startsWith('csep-media-') && await realpath(work).catch(() => '') === work) {
          await rm(work, { recursive: true, force: true })
        }
      } catch { log.warn('local media scratch cleanup failed') }
    }
  }

  private async publish(target: string, operation: string, extension: string, output: string, ctx: BindOptions, signal: AbortSignal,
    onProgress: Parameters<LocalMediaTool['execute']>[2]): Promise<string> {
    if (!await ctx.checkArtifact() || await realpath(ctx.artifactPath) !== output) throw new Error('成果目录已不可用。')
    const filename = `${operation}-${randomUUID().slice(0, 12)}.${extension}`
    onProgress?.({ phase: 'save' })
    ctx.assertActive(signal)
    const partial = join(output, `${filename}.partial`)
    let copied = false
    try {
      await copyFile(target, partial, constants.COPYFILE_EXCL)
      copied = true
      ctx.assertActive(signal)
      const published = join(output, filename)
      await link(partial, published)
      try { ctx.assertActive(signal) } catch (error) { await unlink(published).catch(() => undefined); throw error }
      return `${ctx.artifactRelativePath}/${filename}`
    } finally {
      if (copied) await unlink(partial).catch(() => log.warn('local media partial output cleanup failed'))
    }
  }

  private async probe(path: string, signal: AbortSignal, image?: ImageDemuxer, composing = false, cwd?: string): Promise<MediaProbe> {
    const value = await this.run('ffprobe', [...mediaInputOptions(image), ...(image || composing ? compositionInputLimits : []), '-show_data_hash', 'sha256', '-show_entries',
      'format=duration,format_name,bit_rate:stream=index,duration,codec_type,codec_name,width,height,pix_fmt,sample_rate,channels,channel_layout,r_frame_rate,avg_frame_rate,nb_frames,time_base,extradata_hash,bit_rate,display_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation',
      '-of', 'json', path], signal, 30_000, cwd)
    try {
      const raw: unknown = JSON.parse(value)
      const result = probeSchema.parse(raw)
      if (image ? !result.streams.some(stream => stream.codec_type === 'video' && stream.width && stream.height) : !result.format.duration) throw new Error()
      const streams = (raw as { streams: Array<Record<string, unknown>> }).streams
      return { ...result, streamSignature: JSON.stringify(streams.map(({ duration: _duration, index: _index, nb_frames: _count,
        avg_frame_rate: _avg, bit_rate: _bitRate, ...stream }) => stream)) }
    } catch { throw new Error(image ? '无法识别图片，请检查文件是否完整。' : '无法识别素材时长或音视频格式。') }
  }

  private run(tool: 'ffmpeg' | 'ffprobe', args: string[], signal: AbortSignal, timeout: number, cwd?: string,
    { onTime, logLevel = 'error', onLogLine, returnStderr }: { onTime?: (microseconds: number) => void; logLevel?: 'info' | 'error';
      onLogLine?: (line: string) => void; returnStderr?: boolean } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const executable = join(this.binDir, localMediaExecutable(tool))
      const temp = cwd ?? dirname(executable)
      const child = spawn(executable, ['-hide_banner', '-v', logLevel, ...(tool === 'ffmpeg' ? ['-nostats'] : []),
        ...(onTime ? ['-progress', 'pipe:1'] : []), ...args], { shell: false, windowsHide: true,
        cwd: temp, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: temp, TMP: temp, TMPDIR: temp }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let logLine = ''
      let failure: Error | undefined
      const cancel = () => { failure = new Error('音视频处理已取消。'); child.kill() }
      const timer = setTimeout(() => { failure = new Error('音视频处理超时。'); child.kill() }, timeout)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (onTime) {
          const lines = stdout.split('\n')
          stdout = lines.pop()!.slice(-1024)
          for (const line of lines) {
            const match = /^out_time_us=(\d+)\s*$/.exec(line)
            if (match) onTime(Number(match[1]))
          }
          return
        }
        if (stdout.length > 128 * 1024) { failure = new Error('音视频探测结果超过限制。'); child.kill() }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderr = (stderr + text).slice(-4096)
        if (onLogLine) {
          const lines = (logLine + text).split('\n')
          logLine = lines.pop()!.slice(-2048)
          for (const line of lines) onLogLine(line)
        }
      })
      child.once('error', () => { failure = new Error('无法启动本地音视频组件。') })
      child.once('close', code => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (failure) reject(failure)
        else if (code === 0) { if (logLine) onLogLine?.(logLine); resolve(returnStderr ? stderr : stdout) }
        else if (/no space left|disk full/i.test(stderr)) reject(new Error('音视频临时目录空间不足，请更改位置或释放空间。'))
        else if (/exceeds specified max pixel count/i.test(stderr)) reject(new Error('素材分辨率超出合成限制，请缩小图片或视频尺寸后重试。'))
        else if (/h264_mf|media foundation/i.test(stderr)) reject(new Error('本机 H.264 编码不可用，请检查 Windows 的媒体功能。'))
        else if (/h264_videotoolbox|VTCompressionSession/i.test(stderr)) reject(new Error('本机 H.264 编码不可用，请检查 macOS 的视频编码支持。'))
        else reject(new Error('本地音视频处理失败，请检查素材是否完整、格式是否受支持。'))
      })
    })
  }
}
