import { Type } from 'typebox'
import { LOCAL_MEDIA_TOOL, localMediaAnalysisModes, localMediaAudioFormats, localMediaCanvases, localMediaCorners, localMediaExportDimensions, localMediaFits,
  localMediaFreezeMax, localMediaMaxBytes, localMediaMaxClips, localMediaMotions, localMediaOverlaySize, localMediaPhotoSeconds, localMediaResolutions,
  localMediaRotations, localMediaSpeed, type LocalMediaTool } from '../../domain/local-media-tools'
import type { PiToolDefinition } from './pi-coding-agent-adapter'

export function localMediaTool(host: LocalMediaTool): PiToolDefinition {
  const id = Type.String({ minLength: 1, maxLength: 128 })
  const timestamp = Type.Number({ minimum: 0, maximum: 86400 })
  const gain = Type.Number({ minimum: 0, maximum: 1 })
  const fade = Type.Number({ minimum: 0.1, maximum: 5 })
  const framing = { fit: Type.Optional(Type.Union(localMediaFits.map(fit => Type.Literal(fit)))),
    rotation: Type.Optional(Type.Union(localMediaRotations.map(angle => Type.Literal(angle)))) }
  const clip = Type.Union([
    Type.Object({ kind: Type.Literal('image'), attachmentId: id, ...framing,
      duration: Type.Number({ minimum: localMediaPhotoSeconds.min, maximum: localMediaPhotoSeconds.max }),
      motion: Type.Optional(Type.Union(localMediaMotions.map(motion => Type.Literal(motion)))),
    }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('video'), attachmentId: id, ...framing,
      start: Type.Optional(timestamp), end: Type.Optional(timestamp), volume: Type.Optional(gain),
      speed: Type.Optional(Type.Number({ minimum: localMediaSpeed.min, maximum: localMediaSpeed.max })),
      freeze: Type.Optional(Type.Number({ minimum: 0.1, maximum: localMediaFreezeMax })),
    }, { additionalProperties: false }),
  ])
  const overlay = { attachmentId: id, position: Type.Optional(Type.Union(localMediaCorners.map(value => Type.Literal(value)))),
    size: Type.Optional(Type.Number({ minimum: localMediaOverlaySize.min, maximum: localMediaOverlaySize.max })) }
  return {
    name: LOCAL_MEDIA_TOOL,
    label: '本地音视频处理',
    description: 'Local conversation media. Use list to find attachment IDs; do not fetch image bytes again to edit. compose creates one MP4 from ordered clips, including optional intro/outro attachments, up to 8 total. Images (JPG/PNG/WebP) need duration and support still/zoom-in/pan-left/pan-right. Video clips accept source start/end, volume 0–1, speed 0.5–2, and freeze (silent hold of the last frame after playback). Repeat a video ID with different ranges to keep multiple parts. Clips accept clockwise rotation and fit pad/crop. Output defaults to 16:9 and 720p. Omit transitions for hard cuts, or pass one cut or crossfade in seconds per gap including intro/outro. fadeIn/fadeOut apply to the result. watermark is a still image, optionally positioned with fractional size and opacity. pip is a silent video inset with source start/end and at in output seconds; it must fit the output timeline. music is a local audio attachment with volume (default 0.2), without looping. audio optionally enables denoise on retained source sound, normalize toward -16 LUFS, and duckMusic when retained source sound is active. Report measured loudness if available. compose dryRun:true returns a plan without writing. analyze returns candidate silence ranges and scene cuts with mode silence/scenes/both and never edits. Present candidates and ask which to use before editing from them. join directly joins compatible MP4s. transcode makes H.264 MP4; batch_transcode uses 1–8 attachmentIds and returns per-item results. Both accept maxBytes and maxDimension. probe checks duration, bitrate, picture and audio tracks. extract_audio exports the first audio track as m4a/MP3/WAV using lowercase format. frame makes a PNG at optional at; thumbnail_grid makes a 3×3 PNG; gif makes a silent looping GIF (0.25–15 s). All times are seconds; trim and gif require start/end. Except list, compose, join and batch_transcode, use attachmentId. Never invent IDs or pass paths. Writing requires approval. Link only verified results. ' +
      'subtitle recognizes the first audio track of one attachment (up to 60 minutes) locally and saves an editable UTF-8 SRT. No burning into video or translation. Remind the user to review the text and timing before use. Do not read or send the generated subtitle text unless the user asks.',
    parameters: Type.Object({
      operation: Type.Union(['list', 'probe', 'analyze', 'subtitle', 'trim', 'join', 'compose', 'extract_audio', 'transcode', 'batch_transcode', 'frame', 'thumbnail_grid', 'gif'].map(value => Type.Literal(value))),
      mode: Type.Optional(Type.Union(localMediaAnalysisModes.map(value => Type.Literal(value)))),
      attachmentId: Type.Optional(id),
      attachmentIds: Type.Optional(Type.Array(id, { minItems: 1, maxItems: localMediaMaxClips })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: localMediaMaxBytes })),
      maxDimension: Type.Optional(Type.Union(localMediaExportDimensions.map(value => Type.Literal(value)))),
      format: Type.Optional(Type.Union(localMediaAudioFormats.map(value => Type.Literal(value)))),
      at: Type.Optional(timestamp),
      clips: Type.Optional(Type.Array(clip, { minItems: 1, maxItems: localMediaMaxClips })),
      intro: Type.Optional(clip), outro: Type.Optional(clip),
      watermark: Type.Optional(Type.Object({ ...overlay, opacity: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1 })) }, { additionalProperties: false })),
      pip: Type.Optional(Type.Object({ ...overlay, at: Type.Optional(timestamp), start: Type.Optional(timestamp), end: Type.Optional(timestamp) }, { additionalProperties: false })),
      audio: Type.Optional(Type.Object({ denoise: Type.Optional(Type.Boolean()), normalize: Type.Optional(Type.Boolean()), duckMusic: Type.Optional(Type.Boolean()) },
        { additionalProperties: false })),
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
