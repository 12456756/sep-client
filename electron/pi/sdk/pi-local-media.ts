import { Type } from 'typebox'
import { LOCAL_MEDIA_TOOL, localMediaCanvases, localMediaFits, localMediaMaxClips, localMediaMotions, localMediaPhotoSeconds, localMediaResolutions, localMediaRotations, type LocalMediaTool } from '../../domain/local-media-tools'
import type { PiToolDefinition } from './pi-coding-agent-adapter'

export function localMediaTool(host: LocalMediaTool): PiToolDefinition {
  const id = Type.String({ minLength: 1, maxLength: 128 })
  const timestamp = Type.Number({ minimum: 0, maximum: 86400 })
  const gain = Type.Number({ minimum: 0, maximum: 1 })
  const fade = Type.Number({ minimum: 0.1, maximum: 5 })
  const framing = { fit: Type.Optional(Type.Union(localMediaFits.map(fit => Type.Literal(fit)))),
    rotation: Type.Optional(Type.Union(localMediaRotations.map(angle => Type.Literal(angle)))) }
  return {
    name: LOCAL_MEDIA_TOOL,
    label: '本地音视频处理',
    description: 'Local conversation media. Use list to find attachment IDs, including earlier uploads; never fetch image bytes again just to edit. compose creates one MP4 from ordered clips: image (JPG/PNG/WebP) requires duration and can use still/zoom-in/pan-left/pan-right; video can specify start/end (seconds from source start), and volume 0–1 (default 1, 0=mute original audio). Repeat a video ID with different ranges to keep multiple parts or omit unwanted sections. Each clip accepts clockwise rotation and fit pad/crop; photo motion always crops. Output aspect defaults to 16:9, resolution to 720; 1080 is optional. transitions is omitted for hard cuts, or has one entry per gap: cut or crossfade duration in seconds. fadeIn/fadeOut apply to the entire result. music is a local audio attachment with optional volume (default 0.2); it starts at zero, does not loop. compose with dryRun:true checks sources and returns the plan without writing; omit dryRun for confirmed rendering. join directly joins compatible MP4s using attachmentIds. probe, trim, extract_audio and transcode use attachmentId; trim requires start/end. Never invent IDs or pass paths. Writing needs approval. Report only the verified result. No captions or transcription.',
    parameters: Type.Object({
      operation: Type.Union([Type.Literal('list'), Type.Literal('probe'), Type.Literal('trim'), Type.Literal('join'), Type.Literal('compose'), Type.Literal('extract_audio'), Type.Literal('transcode')]),
      attachmentId: Type.Optional(id),
      attachmentIds: Type.Optional(Type.Array(id, { minItems: 2, maxItems: localMediaMaxClips })),
      clips: Type.Optional(Type.Array(Type.Union([
        Type.Object({ kind: Type.Literal('image'), attachmentId: id,
          ...framing,
          duration: Type.Number({ minimum: localMediaPhotoSeconds.min, maximum: localMediaPhotoSeconds.max }),
          motion: Type.Optional(Type.Union(localMediaMotions.map(motion => Type.Literal(motion)))),
        }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal('video'), attachmentId: id, ...framing,
          start: Type.Optional(timestamp), end: Type.Optional(timestamp), volume: Type.Optional(gain),
        }, { additionalProperties: false }),
      ]), { minItems: 1, maxItems: localMediaMaxClips })),
      aspect: Type.Optional(Type.Union(localMediaCanvases.map(aspect => Type.Literal(aspect)))),
      resolution: Type.Optional(Type.Union(localMediaResolutions.map(resolution => Type.Literal(resolution)))),
      transitions: Type.Optional(Type.Array(Type.Union([Type.Literal('cut'), fade]), { maxItems: localMediaMaxClips - 1 })),
      fadeIn: Type.Optional(fade), fadeOut: Type.Optional(fade),
      music: Type.Optional(Type.Object({ attachmentId: id, volume: Type.Optional(gain) }, { additionalProperties: false })),
      dryRun: Type.Optional(Type.Boolean()),
      start: Type.Optional(timestamp), end: Type.Optional(timestamp),
    }, { additionalProperties: false }),
    async execute(_id, input, signal, onUpdate) {
      return { content: [{ type: 'text', text: JSON.stringify(await host.execute(input, signal, progress =>
        onUpdate?.({ content: [], details: { localMediaProgress: progress } }))) }], details: {} }
    },
  }
}
