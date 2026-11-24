import { localMediaMaxClips, localMediaTimeline, type LocalMediaCompose, type LocalMediaTimelineClip } from '../domain/local-media-tools'

export const compositionFps = 30
export const compositionInputLimits = ['-threads', '2', '-max_pixels', '33554432']
const sampleRate = 48000
const samplesPerFrame = sampleRate / compositionFps
const frames = (seconds: number) => Math.round(seconds * compositionFps)
const seconds = (count: number) => count / compositionFps
const time = (count: number) => seconds(count).toFixed(6)
export const compositionLoudness = 'loudnorm=I=-16:TP=-1.5:LRA=11'

interface Source {
  name: string
  video?: { index: number; duration?: number; width?: number; height?: number }
  audio?: { index: number }
  duration?: number
}
type ResolvedClip = { frames: number; videoIndex: number; name: string } & (Extract<LocalMediaTimelineClip, { kind: 'image' }> |
  (Extract<LocalMediaTimelineClip, { kind: 'video' }> & {
    start: number; end: number; audioIndex?: number; speed: number; playbackFrames: number; freezeFrames: number
  }))

export function compositionInputs(op: LocalMediaCompose) {
  return [...localMediaTimeline(op).map(clip => ({ id: clip.attachmentId, kind: clip.kind, role: 'clip' as const })),
    ...(op.music ? [{ id: op.music.attachmentId, kind: 'audio' as const, role: 'music' as const }] : []),
    ...(op.watermark ? [{ id: op.watermark.attachmentId, kind: 'image' as const, role: 'watermark' as const }] : []),
    ...(op.pip ? [{ id: op.pip.attachmentId, kind: 'video' as const, role: 'pip' as const }] : [])]
}

