import type { MediaCapabilities } from '../../src/shared/media'
import { videoRuntimeSchema } from '../../src/shared/video-media'
import type { ArrangementNode } from './arrangement-plan'

export interface ArrangementMediaToolAvailability {
  state: 'available' | 'unavailable' | 'unknown'
  reason: 'authorized-runtime' | 'not-authorized' | 'runtime-unavailable' | 'host-unavailable' | 'runtime-not-checked'
}
export type ArrangementMediaTools = Record<'media_generate_image' | 'video_generate' | 'video_from_image', ArrangementMediaToolAvailability>

export function unknownArrangementMediaTools(): ArrangementMediaTools {
  return Object.fromEntries(['media_generate_image', 'video_generate', 'video_from_image'].map(name =>
    [name, { state: 'unknown', reason: 'runtime-not-checked' }])) as ArrangementMediaTools
}

export function requiredArrangementMediaTools(node: Pick<ArrangementNode, 'mediaRequirements' | 'deliverables'>): Array<keyof ArrangementMediaTools> {
  const requirements = (node.mediaRequirements ?? []).filter(requirement => requirement.required !== false)
  const artifacts = (node.deliverables ?? [])
    .map(deliverable => deliverable.artifact)
    .filter((artifact): artifact is NonNullable<NonNullable<ArrangementNode['deliverables']>[number]['artifact']> => artifact?.source === 'media-output')
  return [...new Set([
    ...requirements.map(requirement => requirement.kind === 'image'
      ? 'media_generate_image' as const
      : requirement.operation === 'image-to-video' ? 'video_from_image' as const : 'video_generate' as const),
    ...artifacts.map(artifact => artifact.kind === 'image'
      ? 'media_generate_image' as const
      : artifact.operation === 'image-to-video' ? 'video_from_image' as const : 'video_generate' as const),
  ])]
}

/** Safe summary only: no profiles, URLs, tokens, manifests or skill installation. */
export function summarizeArrangementMediaTools(input: {
  authorized: boolean
  image?: MediaCapabilities | null
  imageHost: boolean
  video?: unknown
  videoHostMode?: 'mock' | 'real'
}): ArrangementMediaTools {
  const result = unknownArrangementMediaTools()
  const unavailable = (reason: ArrangementMediaToolAvailability['reason']): ArrangementMediaToolAvailability => ({ state: 'unavailable', reason })
  if (!input.authorized) return { media_generate_image: unavailable('not-authorized'), video_generate: unavailable('not-authorized'), video_from_image: unavailable('not-authorized') }
  result.media_generate_image = !input.imageHost ? unavailable('host-unavailable') :
    input.image?.tools.includes('media_generate_image') && input.image.profiles.some(profile => profile.operations.length > 0)
      ? { state: 'available', reason: 'authorized-runtime' } : unavailable('runtime-unavailable')
  const video = videoRuntimeSchema.safeParse(input.video)
  for (const name of ['video_generate', 'video_from_image'] as const) {
    result[name] = !input.videoHostMode ? unavailable('host-unavailable') :
      video.success && video.data.executionAvailable && (video.data.executionMode ?? 'mock') === input.videoHostMode && video.data.tools.includes(name)
        ? { state: 'available', reason: 'authorized-runtime' } : unavailable('runtime-unavailable')
  }
  return result
}
