import { z } from 'zod'
import { videoRuntimeSchema } from '../../../src/shared/video-media'
import type { VideoRuntime } from '../../../src/shared/video-media'

function freezeVideoRuntime(video: VideoRuntime): VideoRuntime {
  function freeze(value: unknown): void {
    if (value === null || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(video)
  return video
}

/** Strict shared v1/v2 validation, with every nested capability frozen for queued runs. */
export const videoRuntimeSnapshotSchema = videoRuntimeSchema.transform(freezeVideoRuntime)

/** Video negotiation is optional; unsupported or private fragments must not disable chat. */
export const optionalVideoRuntimeSchema = z.unknown().transform(value => {
  const result = videoRuntimeSnapshotSchema.safeParse(value)
  return result.success ? result.data : undefined
})