export function resolveComposition(op: LocalMediaCompose, sources: readonly Source[]) {
  const resolution = op.resolution ?? 720
  const aspect = op.aspect ?? '16:9'
  const long = resolution * 16 / 9
  const [width, height] = aspect === '1:1' ? [resolution, resolution] : aspect === '9:16' ? [resolution, long] : [long, resolution]
  const timeline = localMediaTimeline(op)
  if (timeline.length > localMediaMaxClips) throw new Error('合成最多支持 8 个片段，含片头和片尾。')
  if (op.transitions && op.transitions.length !== timeline.length - 1) throw new Error('转场数量必须等于片段数减一，片头和片尾也算片段。')
  const overlaps = timeline.slice(1).map((_, i) => {
    const value = op.transitions?.[i]
    return typeof value === 'number' ? frames(value) : 0
  })
  const clips = timeline.map((clip, i): ResolvedClip => {
    const { name, video, audio, duration } = sources[i]
    if (!video?.width || !video.height) throw new Error(`第 ${i + 1} 个片段没有可处理的画面。`)
    const base = { name, videoIndex: video.index }
    if (clip.kind === 'image') return { ...base, ...clip, frames: frames(clip.duration) }
    const limit = video.duration ?? duration ?? 0
    const start = clip.start ?? 0
    const requestedEnd = clip.end ?? limit
    const end = Math.min(requestedEnd, limit)
    const speed = clip.speed ?? 1
    const playbackFrames = frames((end - start) / speed)
    const freezeFrames = frames(clip.freeze ?? 0)
    if (requestedEnd > limit + 0.001 || end <= start || playbackFrames < 1) throw new Error(`第 ${i + 1} 个视频片段的裁剪范围无效或超过素材时长。`)
    return { ...base, ...clip, start, end, speed, playbackFrames, freezeFrames, frames: playbackFrames + freezeFrames, audioIndex: audio?.index }
  })
  for (const [i, clip] of clips.entries()) {
    if ((overlaps[i - 1] ?? 0) + (overlaps[i] ?? 0) >= clip.frames) throw new Error(`第 ${i + 1} 个片段太短，请缩短相邻转场。`)
  }
  const total = clips.reduce((n, clip) => n + clip.frames, 0) - overlaps.reduce((n, overlap) => n + overlap, 0)
  const fadeIn = frames(op.fadeIn ?? 0)
  const fadeOut = frames(op.fadeOut ?? 0)
  if (fadeIn + fadeOut >= total) throw new Error('片头和片尾淡化过长，请缩短淡化时长。')
  let inputIndex = clips.length
  const musicInput = inputIndex
  const musicSource = op.music ? sources[inputIndex++] : undefined
  if (op.music && !musicSource?.audio) throw new Error('所选配乐没有可处理的音轨。')
  const music = op.music && musicSource?.audio ? { name: musicSource.name, input: musicInput, index: musicSource.audio.index, volume: op.music.volume ?? 0.2 } : undefined
  const audio = { denoise: op.audio?.denoise === true, normalize: op.audio?.normalize === true, duckMusic: op.audio?.duckMusic === true }
  const hasVoiceTrack = clips.some(clip => clip.kind === 'video' && clip.audioIndex !== undefined && clip.volume !== 0)
  if ((audio.denoise || audio.duckMusic) && !hasVoiceTrack) throw new Error('人声降噪或自动压低配乐需要至少一个保留原声的片段。')
  if (audio.duckMusic && (!music || music.volume === 0)) throw new Error('自动压低配乐需要启用配乐。')
  if (audio.normalize && !hasVoiceTrack && !music?.volume) throw new Error('响度统一需要可处理的音轨。')
  const overlaySource = (input: number) => {
    const asset = sources[input]
    if (!asset?.video?.width || !asset.video.height) throw new Error('叠加素材没有可处理的画面。')
    return { input, index: asset.video.index, name: asset.name, limit: asset.video.duration ?? asset.duration ?? 0 }
  }
  const watermark = op.watermark ? { ...overlaySource(inputIndex++), position: op.watermark.position ?? 'top-right',
    size: op.watermark.size ?? 0.18, opacity: op.watermark.opacity ?? 1 } : undefined
  const pip = op.pip ? { ...overlaySource(inputIndex), position: op.pip.position ?? 'bottom-right',
    size: op.pip.size ?? 0.3, atFrame: frames(op.pip.at ?? 0), start: op.pip.start ?? 0, end: op.pip.end } : undefined
  const pictureInPicture = pip && { ...pip, end: Math.min(pip.end ?? pip.limit, pip.limit),
    frames: frames(Math.min(pip.end ?? pip.limit, pip.limit) - pip.start) }
  if (pictureInPicture && ((pip?.end ?? 0) > pictureInPicture.limit + 0.001 || pictureInPicture.frames < 1 ||
    pictureInPicture.atFrame + pictureInPicture.frames > total)) {
    throw new Error('画中画片段超出原素材或成片时长，请调整起止时间。')
  }
  const summary = { aspect, resolution, durationSeconds: seconds(total),
    clips: clips.map((clip, i) => ({ name: clip.name, durationSeconds: seconds(clip.frames),
      ...(i === 0 && op.intro ? { role: 'intro' } : i === clips.length - 1 && op.outro ? { role: 'outro' } : {}),
      crops: clip.fit === 'crop' || clip.kind === 'image' && !!clip.motion && clip.motion !== 'still', rotation: clip.rotation,
      ...(clip.kind === 'video' ? { start: clip.start, end: clip.end, volume: clip.audioIndex === undefined ? 0 : clip.volume ?? 1,
        ...(clip.speed !== 1 ? { speed: clip.speed } : {}), ...(clip.freezeFrames ? { freeze: seconds(clip.freezeFrames) } : {}) } : { motion: clip.motion }) })),
    transitions: overlaps.map(seconds), fadeIn: seconds(fadeIn), fadeOut: seconds(fadeOut),
    ...(music ? { music: { name: music.name, volume: music.volume } } : {}),
    ...(watermark ? { watermark: { name: watermark.name, position: watermark.position, size: watermark.size, opacity: watermark.opacity } } : {}),
    ...(pictureInPicture ? { pip: { name: pictureInPicture.name, position: pictureInPicture.position, size: pictureInPicture.size,
      at: seconds(pictureInPicture.atFrame), start: pictureInPicture.start, end: pictureInPicture.end } } : {}),
    ...(audio.denoise || audio.normalize || audio.duckMusic ? { audio } : {}),
  }
  return { clips, width, height, total, overlaps, fadeIn, fadeOut, music, audio, watermark, pip: pictureInPicture, summary }
}

type Composition = ReturnType<typeof resolveComposition>

export function compositionFilters({ clips, width, height, total, overlaps, fadeIn, fadeOut, music, audio: effects, watermark, pip }: Composition): string {
  const crop = (w: number, h: number) => `crop=w='min(iw,max(1,ih*${w}/${h}/if(gt(sar,0),sar,1)))':` +
    `h='min(ih,max(1,iw*if(gt(sar,0),sar,1)*${h}/${w}))':exact=1,scale=${w}:${h},setsar=1`
  const pad = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
  const videoClock = `settb=1/${compositionFps},setpts=N`
  const audioFormat = `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo`
  const filters: string[] = []
  for (const [i, clip] of clips.entries()) {
    const rotation = clip.rotation === 90 ? 'transpose=clock,' : clip.rotation === 180 ? 'hflip,vflip,' : clip.rotation === 270 ? 'transpose=cclock,' : ''
    const fit = clip.fit === 'crop' ? crop(width, height) : pad
    let picture: string
    if (clip.kind === 'video') {
      picture = `trim=start=${clip.start}:end=${clip.end},setpts=(PTS-${clip.start}/TB)/${clip.speed},${rotation}${fit},` +
        `fps=${compositionFps}:start_time=0,tpad=stop_mode=clone:stop=${clip.frames},trim=end_frame=${clip.playbackFrames}` +
        (clip.freezeFrames ? `,tpad=stop_mode=clone:stop=${clip.freezeFrames}` : '')
    } else {
      const motion = clip.motion ?? 'still'
      const progress = `on/${Math.max(1, clip.frames - 1)}`
      const zoom = motion === 'still' ? '1' : motion === 'zoom-in' ? `1+0.2*${progress}` : '1.25'
      const center = 'iw/2-iw/zoom/2'
      // Crop to the canvas ratio first, then animate on a larger grid to reduce pixel stepping.
      const frame = motion === 'still' ? fit : crop(width * 2, height * 2)
      const x = motion === 'pan-left' ? `(iw-iw/zoom)*(1-${progress})` : motion === 'pan-right' ? `(iw-iw/zoom)*${progress}` : center
      picture = `${rotation}${frame},zoompan=z='${zoom}':x='${x}':y='ih/2-ih/zoom/2':d=${clip.frames}:s=${width}x${height}:fps=${compositionFps},trim=end_frame=${clip.frames}`
    }
    filters.push(`[${i}:${clip.videoIndex}]${picture},setsar=1,format=yuv420p,${videoClock}[v${i}]`)
    const samples = clip.frames * samplesPerFrame
    const firstSample = clip.kind === 'video' ? Math.round(clip.start * sampleRate) : 0
    const sound = clip.kind === 'video' && clip.audioIndex !== undefined && clip.volume !== 0
      ? `[${i}:${clip.audioIndex}]aresample=${sampleRate}:async=1:first_pts=0,${audioFormat},` +
        `atrim=start_sample=${firstSample}:end_sample=${Math.round(clip.end * sampleRate)},asetpts=N/SR/TB,` +
        `${effects.denoise ? 'afftdn=nr=12:nf=-45:tn=1,' : ''}${clip.speed !== 1 ? `atempo=${clip.speed},` : ''}` +
        `atrim=end_sample=${clip.playbackFrames * samplesPerFrame},volume=${clip.volume ?? 1}`
      : `anullsrc=r=${sampleRate}:cl=stereo`
    filters.push(`${sound},${audioFormat},apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[a${i}]`)
  }
  let video = 'v0'
  let audio = 'a0'
  let elapsed = clips[0].frames
  for (let i = 1; i < clips.length; i++) {
    const overlap = overlaps[i - 1]
    if (overlap) {
      filters.push(`[${video}][v${i}]xfade=transition=fade:duration=${time(overlap)}:offset=${time(elapsed - overlap)},format=yuv420p,${videoClock}[vjoin${i}]`)
      filters.push(`[${audio}][a${i}]acrossfade=ns=${overlap * samplesPerFrame},asetpts=N/SR/TB[ajoin${i}]`)
    } else {
      filters.push(`[${video}][${audio}][v${i}][a${i}]concat=n=2:v=1:a=1[vcat${i}][ajoin${i}]`)
      filters.push(`[vcat${i}]${videoClock}[vjoin${i}]`)
    }
    video = `vjoin${i}`
    audio = `ajoin${i}`
    elapsed += clips[i].frames - overlap
  }
  if (music) {
    filters.push(`[${music.input}:${music.index}]aresample=${sampleRate}:async=1:first_pts=0,${audioFormat},volume=${music.volume},` +
      `apad=whole_len=${total * samplesPerFrame},atrim=end_sample=${total * samplesPerFrame},asetpts=N/SR/TB[bed]`)
    if (effects.duckMusic) {
      filters.push(`[${audio}]asplit[voice][key]`, '[bed][key]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=350:detection=rms[ducked]')
    }
    filters.push(`${effects.duckMusic ? '[voice][ducked]' : `[${audio}][bed]`}amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]`)
    audio = 'mix'
  }
  const overlayScale = (size: number) => `scale=${Math.floor(width * size / 2) * 2}:${Math.floor(height * size / 2) * 2}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`
  const place = (position: string) => {
    const margin = Math.round(Math.min(width, height) * 0.03)
    return `x=${position.endsWith('left') ? margin : `W-w-${margin}`}:y=${position.startsWith('top') ? margin : `H-h-${margin}`}`
  }
  if (pip) {
    filters.push(`[${pip.input}:${pip.index}]trim=start=${pip.start}:end=${pip.end},setpts=PTS-${pip.start}/TB,` +
      `fps=${compositionFps}:start_time=0,${overlayScale(pip.size)},tpad=stop_mode=clone:stop=${pip.frames},` +
      `trim=end_frame=${pip.frames},${videoClock}+${pip.atFrame}[pip]`)
    filters.push(`[${video}][pip]overlay=${place(pip.position)}:eof_action=pass:repeatlast=0[withpip]`)
    video = 'withpip'
  }
  if (watermark) {
    filters.push(`[${watermark.input}:${watermark.index}]trim=end_frame=1,setpts=PTS-STARTPTS,${overlayScale(watermark.size)},` +
      `format=rgba,colorchannelmixer=aa=${watermark.opacity},format=yuva420p[logo]`)
    filters.push(`[${video}][logo]overlay=${place(watermark.position)}[branded]`)
    video = 'branded'
  }
  const vf = [fadeIn && `fade=t=in:s=0:n=${fadeIn}`, fadeOut && `fade=t=out:s=${total - fadeOut}:n=${Math.max(1, fadeOut - 1)}`].filter(Boolean)
  const af = [fadeIn && `afade=t=in:ss=0:ns=${fadeIn * samplesPerFrame}`,
    fadeOut && `afade=t=out:ss=${(total - fadeOut) * samplesPerFrame}:ns=${fadeOut * samplesPerFrame}`].filter(Boolean)
  filters.push(`[${video}]${[...vf, 'format=nv12'].join(',')}[vout]`)
  const samples = total * samplesPerFrame
  filters.push(`[${audio}]${[...af, ...(effects.normalize ? [compositionLoudness, `aresample=${sampleRate}`, `apad=whole_len=${samples}`] : []),
    `atrim=end_sample=${samples}`, 'asetpts=N/SR/TB'].join(',')}[aout]`)
  return filters.join(';')
}
